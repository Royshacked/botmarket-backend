import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _checkArmed, _checkEntry, _cadence, hasEntryWork, gateNote, clearsEntrySchedule, ENTRY_SCHEDULE_FIELD } from '../../monitoring/entry.monitor.js'

// The entry monitor — what happens when an armed idea's condition comes true.
//
// This is the side that CREATES risk: a trigger flips the entity to `hit`, builds an order plan and
// puts a confirm dialog in front of the user. So the branches that matter are the ones that decide
// whether to fire at all (the clock gates, the market gate) and what the user is then shown —
// especially the manual path, which must never build a plan, and the off-hours path, which must park
// rather than confirm.

const NOW  = Date.parse('2026-08-18T14:00:00.000Z')
const OPEN = { open: true,  nextOpenMs: null }
const SHUT = { open: false, nextOpenMs: NOW + 3 * 3_600_000 }

const TREE = { operator: 'AND', children: [{ condition: 'close above 400', type: 'structured' }] }
const TIME_TREE = { operator: 'AND', children: [{ condition: 'after 2026-08-18T13:00:00Z', type: 'time', after: '2026-08-18T13:00:00Z' }] }

const armed = (over = {}) => ({
    id: 'e1', userId: 'u1', asset: 'SPY', asset_class: 'stock', status: 'looking', direction: 'long',
    quantity: 10, broker: 'ctrader', kind: 'idea', timeframe: 'day',
    activatedAt: NOW - 86_400_000, entryFloorAt: NOW - 86_400_000,
    entry_condition_tree: TREE, ...over,
})

function harness({ market = OPEN, candles = [{ o: 1, h: 2, l: 1, c: 2, t: NOW }], fire = false, triggerAt = null, plan = [{ broker: 'ctrader', accountId: 'A1', quantity: 10 }] } = {}) {
    const calls = { fetched: [], patches: [], manual: [], confirms: [], plans: 0, states: [] }
    const deps = {
        getMarketStatus:  () => market,
        fetchCandles:     async (id, asset, tf) => { calls.fetched.push(tf); return candles },
        buildSymbolMap:   async () => ({}),
        buildVolumeCtx:   async () => ({}),
        evaluateTree:       async () => ({ triggered: fire, triggerAt }),
        evaluateConditions: async () => ({ triggered: fire, triggerAt }),
        persistStates:    async (idea, phase, states) => { calls.states.push({ phase, states }) },
        buildOrderPlan:   async () => { calls.plans++; return plan },
        notifyManualEntry:     async (userId, payload) => { calls.manual.push({ userId, payload }) },
        notifyIdeaEntryConfirm: async (idea, note) => { calls.confirms.push({ id: idea.id, note }) },
        patch:            async (id, fields) => { calls.patches.push({ id, fields }) },
    }
    return { deps, calls, last: () => calls.patches.at(-1)?.fields }
}

const nextAt = (h) => h.calls.patches.map(p => p.fields['monitor_state.next_check_at']).filter(Boolean).at(-1)
const gapMs  = (h) => Date.parse(nextAt(h)) - NOW

// ── the pre-gate ─────────────────────────────────────────────────────────────

test('an armed entity with no entry conditions can never fire', () => {
    assert.equal(hasEntryWork(armed({ entry_condition_tree: null })), false)
    assert.equal(hasEntryWork(armed({ entry_condition_tree: null, entry_conditions: [] })), false)
    assert.equal(hasEntryWork(armed({ entry_condition_tree: null, entry_conditions: [{ condition: 'x' }] })), true)
})

test('nothing armed → parked cheaply, never dropped', async () => {
    // Dropping it is the failure this monitor exists to end; a stale armed idea must stay visible.
    const h = harness()
    assert.equal(await _checkArmed(armed({ entry_condition_tree: null }), NOW, h.deps), 'nothing_armed')
    assert.deepEqual(h.calls.fetched, [])
    assert.equal(gapMs(h), 60 * 60_000)
})

test('no venue → parked, because a trigger could never become an order', async () => {
    const h = harness()
    assert.equal(await _checkArmed(armed({ broker: null }), NOW, h.deps), 'no_venue')
    assert.deepEqual(h.calls.fetched, [])
})

// ── the clock gates ──────────────────────────────────────────────────────────

test('a future time leaf blocks the check without buying a candle', async () => {
    // No candle can make a not-yet-due time leaf true, so fetching one is pure waste.
    const h = harness()
    const future = { operator: 'AND', children: [{ condition: 'after 2030-01-01', type: 'time', after: '2030-01-01T00:00:00Z' }] }
    assert.equal(await _checkArmed(armed({ entry_condition_tree: future }), NOW, h.deps), 'time_blocked')
    assert.deepEqual(h.calls.fetched, [])
})

test('an intraday entry on a shut venue sleeps until the open', async () => {
    const h = harness({ market: SHUT })
    assert.equal(await _checkArmed(armed({ timeframe: '5min' }), NOW, h.deps), 'market_closed')
    assert.deepEqual(h.calls.fetched, [])
    assert.equal(gapMs(h), 3 * 3_600_000)
})

test('a PURE SCHEDULED entry is checked on a shut venue — the clock fires it, not the tape', async () => {
    // Every leaf is a time leaf, so it needs no market data at all. Gating this on market hours
    // would make a 3am scheduled entry impossible to express.
    const h = harness({ market: SHUT, fire: false })
    const res = await _checkArmed(armed({ timeframe: '5min', entry_condition_tree: TIME_TREE }), NOW, h.deps)
    assert.equal(res, 'waiting')
    assert.deepEqual(h.calls.fetched, ['5min'], 'it is still evaluated')
})

test('a daily entry is checked on a shut venue — its candle is already closed', async () => {
    const h = harness({ market: SHUT })
    assert.equal(await _checkArmed(armed(), NOW, h.deps), 'waiting')
})

test('cumulative volume pulls the cadence to the floor', () => {
    const c = _cadence(armed({
        timeframe: 'day',
        entry_condition_tree: { operator: 'AND', children: [{ condition: 'volume above 2e6', type: 'volume', mode: 'cumulative' }] },
    }))
    assert.equal(c.gap, 60_000)
    assert.equal(c.needsLiveTape, true)
})

// ── firing ───────────────────────────────────────────────────────────────────

test('a trigger flips to hit, attaches the plan and posts the confirm', async () => {
    const h = harness({ fire: true })
    assert.equal(await _checkArmed(armed(), NOW, h.deps), 'triggered')

    const f = h.last()
    assert.equal(f.status, 'hit')
    assert.equal(f.entryTriggeredAt, NOW)
    assert.equal(f.orderState, 'awaiting_confirm')
    assert.equal(f.pendingOrder.plan.length, 1)
    assert.deepEqual(h.calls.confirms, [{ id: 'e1', note: null }])
})

test('a triggered entity is NOT rescheduled — it has left this loop', async () => {
    const h = harness({ fire: true })
    await _checkArmed(armed(), NOW, h.deps)
    assert.equal(nextAt(h), undefined, 'stamping a schedule on a document that moved on is noise')
})

test('OFF-HOURS: the plan parks at awaiting_market and NO confirm is posted', async () => {
    // The market-open sweep owns that card. Posting one here would be the second for one event.
    const h = harness({ fire: true, market: SHUT })
    await _checkArmed(armed({ entry_condition_tree: TIME_TREE }), NOW, h.deps)

    assert.equal(h.last().orderState, 'awaiting_market')
    assert.deepEqual(h.calls.confirms, [])
})

test('MANUAL: no order plan is ever built, and the user is told to place it', async () => {
    const h = harness({ fire: true })
    await _checkArmed(armed({ broker: 'manual' }), NOW, h.deps)

    assert.equal(h.calls.plans, 0, 'a manual position has no venue to plan against')
    assert.equal(h.last().orderState, 'awaiting_manual_fill')
    assert.equal(h.calls.manual.length, 1)
    assert.deepEqual(h.calls.confirms, [], 'no OrderConfirm dialog for a broker we cannot reach')
})

test('no accounts → the entity still fires, as an alert with nothing to confirm', async () => {
    const h = harness({ fire: true, plan: [] })
    await _checkArmed(armed(), NOW, h.deps)
    assert.equal(h.last().status, 'hit')
    assert.equal(h.last().orderState, undefined)
    assert.deepEqual(h.calls.confirms, [])
})

test('a trigger that predates the arm is RECORDED, not suppressed', async () => {
    // The trade is still the one the user asked for; the flag stops a stale cross reading as fresh.
    const h = harness({ fire: true, triggerAt: NOW - 90_000_000 })
    await _checkEntry(armed(), [{ c: 1 }], 'day', NOW, h.deps)
    assert.equal(h.calls.patches[0].fields.triggeredWhileWaiting, true)
    assert.equal(h.calls.patches[0].fields.triggerEventAt, NOW - 90_000_000)
})

test('condition states are persisted whether or not it fired', async () => {
    const h = harness({ fire: false })
    await _checkArmed(armed(), NOW, h.deps)
    assert.deepEqual(h.calls.states.map(s => s.phase), ['entry'], 'the chips must update on a quiet day too')
})

// ── the card's note ──────────────────────────────────────────────────────────

test('a scheduled moment that had already passed at arm time reads as passed_earlier', () => {
    const armAt = NOW
    assert.equal(gateNote({ timeGated: true, after: NOW - 1000 }, armAt), 'passed_earlier')
    assert.equal(gateNote({ timeGated: true, after: NOW + 1000 }, armAt), null, 'a genuine future trigger is fresh')
    assert.equal(gateNote({ timeGated: false, after: null }, armAt), null)
    assert.equal(gateNote(null, armAt), null)
})

// ── arming must clear the persisted schedule ─────────────────────────────────
// The rule lives here, next to the loop whose cadence it clears, and tradeIdeas.updateIdea imports
// it. Spelled out in the CRUD path it would be a magic string that drifts the first time
// this loop moves where it keeps its schedule — and the failure is silent: an idea the user just
// armed simply is not looked at for up to four hours.

test('arming clears the schedule', () => {
    assert.equal(clearsEntrySchedule({ status: 'looking' }), true)
})

test('pushing the entry floor is the same event under another name', () => {
    // The pre-flight Reset and the re-arm path both move the floor, which changes WHICH cross would
    // fire — so the old cadence is no longer the right time to look.
    assert.equal(clearsEntrySchedule({ entryFloorAt: 123 }), true)
})

test('an unrelated edit leaves the cadence alone', () => {
    // Clearing on every patch would drag every armed idea back to the front of the queue on any
    // edit at all — a note, a tag, a chat message.
    assert.equal(clearsEntrySchedule({ notes: 'typo fix' }), false)
    assert.equal(clearsEntrySchedule({ status: 'waiting' }), false)
    assert.equal(clearsEntrySchedule({}), false)
    assert.equal(clearsEntrySchedule(null), false)
})

test('the field named is the one the loop actually schedules on', () => {
    // If these two ever diverge the clear becomes a no-op that nothing fails on.
    const h = harness()
    return _checkArmed(armed({ broker: null }), NOW, h.deps).then(() => {
        assert.ok(ENTRY_SCHEDULE_FIELD in h.calls.patches[0].fields)
    })
})
