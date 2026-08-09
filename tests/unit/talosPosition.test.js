import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _checkSetup, positionGate } from '../../monitoring/talos.monitor.service.js'
import { normalizeSetup } from '../../services/setup.schema.js'
import { buildSetupManage } from '../../services/tradeNotify.service.js'

// The in-position WAKE, end to end, plus the card it posts.
//
// The pure pieces it is built from — positionGate, computeMetrics, rMultiple, reviewDue — are pinned
// in talosMonitor.test.js alongside the readiness gates. What is here is the orchestration those
// cannot show on their own: that a quiet position costs nothing, that a verdict reaches a card
// exactly once, and that a failed read stays honest instead of inventing something.

const T = Date.parse('2026-07-26T12:00:00Z')

const PLAN = {
    asset: 'NVDA', asset_class: 'stock',
    direction: 'long', type: 'swing', trade_mode: 'classical', timeframe: '1hr',
    entry_zones: [{ id: 'ez1', lower: 237.8, upper: 238.6, quantity: 100 }],
    stop_zones:  [{ id: 'sz1', lower: 234.8, upper: 235.9 }],
    tp_zones:    [{ id: 'tz1', lower: 246, upper: 247.2, quantity: 100 }],
    conditions: [{ id: 'c1', text: 'CHoCH up on the 15m', weight: 'primary', mode: 'measured', persistence: 'live' }],
}

// In at 238.6, original stop 234.8 (risk 3.8), one target at 246.
const PS = (over = {}) => ({
    entry:   { fill_price: 238.6, fill_at: '2026-07-26T09:00:00.000Z', size: 100, direction: 'long' },
    stop:    { initial: 234.8, current: 234.8 },
    targets: [{ price: 246, hit_at: null }],
    ...over,
})

const INPOS = (ps = PS(), over = {}) => ({
    id: 'setup_NVDA_1', kind: 'setup', status: 'long',
    broker: 'ctrader', accounts: ['a1'], mainAccountId: 'a1', quantity: 100, valid_until: null,
    monitor_state: { next_check_at: null, check_count: 0, memo: null, timeline: [], conditions: {}, scenarios: {} },
    ...normalizeSetup(PLAN),
    cadence: { min: 30, max: 240 },
    position_state: ps,
    ...over,
})

function stubDeps(over = {}) {
    const writes = []
    const entries = []
    return {
        isAssetOpen: () => true,
        nextOpenMs:  () => T + 3600_000,
        getPrice:    async () => 240,
        assessPosition: async () => ({ verdict: 'hold', read: 'Doing what it should.', next_check_min: 60 }),
        onManageCard:   async () => {},
        writes, entries,
        persist: async (_id, $set, entry = null) => { writes.push($set); entries.push(entry) },
        ...over,
    }
}

// ─── The wake ─────────────────────────────────────────────────────────────────

test('a quiet position is held for free — no read, no card, no journal line', async () => {
    // The overwhelmingly common wake, and the whole reason the gate runs first. Metrics still move
    // so the eventual read has history to reason about.
    let assessed = false
    const deps = stubDeps({ getPrice: async () => 240, assessPosition: async () => { assessed = true } })
    const res  = await _checkSetup(INPOS(), T, deps)

    assert.equal(res.reason, 'in_position_idle')
    assert.equal(assessed, false, 'the gate said nothing happened')
    assert.equal(deps.entries[0], null, 'an idle wake writing a line is what turns the journal into noise')
    assert.ok(deps.writes[0]['position_state.metrics.r_multiple_now'] != null, 'metrics still tracked')
})

test('a gate trip buys the read, and a verdict that wants something posts a card', async () => {
    let card = null
    const deps = stubDeps({
        getPrice: async () => 246,
        assessPosition: async () => ({ verdict: 'take_partial', proposal: { fraction: 'third' }, read: 'Banking a third into the target.', next_check_min: 60 }),
        onManageCard: async (_s, c) => { card = c },
    })
    const res = await _checkSetup(INPOS(), T, deps)

    assert.equal(res.reason, 'scale_out')
    assert.equal(res.verdict, 'take_partial')
    assert.equal(card.proposal.fraction, 'third')
    assert.equal(deps.entries[0].reason, 'in_position')
    assert.equal(deps.entries[0].verdict, 'take_partial')
    assert.equal(deps.writes[0]['position_state.pending_action'].verdict, 'take_partial')
})

test('a target that earned a wake is stamped, so it cannot re-trip forever', async () => {
    // The arithmetic fact — price reached it — does not become untrue because the user declined.
    const deps = stubDeps({
        getPrice: async () => 246,
        assessPosition: async () => ({ verdict: 'take_partial', proposal: { fraction: 'half' }, next_check_min: 60 }),
    })
    await _checkSetup(INPOS(), T, deps)
    assert.ok(deps.writes[0]['position_state.targets'][0].hit_at, 'the ladder moves on')
})

test('hold is a real answer — journalled, but never a card', async () => {
    let carded = false
    const deps = stubDeps({
        getPrice: async () => 246,
        assessPosition: async () => ({ verdict: 'hold', read: 'Target tagged but the push is thin; holding.', next_check_min: 45 }),
        onManageCard: async () => { carded = true },
    })
    const res = await _checkSetup(INPOS(), T, deps)

    assert.equal(res.verdict, 'hold')
    assert.equal(carded, false)
    assert.equal(deps.writes[0]['position_state.pending_action'], undefined)
    assert.match(deps.entries[0].note, /holding/i, 'the decision is still on the record')
})

test('a pending card is not re-posted by the same verdict on the next wake', async () => {
    // The user already has that decision in front of them. Re-posting it every wake is how a
    // monitor teaches people to ignore it.
    let carded = false
    const ps = PS({ pending_action: { verdict: 'take_partial', at: new Date(T - 60_000).toISOString() } })
    const deps = stubDeps({
        getPrice: async () => 246,
        assessPosition: async () => ({ verdict: 'take_partial', proposal: { fraction: 'third' }, next_check_min: 60 }),
        onManageCard: async () => { carded = true },
    })
    await _checkSetup(INPOS(ps), T, deps)
    assert.equal(carded, false)
})

test('a more urgent verdict DOES interrupt a pending one', async () => {
    // A broken thesis has to be able to talk over a pending "bank a third".
    let card = null
    const ps = PS({ pending_action: { verdict: 'take_partial', at: new Date(T - 60_000).toISOString() } })
    const deps = stubDeps({
        getPrice: async () => 235.7,
        assessPosition: async () => ({ verdict: 'exit_now', read: 'Thesis is gone.', next_check_min: 15 }),
        onManageCard: async (_s, c) => { card = c },
    })
    await _checkSetup(INPOS(ps), T, deps)
    assert.equal(card.verdict, 'exit_now')
})

test('an off-menu verdict degrades to hold rather than reaching a card', async () => {
    let carded = false
    const deps = stubDeps({
        getPrice: async () => 246,
        assessPosition: async () => ({ verdict: 'YOLO', next_check_min: 30 }),
        onManageCard: async () => { carded = true },
    })
    const res = await _checkSetup(INPOS(), T, deps)
    assert.equal(res.verdict, 'hold')
    assert.equal(carded, false)
})

test('a failed read says so and retries soon, rather than wedging or inventing a verdict', async () => {
    const deps = stubDeps({
        getPrice: async () => 246,
        assessPosition: async () => ({ _failReason: 'malformed' }),
    })
    const res = await _checkSetup(INPOS(), T, deps)

    assert.equal(res.failed, true)
    assert.equal(deps.entries[0].verdict, null, 'no verdict is better than a guessed one')
    assert.ok(deps.entries[0].note.length)
})

test('the model picks its own next check, clamped into the setup cadence', async () => {
    // Unclamped, a model that asks for one minute on a swing burns the budget and one that asks for
    // three days goes blind.
    const deps = stubDeps({
        getPrice: async () => 246,
        assessPosition: async () => ({ verdict: 'hold', next_check_min: 1 }),
    })
    await _checkSetup(INPOS(), T, deps)
    const gapMin = (Date.parse(deps.writes[0]['monitor_state.next_check_at']) - T) / 60_000
    assert.equal(gapMin, 30, 'clamped up to cadence.min, not honoured at 1')
})

test('a setup awaiting its fill is left alone entirely', async () => {
    // Nothing to manage, and nothing to say that the entry card did not already say.
    let assessed = false
    const deps = stubDeps({ assessPosition: async () => { assessed = true } })
    const res  = await _checkSetup(INPOS(PS(), { status: 'hit' }), T, deps)

    assert.equal(res.reason, 'awaiting_fill')
    assert.equal(assessed, false)
    assert.equal(deps.entries[0], null)
})

// ─── The card ─────────────────────────────────────────────────────────────────

test('the proposal is IN the card, not hidden behind a button', () => {
    // A partial or a stop move is a number the user can accept at a glance; burying it costs a
    // round trip on something time-sensitive.
    const stop = buildSetupManage(INPOS(), { verdict: 'move_stop', proposal: { stop: 238.6, why: 'breakeven' } })
    assert.match(stop.content, /238\.6/)
    assert.match(stop.content, /breakeven/)

    const partial = buildSetupManage(INPOS(), { verdict: 'take_partial', proposal: { fraction: 'two_thirds' } })
    assert.match(partial.content, /two thirds/)
})

test('the card is Mentor speaking about a setup, never Kairos about a call', () => {
    const c = buildSetupManage(INPOS(), { verdict: 'exit_now', read: 'Thesis broke.' })
    assert.equal(c.botId, 'mentor')
    assert.equal(c.type, 'setup_manage')
    assert.equal(c.payload.setupId, 'setup_NVDA_1')
    assert.doesNotMatch(c.content, /Kairos/)
})

test('let_run is stated but asks for nothing, so it carries no action', () => {
    // A deliberate decision NOT to trim — worth telling the user, not worth a button.
    const c = buildSetupManage(INPOS(), { verdict: 'let_run', read: 'Trend is intact.' })
    assert.equal(c.actions, undefined)
    assert.match(c.content, /letting it run/i)
})

test('an unknown verdict still produces a readable card rather than an empty bubble', () => {
    const c = buildSetupManage(INPOS(), { verdict: 'something_new' })
    assert.ok(c.content.length)
    assert.doesNotMatch(c.content, /undefined/)
})

test('the adverse band follows the WORKING stop, not the original one', () => {
    // A trailed stop narrows where "pressing it" is. Measuring the band off `initial` would keep
    // warning about a level the position left behind, and stay silent at the one now protecting it.
    const moved = PS({ stop: { initial: 234.8, current: 243 } })
    assert.equal(positionGate(moved, 243.9).flag, 'adverse', 'pressing the stop where it now rests')
    assert.equal(positionGate(PS(), 243.9).flag, 'breakeven', 'the same price against the ORIGINAL stop is not adverse')
})

test('every gate edge mirrors for a short', () => {
    // Three direction-dependent comparisons, and a sign error in any one of them turns a losing
    // short into a "target reached". rMultiple's own short case is covered above; this is the gate.
    const short = {
        entry:   { fill_price: 100, direction: 'short' },
        stop:    { initial: 104, current: 104 },
        targets: [{ price: 90, hit_at: null }],
    }
    assert.equal(positionGate(short, 103.1).flag, 'adverse',   'price rising INTO the stop')
    assert.equal(positionGate(short, 88).flag,    'scale_out', 'a short falls into its target')
    assert.equal(positionGate(short, 96).flag,    'breakeven', '+1R down, stop still above entry')
    assert.equal(positionGate(short, 99).flag,    null,        'drifting, nothing earned')
})

// ─── Scaling in ───────────────────────────────────────────────────────────────
// A premise with two entry legs. Everything above this line describes a position that is fully on;
// these describe one still being built.

const TWO_LEG_PLAN = {
    ...PLAN,
    // The pullback leg sits ABOVE the stop (234.8) and outside its quarter-R adverse band
    // (<=235.75). A leg below the stop could never fill — the stop takes you out first — so a
    // fixture with one would only ever exercise the adverse path.
    entry_zones: [{ id: 'ez1', lower: 237.8, upper: 238.6, quantity: 60 },
                  { id: 'ez2', lower: 236.0, upper: 236.6, quantity: 40 }],
}

/** In on leg ez1 only; ez2 is still pending below. */
const SCALING = (over = {}, psOver = {}) => {
    const base = normalizeSetup(TWO_LEG_PLAN)
    return {
        id: 'setup_NVDA_1', kind: 'setup', status: 'long',
        broker: 'ctrader', accounts: ['a1'], mainAccountId: 'a1', valid_until: null,
        monitor_state: { next_check_at: null, check_count: 0, memo: null, timeline: [], conditions: {}, scenarios: {} },
        ...base,
        armed_scenario_id: base.scenarios?.[0]?.id ?? null,
        cadence: { min: 30, max: 240 },
        position_state: {
            entry: { fill_price: 238.6, fill_at: '2026-07-26T09:00:00.000Z', size: 60, direction: 'long',
                     legs: [{ zone_id: 'ez1', price: 238.6, quantity: 60 }] },
            stop:  { initial: 234.8, current: 234.8 },
            targets: [{ price: 246, hit_at: null }],
            ...psOver,
        },
        ...over,
    }
}

test('a planned leg printing buys the read even though the gate is quiet', async () => {
    // Without this the wake takes the cheap hold and the second leg is never noticed at all.
    let ctx = null
    const deps = stubDeps({
        getPrice: async () => 236.2,                       // inside ez2, nowhere near the stop
        assessPosition: async (_s, _ps, c) => { ctx = c; return { verdict: 'hold', next_check_min: 60 } },
    })
    const res = await _checkSetup(SCALING(), T, deps)

    assert.notEqual(res.reason, 'in_position_idle', 'not the cheap hold')
    assert.equal(ctx.reason, 'scale_in')
    assert.equal(ctx.scaleZone.id, 'ez2', 'and the model is told WHICH leg')
})

test('add_leg places the LEG, at the leg size, and never touches status', async () => {
    // The whole risk of routing this through the entry flow instead: that path drives _nextStatus
    // and would flip a status that is already correct.
    let planned = null
    const deps = stubDeps({
        getPrice: async () => 236.2,
        assessPosition: async () => ({ verdict: 'add_leg', read: 'The dip leg printed.', next_check_min: 60 }),
        buildOrderPlan: async (executable) => { planned = executable; return [{ accountId: 'a1', quantity: executable.quantity }] },
    })
    await _checkSetup(SCALING(), T, deps)
    const $set = deps.writes[0]

    assert.equal(planned.quantity, 40, 'the pending leg, not the premise total of 100')
    assert.equal($set.status, undefined, 'already long — adding to it does not change what it is')
    assert.equal($set.armed_zone_id, 'ez2', 'the fill will stamp against the right zone')
    assert.equal($set.orderState, 'awaiting_confirm')
    assert.ok($set.pendingOrder?.plan?.length)
})

test('a shut venue parks the leg rather than dropping it', async () => {
    const deps = stubDeps({
        getPrice: async () => 236.2,
        isAssetOpen: () => false,
        assessPosition: async () => ({ verdict: 'add_leg', next_check_min: 60 }),
        buildOrderPlan: async () => [{ accountId: 'a1', quantity: 40 }],
    })
    await _checkSetup(SCALING(), T, deps)
    assert.equal(deps.writes[0].orderState, 'awaiting_market')
})

test('NEVER add into a position pressing its stop, whatever the model says', async () => {
    // The averaging-down reflex is the one thing this must not automate. The gate suppresses the
    // offer before the model is even asked, so there is no scaleZone for it to act on.
    let ctx = null
    const deps = stubDeps({
        getPrice: async () => 235.0,                       // inside the quarter-R adverse band
        assessPosition: async (_s, _ps, c) => { ctx = c; return { verdict: 'add_leg', next_check_min: 60 } },
        buildOrderPlan: async () => { throw new Error('must not be called') },
    })
    const res = await _checkSetup(SCALING(), T, deps)

    assert.equal(ctx.reason, 'adverse', 'the wake is about protection, not about adding')
    assert.equal(ctx.scaleZone, null)
    assert.equal(deps.writes[0].orderState, undefined, 'nothing placed')
    assert.notEqual(res.reason, 'scale_in')
})

test('add_leg with nothing printing is refused rather than trusted', async () => {
    // The prompt says the same thing; this is the half that cannot be talked out of it. A model
    // returning add_leg on a quiet wake is proposing size the plan never authorised.
    const deps = stubDeps({
        getPrice: async () => 240,                         // outside every entry zone
        assessPosition: async () => ({ verdict: 'add_leg', next_check_min: 60 }),
        buildOrderPlan: async () => { throw new Error('must not be called') },
    })
    await _checkSetup(SCALING(), T, deps)
    assert.equal(deps.writes[0].orderState, undefined)
})

test('a fully-scaled position has nothing pending and behaves as before', async () => {
    let ctx = null
    const deps = stubDeps({
        getPrice: async () => 236.2,
        assessPosition: async (_s, _ps, c) => { ctx = c; return { verdict: 'hold', next_check_min: 60 } },
    })
    const both = SCALING({}, { entry: { fill_price: 236, fill_at: '2026-07-26T09:00:00.000Z', size: 100, direction: 'long',
        legs: [{ zone_id: 'ez1', price: 238.6, quantity: 60 }, { zone_id: 'ez2', price: 236.2, quantity: 40 }] } })
    const res = await _checkSetup(both, T, deps)
    assert.equal(res.reason ?? (ctx && ctx.reason), 'in_position_idle', 'quiet again once both legs are on')
})
