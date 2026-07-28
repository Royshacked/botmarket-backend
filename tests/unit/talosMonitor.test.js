import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    zoneGate, zoneDistance, proximityGapMin, _isPreActive, _isExpiring, _nextCheckAt, _checkSetup,
    _nextStatus,
} from '../../monitoring/talos.monitor.service.js'
import { buildToolsFor, declaredKinds } from '../../monitoring/talos.assess.js'
import { statusesFor, AWAITING_CONFIRM } from '../../services/entity/vocabulary.js'

// Talos's gates. Everything here runs on EVERY wake for free — the expensive assessment only fires
// when these say so — so a wrong gate is either a missed entry or a wasted LLM call on every poll.

const SETUP = {
    id: 'setup_NVDA_1', kind: 'setup', asset: 'NVDA', asset_class: 'stock',
    direction: 'long', type: 'swing', trade_mode: 'classical', timeframe: '1hr',
    ladder: ['4hr', '2hr', '1hr', '30min', '15min'],
    cadence: { min: 30, max: 240 },
    status: 'looking',   // armed — the setup ladder's spelling, shared with calls
    entry_zones: [{ id: 'ez1', lower: 237.8, upper: 238.6, quantity: 100 }],
    stop_zones:  [{ id: 'sz1', lower: 234.8, upper: 235.9, quantity: 100 }],
    watch: [{ kind: 'structure', look_for: 'CHoCH up', timeframe: '15min', weight: 'primary' }],
    monitor_state: { next_check_at: null, check_count: 0, memo: null, timeline: [] },
}

// ─── Zone gate ────────────────────────────────────────────────────────────────

test('the gate trips inside the band and stays quiet outside it', () => {
    assert.equal(zoneGate(SETUP.entry_zones, 238.0).id, 'ez1')
    assert.equal(zoneGate(SETUP.entry_zones, 240.0), null)
    assert.equal(zoneGate(SETUP.entry_zones, 230.0), null)
})

test('both edges are inclusive, so a zero-width zone can still trip', () => {
    // An exact level the user named normalises to lower === upper; an exclusive test would mean
    // it could never fire.
    assert.ok(zoneGate([{ id: 'z', lower: 100, upper: 100 }], 100))
    assert.ok(zoneGate(SETUP.entry_zones, 237.8))
    assert.ok(zoneGate(SETUP.entry_zones, 238.6))
})

test('the first containing zone wins when several are armed', () => {
    const zones = [{ id: 'a', lower: 10, upper: 20 }, { id: 'b', lower: 15, upper: 25 }]
    assert.equal(zoneGate(zones, 18).id, 'a')
})

test('an unknown price never trips the gate', () => {
    // A failed quote must read as "don't know", never as "not in a zone, all clear".
    for (const p of [NaN, null, undefined, 'abc']) {
        assert.equal(zoneGate(SETUP.entry_zones, p), null, String(p))
    }
})

// ─── Proximity cadence ────────────────────────────────────────────────────────

test('distance is measured in zone widths, not absolute price', () => {
    // 0.8-wide zone; 238.6 → 239.4 is one full width away.
    assert.equal(zoneDistance(SETUP.entry_zones, 239.4).toFixed(2), '1.00')
    assert.equal(zoneDistance(SETUP.entry_zones, 238.0), 0, 'inside the zone = zero distance')
})

test('cadence tightens to the floor near a zone and relaxes to the ceiling far away', () => {
    assert.equal(proximityGapMin(SETUP, 238.0), 30,  'inside → min')
    assert.equal(proximityGapMin(SETUP, 239.0), 30,  'within a width → min')
    assert.equal(proximityGapMin(SETUP, 300.0), 240, 'miles away → max')
})

test('cadence is monotonic — approaching price never polls lazier', () => {
    const gaps = [300, 260, 245, 240, 238.7].map(p => proximityGapMin(SETUP, p))
    for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] <= gaps[i - 1], `${gaps}`)
})

test('an unknown price falls back to the lazy ceiling, not the floor', () => {
    // Polling flat-out on a broken price feed would burn quota for nothing.
    assert.equal(proximityGapMin(SETUP, NaN), 240)
    assert.equal(proximityGapMin({ ...SETUP, entry_zones: [] }, 238), 240)
})

// ─── Time gates ───────────────────────────────────────────────────────────────

const T = Date.parse('2026-07-26T12:00:00Z')

test('a future active_from means not live yet', () => {
    assert.equal(_isPreActive({ active_from: '2026-07-28T00:00:00Z' }, T), true)
    assert.equal(_isPreActive({ active_from: '2026-07-01T00:00:00Z' }, T), false)
    assert.equal(_isPreActive({ active_from: null }, T), false, 'no bound = already live')
})

test('expiry fires inside the review window and not before', () => {
    assert.equal(_isExpiring({ valid_until: '2026-07-26T12:10:00Z' }, T), true, '10m out → review')
    assert.equal(_isExpiring({ valid_until: '2026-07-26T14:00:00Z' }, T), false, '2h out → not yet')
    assert.equal(_isExpiring({ valid_until: '2026-07-26T11:00:00Z' }, T), true, 'already past → review')
})

test('a setup with no valid_until never expires', () => {
    assert.equal(_isExpiring({ valid_until: null }, T), false)
    assert.equal(_isExpiring({ valid_until: 'someday' }, T), false, 'an unparseable bound is not a live gate')
})

// ─── next_check_at clamping ───────────────────────────────────────────────────

test("the model's self-chosen cadence is clamped into the setup's band", () => {
    assert.equal(_nextCheckAt(SETUP, T, 1),    new Date(T + 30 * 60_000).toISOString(),  'too eager → floor')
    assert.equal(_nextCheckAt(SETUP, T, 9999), new Date(T + 240 * 60_000).toISOString(), 'too lazy → ceiling')
    assert.equal(_nextCheckAt(SETUP, T, 60),   new Date(T + 60 * 60_000).toISOString(),  'in band → honoured')
})

test('a missing or junk next_check_min falls back to the floor', () => {
    for (const v of [undefined, null, 'soon', NaN]) {
        assert.equal(_nextCheckAt(SETUP, T, v), new Date(T + 30 * 60_000).toISOString(), String(v))
    }
})

// ─── Tool mounting ────────────────────────────────────────────────────────────

const toolNames = (setup) => buildToolsFor(setup).map(t => t.name)

test('the chart is always available even when nothing is declared', () => {
    assert.deepEqual(toolNames({ ...SETUP, watch: [] }), ['get_chart'])
})

test('a structure factor mounts the numeric SMC engine and nothing else', () => {
    const names = toolNames(SETUP)
    assert.ok(names.includes('get_structure') && names.includes('get_fvg') && names.includes('get_liquidity'))
    assert.ok(!names.includes('get_short_interest'), 'undeclared positioning must not be mounted')
})

test('a price_action factor mounts the classical vision reads instead', () => {
    const names = toolNames({ ...SETUP, watch: [{ kind: 'price_action', look_for: 'bull flag', weight: 'primary' }] })
    assert.ok(names.includes('get_orderblocks') && names.includes('get_false_breaks'))
    assert.ok(!names.includes('get_structure'), 'the SMC engine is not mounted for a classical setup')
})

test('positioning mounts the crowding tools only when declared', () => {
    const names = toolNames({ ...SETUP, watch: [{ kind: 'positioning', look_for: 'squeeze intact', weight: 'primary' }] })
    assert.ok(names.includes('get_short_interest') && names.includes('get_options_context'))
})

test('a correlation or news factor adds no tools — those are fetched, not called', () => {
    // They arrive as prompt blocks; mounting a tool for them would let the model re-fetch at will.
    assert.deepEqual(toolNames({ ...SETUP, watch: [
        { kind: 'correlation', look_for: 'SMH leads', symbols: ['SMH'], weight: 'confirming' },
        { kind: 'news', look_for: 'no downgrade', weight: 'confirming' },
    ] }), ['get_chart'])
})

test('declaredKinds de-duplicates repeated factors', () => {
    const kinds = declaredKinds({ watch: [{ kind: 'news' }, { kind: 'news' }, { kind: 'market' }] })
    assert.deepEqual([...kinds].sort(), ['market', 'news'])
})

// ─── The check, end to end (no IO) ────────────────────────────────────────────

function stubDeps(over = {}) {
    return {
        isAssetOpen: () => true,
        nextOpenMs:  () => T + 3600_000,
        getPrice:    async () => 238.0,
        assess:      async () => ({ verdict: 'enter', read: 'Trigger is live.', next_check_min: 30 }),
        buildOrderPlan: async () => [{ accountId: 'a1', quantity: 100 }],
        onCard:       async () => {},
        onManualCard: async () => {},
        ...over,
    }
}

const LIVE = { ...SETUP, broker: 'ctrader', accounts: ['a1'], mainAccountId: 'a1', quantity: 100, valid_until: null }

test('a closed market skips the price fetch AND the assessment entirely', async () => {
    let fetched = false, assessed = false
    const res = await _checkSetup(LIVE, T, stubDeps({
        isAssetOpen: () => false,
        getPrice:    async () => { fetched = true; return 238 },
        assess:      async () => { assessed = true; return {} },
    }))
    assert.equal(res.reason, 'closed')
    assert.equal(fetched, false, 'a shut market must cost nothing')
    assert.equal(assessed, false)
})

test('price outside every zone reschedules without ever calling the model', async () => {
    let assessed = false
    const res = await _checkSetup(LIVE, T, stubDeps({
        getPrice: async () => 300,
        assess:   async () => { assessed = true; return {} },
    }))
    assert.equal(res.reason, 'scheduled')
    assert.equal(assessed, false, 'the cheap gate is the whole point')
})

// THE GATE. A zone trip buys an assessment, nothing more — only a fulfilled setup asks the user
// to act. Every non-enter verdict holds at 'looking' with no card.
for (const verdict of ['wait', 'stand_aside', 'edit']) {
    test(`a zone trip with verdict "${verdict}" does NOT ask the user to confirm — it watches`, async () => {
        let carded = false
        const res = await _checkSetup(LIVE, T, stubDeps({
            assess: async () => ({ verdict, read: 'Semis are diverging.', warning: 'SMH is red while NVDA taps the zone.' }),
            onCard: async () => { carded = true },
        }))
        assert.equal(carded, false, 'a setup Talos declined must not produce a confirm card')
        assert.equal(res.fired, undefined)
        assert.equal(res.watching, true)
        assert.equal(res.verdict, verdict)
    })
}

// One ladder, shared by every kind. Pinned as a set so re-spelling any rung fails here first,
// instead of silently at a gate that stops matching.
test('a setup runs the SAME ladder as every other kind — no private words', () => {
    for (const s of ['waiting', 'looking', 'hit', 'long', 'short', 'closed']) {
        assert.ok(statusesFor('setup').includes(s), `setup should allow '${s}'`)
        assert.ok(statusesFor('call').includes(s), `call should allow '${s}'`)
        assert.ok(statusesFor('idea').includes(s), `idea should allow '${s}'`)
    }
    // The synonyms this kind grew and shed. Each one broke a gate while it existed.
    for (const dead of ['unarmed', 'watching', 'ready']) {
        assert.ok(!statusesFor('setup').includes(dead), `setup must not speak '${dead}'`)
    }
})

test('_nextStatus walks the ladder: fulfilled → hit, otherwise → looking', () => {
    assert.equal(_nextStatus('enter', 'zone_trip'), 'hit')
    assert.equal(_nextStatus('wait', 'zone_trip'), 'looking')
    assert.equal(_nextStatus('stand_aside', 'zone_trip'), 'looking')
    assert.equal(_nextStatus('edit', 'zone_trip'), 'looking')
    // Price sitting inside a zone is armed_zone_id on a `looking` setup — being in a zone is a
    // detail of looking, not a lifecycle rung. It must never mint a status of its own again.
    for (const v of ['enter', 'wait', 'stand_aside', 'edit']) {
        for (const r of ['zone_trip', 'expiry_review']) {
            assert.notEqual(_nextStatus(v, r), 'watching')
        }
    }
})

// placeOrdersForIdea is kind-blind and used to gate on status === 'hit', which silently refused
// every setup confirm with reason 'not_hit'. The gate is now this shared set.
test("a fulfilled setup's status is placeable by the kind-blind execution path", () => {
    assert.ok(AWAITING_CONFIRM.includes(_nextStatus('enter', 'zone_trip')))
    assert.ok(AWAITING_CONFIRM.includes('hit'), 'an idea still reaches placement as hit')
})

test('price leaving the zone drops a watching setup back to armed, still without an LLM call', async () => {
    let assessed = false
    const res = await _checkSetup({ ...LIVE, status: 'looking' }, T, stubDeps({
        getPrice: async () => 300,                      // well outside every zone
        assess:   async () => { assessed = true; return {} },
    }))
    assert.equal(res.reason, 'scheduled')
    assert.equal(assessed, false, 'un-watching is arithmetic, not a read')
})

test('an enter verdict — the setup FULFILLED — is what fires the card', async () => {
    let carded = false
    const res = await _checkSetup(LIVE, T, stubDeps({ onCard: async () => { carded = true } }))
    assert.equal(carded, true)
    assert.equal(res.fired, true)
    assert.equal(res.verdict, 'enter')
})

test('the card names the tripped zone so the confirm dialog knows which one fired', async () => {
    let card = null
    await _checkSetup(LIVE, T, stubDeps({ onCard: async (_s, a) => { card = a } }))
    assert.equal(card.zone_id, 'ez1')
})

test('an enter verdict carries no warning', async () => {
    let card = null
    await _checkSetup(LIVE, T, stubDeps({ onCard: async (_s, a) => { card = a } }))
    assert.equal(card.warning, null)
})

test('an off-menu verdict is coerced to wait rather than acted on', async () => {
    const res = await _checkSetup(LIVE, T, stubDeps({
        assess: async () => ({ verdict: 'YOLO', read: 'send it' }),
    }))
    assert.equal(res.verdict, 'wait')
})

test('a failed assessment reschedules instead of firing a card', async () => {
    let carded = false
    const res = await _checkSetup(LIVE, T, stubDeps({
        assess: async () => ({ _failReason: 'truncated' }),
        onCard: async () => { carded = true },
    }))
    assert.equal(res.failed, true)
    assert.equal(carded, false)
})

test('a card that throws does not fail the check — the status change already persisted', async () => {
    const res = await _checkSetup(LIVE, T, stubDeps({
        onCard: async () => { throw new Error('social chat down') },
    }))
    assert.equal(res.fired, true)
})

test('a pre-active setup sleeps until it opens, with no price fetch', async () => {
    let fetched = false
    const res = await _checkSetup({ ...LIVE, active_from: '2026-07-28T00:00:00Z' }, T, stubDeps({
        getPrice: async () => { fetched = true; return 238 },
    }))
    assert.equal(res.reason, 'pre_active')
    assert.equal(fetched, false)
})

test('a setup with no trading venue costs nothing — no price fetch, no assessment', async () => {
    // Live positions never reach here at all (the poll query excludes them); this is the guard for
    // a setup whose broker vanished between the read and the check.
    let fetched = false, assessed = false
    const res = await _checkSetup({ ...LIVE, broker: null }, T, stubDeps({
        getPrice: async () => { fetched = true; return 238 },
        assess:   async () => { assessed = true; return {} },
    }))
    assert.equal(res.reason, 'no_venue')
    assert.equal(fetched, false)
    assert.equal(assessed, false)
})

// ─── The execution handoff ────────────────────────────────────────────────────

test('a trigger builds the order plan — a hit with no plan would dead-end at the dialog', async () => {
    let patched = null
    const res = await _checkSetup(LIVE, T, stubDeps({
        buildOrderPlan: async (s) => { patched = s.id; return [{ accountId: 'a1', quantity: 100 }] },
    }))
    assert.equal(res.fired, true)
    assert.equal(res.orderState, 'awaiting_confirm')
    assert.equal(patched, 'setup_NVDA_1', 'the plan is built from the setup itself')
})

test('a trigger while the market is closed parks the plan and stays silent', async () => {
    // The expiry path can reach a trigger out of hours; the plan is still built, but the card
    // waits for the open rather than asking for a confirm nobody can place.
    let carded = false
    const res = await _checkSetup({ ...LIVE, valid_until: '2026-07-26T12:05:00Z' }, T, stubDeps({
        isAssetOpen: () => false,
        assess:      async () => ({ verdict: 'enter', read: 'Zone tagged.' }),
        onCard:      async () => { carded = true },
    }))
    assert.equal(res.orderState, 'awaiting_market')
    assert.equal(carded, false, 'awaiting_market defers silently')
})

test('a manual setup gets the fill card, not an order plan', async () => {
    let planned = false, manualCard = false, confirmCard = false
    const res = await _checkSetup({ ...LIVE, broker: 'manual' }, T, stubDeps({
        buildOrderPlan: async () => { planned = true; return [] },
        onManualCard:   async () => { manualCard = true },
        onCard:         async () => { confirmCard = true },
    }))
    assert.equal(res.manual, true)
    assert.equal(planned, false, 'manual places at the user\'s own broker — nothing to plan')
    assert.ok(manualCard && !confirmCard)
})

test('no resolvable accounts still alerts, but with nothing to place', async () => {
    let carded = false
    const res = await _checkSetup(LIVE, T, stubDeps({
        buildOrderPlan: async () => [],
        onCard:         async () => { carded = true },
    }))
    assert.equal(res.fired, true)
    assert.equal(res.orderState, null, 'no plan → no orderState')
    assert.equal(carded, true, 'the user still hears that their level printed')
})

test('a failed order-plan build still surfaces the trigger instead of losing it', async () => {
    const res = await _checkSetup(LIVE, T, stubDeps({
        buildOrderPlan: async () => { throw new Error('broker unreachable') },
    }))
    assert.equal(res.fired, true)
    assert.equal(res.orderState, null)
})

test('let_expire at the review window closes the setup', async () => {
    const res = await _checkSetup({ ...LIVE, valid_until: '2026-07-26T12:05:00Z' }, T, stubDeps({
        getPrice: async () => 300,   // nowhere near a zone — this is purely the expiry path
        assess:   async () => ({ verdict: 'let_expire', read: 'Window closed, no trigger.' }),
    }))
    assert.equal(res.closed, true)
})

test('expiry with any other verdict keeps the setup alive', async () => {
    const res = await _checkSetup({ ...LIVE, valid_until: '2026-07-26T12:05:00Z' }, T, stubDeps({
        getPrice: async () => 300,
        assess:   async () => ({ verdict: 'edit', read: 'Worth rolling.', edit_proposal: { why: 'shelf moved' } }),
    }))
    assert.notEqual(res.closed, true)
    assert.equal(res.verdict, 'edit')
})
