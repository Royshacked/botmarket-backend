import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSetup, setupReadiness, legPrice, firingLeg, pendingLegs } from '../../services/setup.schema.js'
import { legText } from '../../monitoring/assess.shared.js'
import { tierFor } from '../../monitoring/talos.tiers.js'
import { _isTimeExit } from '../../monitoring/talos.monitor.service.js'

// Phase 7: an entry that is not a price. "We are not bound to prices" (mentor-flow-intent #7) —
// Mentor authors what actually moves the ticker, Talos watches what Mentor said, and a fulfilled
// trigger asks the user to confirm AT MARKET.

const TRIGGER_SETUP = normalizeSetup({
    asset: 'NVDA', direction: 'long', type: 'swing', trade_mode: 'discretionary', timeframe: '1hr',
    conditions: [{ text: 'SMH still leading', weight: 'confirming', mode: 'judgment' }],
    scenarios: [{
        id: 's1',
        trade_id: 't1',
        entry_legs:  [{ trigger: 'RSI back above 30 on the 15m', timeframe: '15min', quantity: 100 }],
        stop_legs:   [{ price: 196 }],
        target_legs: [{ price: 214, quantity: 100 }],
    }],
})

// ─── The shape ────────────────────────────────────────────────────────────────

test('an entry leg may be a trigger instead of a price', () => {
    const leg = TRIGGER_SETUP.scenarios[0].entry_legs[0]
    assert.equal(leg.price, null)
    assert.equal(leg.trigger, 'RSI back above 30 on the 15m')
    assert.equal(leg.timeframe, '15min')
    assert.equal(legPrice(leg), null, 'and it still has no price, so nothing rests at a broker')
})

test('a STOP or a TARGET may not — those are orders, and an order needs a number', () => {
    const out = normalizeSetup({
        ...TRIGGER_SETUP,
        scenarios: [{
            id: 's1',
            entry_legs:  [{ trigger: 'RSI back above 30', quantity: 100 }],
            stop_legs:   [{ trigger: 'when it stops working' }],
            target_legs: [{ trigger: 'when it has run enough' }],
        }],
    })
    assert.deepEqual(out.scenarios[0].stop_legs, [])
    assert.deepEqual(out.scenarios[0].target_legs, [])
})

test('a leg with neither a price nor a trigger is not a leg', () => {
    const out = normalizeSetup({
        ...TRIGGER_SETUP,
        scenarios: [{ id: 's1', entry_legs: [{ quantity: 100 }, { trigger: 'ok', quantity: 50 }], stop_legs: [{ price: 196 }] }],
    })
    assert.equal(out.scenarios[0].entry_legs.length, 1)
})

test('an unknown rung on a trigger is dropped rather than passed on', () => {
    const out = normalizeSetup({
        ...TRIGGER_SETUP,
        scenarios: [{ id: 's1', entry_legs: [{ trigger: 'RSI', timeframe: 'whenever' }], stop_legs: [{ price: 196 }] }],
    })
    assert.equal('timeframe' in out.scenarios[0].entry_legs[0], false)
})

test('a trigger entry can never be a LIMIT setup — a limit order rests at a price', () => {
    const forced = normalizeSetup({ ...TRIGGER_SETUP, entry_mode: 'limit' })
    assert.equal(forced.entry_mode, 'conditional')

    const priced = normalizeSetup({
        ...TRIGGER_SETUP, entry_mode: 'limit',
        scenarios: [{ id: 's1', entry_legs: [{ price: 200, quantity: 100 }], stop_legs: [{ price: 196 }], target_legs: [{ price: 214, quantity: 100 }] }],
    })
    assert.equal(priced.entry_mode, 'limit', 'a priced one still can be')
})

test('the trade grouping travels, and changes nothing about execution', () => {
    assert.equal(TRIGGER_SETUP.scenarios[0].trade_id, 't1')
})

// ─── It is a finished setup ───────────────────────────────────────────────────

test('a trigger entry does not read as a MISSING entry price', () => {
    const { missing } = setupReadiness(TRIGGER_SETUP, true)
    assert.equal(missing.includes('entry price'), false)
    assert.deepEqual(missing, [], 'nothing else is missing either')
})

// ─── Talos can see it ─────────────────────────────────────────────────────────

test('the trigger reaches the read that judges it — the bug that would have made it invisible', () => {
    const text = legText(TRIGGER_SETUP.scenarios[0].entry_legs[0])
    assert.match(text, /ON TRIGGER: RSI back above 30 on the 15m/)
    assert.match(text, /read on the 15min/)
    assert.match(text, /the entry is AT MARKET/)
})

test('a leg with no price and no trigger still renders nothing', () => {
    assert.equal(legText({ id: 'x' }), null)
    assert.equal(legText({ id: 'x', trigger: '   ' }), null)
})

test('an enter verdict fires on the trigger leg, with no price to resolve', () => {
    const sc = TRIGGER_SETUP.scenarios[0]
    assert.equal(pendingLegs(sc, null).length, 1)
    assert.equal(firingLeg(sc, null)?.id, sc.entry_legs[0].id)
})

// ─── The clock exit ───────────────────────────────────────────────────────────

test('time_exit closes a position that filled; valid_until retires one that never did', () => {
    const at = '2026-10-01T19:45:00Z'
    const nowAfter  = Date.parse('2026-10-01T19:46:00Z')
    const nowBefore = Date.parse('2026-10-01T19:44:00Z')

    assert.equal(_isTimeExit({ time_exit: at, status: 'long' }, nowAfter), true)
    assert.equal(_isTimeExit({ time_exit: at, status: 'short' }, nowAfter), true)
    assert.equal(_isTimeExit({ time_exit: at, status: 'long' }, nowBefore), false)
    // Pre-entry there is nothing to close — that is what valid_until is for.
    assert.equal(_isTimeExit({ time_exit: at, status: 'waiting' }, nowAfter), false)
    assert.equal(_isTimeExit({ status: 'long' }, nowAfter), false)
    assert.equal(_isTimeExit({ time_exit: 'not a date', status: 'long' }, nowAfter), false)
})

test('a time_exit wake is never triaged away by the cheap tier', () => {
    // The one wake where sleeping through it costs the user exactly what they asked for.
    assert.equal(tierFor({ read_mode: 'cheap_only', monitor_state: { expensive_due: Date.now() + 1e6, watch: {} } }, { reason: 'time_exit' }), 'expensive')
    assert.equal(tierFor({ read_mode: 'cheap_only', monitor_state: { expensive_due: Date.now() + 1e6, watch: {} } }, { reason: 'candle' }), 'cheap')
})

test('the setup carries its clock exit through normalisation', () => {
    const withExit = normalizeSetup({ ...TRIGGER_SETUP, time_exit: '2026-10-01T19:45:00Z' })
    assert.equal(withExit.time_exit, '2026-10-01T19:45:00.000Z')
    assert.equal(normalizeSetup(TRIGGER_SETUP).time_exit, null)
})

// ─── The rough fill: sums without an order price ──────────────────────────────

import { legReference } from '../../services/setup.schema.js'
import { summarizeTrade, applySizing } from '../../services/mentorSummary.util.js'

const WITH_ABOUT = normalizeSetup({
    ...TRIGGER_SETUP,
    scenarios: [{
        id: 's1',
        entry_legs:  [{ trigger: 'RSI back above 30 on the 15m', timeframe: '15min', about: 200, quantity: 100 }],
        stop_legs:   [{ price: 196 }],
        target_legs: [{ price: 210, quantity: 100 }],
    }],
})

test('`about` measures the sums; it never becomes an order price', () => {
    const leg = WITH_ABOUT.scenarios[0].entry_legs[0]
    assert.equal(legPrice(leg), null, 'nothing rests at a broker')
    assert.equal(legReference(leg), 200, 'but the arithmetic has a number')
})

test('a trigger entry can be sized by RISK — the hole this closed', () => {
    const { quantities, problems } = applySizing(WITH_ABOUT, { unit: 'risk_cash', value: 500 }, { balance: 50000 })
    assert.deepEqual(problems, [])
    assert.equal(quantities[0].quantity, 125)

    // Without a rough fill there is nothing to measure risk from, and it says so.
    const bare = applySizing(TRIGGER_SETUP, { unit: 'risk_cash', value: 500 }, { balance: 50000 })
    assert.match(bare.problems[0], /entry and a stop that are different prices/)
})

test('everything derived from a rough fill is marked an ESTIMATE', () => {
    const s = summarizeTrade(WITH_ABOUT, { quantity: 125, balance: 50000 })
    assert.equal(s.estimated, true)
    assert.equal(s.lossCash, 500)
    assert.equal(s.gainCash, 1250)
    assert.equal(s.entry, 200)
})

test('a priced entry is never an estimate', () => {
    const priced = normalizeSetup({
        ...TRIGGER_SETUP,
        scenarios: [{ id: 's1', entry_legs: [{ price: 200, quantity: 100 }], stop_legs: [{ price: 196 }], target_legs: [{ price: 210, quantity: 100 }] }],
    })
    assert.equal(summarizeTrade(priced, { quantity: 100, balance: 50000 }).estimated, false)
})

test('a nonsense `about` is dropped like any other bad number', () => {
    const junk = normalizeSetup({
        ...TRIGGER_SETUP,
        scenarios: [{ id: 's1', entry_legs: [{ trigger: 'RSI', about: -5 }], stop_legs: [{ price: 196 }] }],
    })
    assert.equal('about' in junk.scenarios[0].entry_legs[0], false)
})
