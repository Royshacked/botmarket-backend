import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _checkSetup, READ_LAG_MS } from '../../monitoring/talos.monitor.service.js'
import { normalizeSetup } from '../../services/setup.schema.js'
import { buildSetupManage } from '../../services/tradeNotify.service.js'

// The in-position WAKE, end to end, plus the card it posts (docs/design/talos-per-candle.md).
//
// THE RULE: a position is read only where the user wrote a condition on a leg. A position of plain
// levels is DORMANT (pinned in talosMonitor.test.js); one with a watched leg is read on every candle
// close, and the verdict is held to the menu those legs allow.

const T = Date.parse('2026-07-26T12:00:00Z')

const COND = (id, text) => ({ id, text, weight: 'primary', mode: 'judgment', persistence: 'live' })

// One WATCHED target — the user asked to bank it on a condition — and a plain stop.
const PLAN = {
    asset: 'NVDA', asset_class: 'stock',
    direction: 'long', type: 'swing', trade_mode: 'classical', timeframe: '1hr',
    entry_legs: [{ id: 'ez1', price: 238.6, quantity: 100 }],
    stop_legs:  [{ id: 'sz1', price: 234.8 }],
    target_legs:    [{ id: 'tz1', price: 246, quantity: 50, conditions: [COND('tz1c1', 'bank it if momentum fades into the level')] }],
    conditions:  [COND('c1', 'CHoCH up on the 15m')],
}

// In at 238.6, original stop 234.8 (risk 3.8), one target at 246.
const PS = (over = {}) => ({
    entry:   { fill_price: 238.6, fill_at: '2026-07-26T09:00:00.000Z', size: 100, direction: 'long', legs: [{ leg_id: 'ez1', price: 238.6, quantity: 100 }] },
    stop:    { initial: 234.8, current: 234.8 },
    targets: [{ price: 246, quantity: 50, watched: true }],
    ...over,
})

const INPOS = (ps = PS(), over = {}, plan = PLAN) => {
    const base = normalizeSetup(plan)
    return {
        id: 'setup_NVDA_1', kind: 'setup', status: 'long',
        broker: 'ctrader', accounts: ['a1'], mainAccountId: 'a1', quantity: 100, valid_until: null,
        monitor_state: { next_check_at: null, check_count: 0, memo: null, conditions: {}, scenarios: {} },
        ...base,
        armed_scenario_id: base.scenarios?.[0]?.id ?? null,
        position_state: ps,
        ...over,
    }
}

function stubDeps(over = {}) {
    const writes = []
    const entries = []
    return {
        isAssetOpen: () => true,
        nextCandleCloseMs: (_s, _c, _rung, now) => now + 3600_000,
        getPrice:    async () => 240,
        assessPosition: async () => ({ verdict: 'hold', read: 'Doing what it should.' }),
        onManageCard:   async () => {},
        writes, entries,
        persist: async (_id, $set, entry = null) => { writes.push($set); entries.push(entry) },
        ...over,
    }
}

// ─── The wake ─────────────────────────────────────────────────────────────────

test('a position with a watched leg is read on every wake, wherever price is', async () => {
    let ctx = null
    const deps = stubDeps({ getPrice: async () => 240, assessPosition: async (_s, _ps, c) => { ctx = c; return { verdict: 'hold', read: 'Nothing yet.' } } })
    const res  = await _checkSetup(INPOS(), T, deps)

    assert.equal(res.reason, 'candle')
    assert.equal(res.verdict, 'hold')
    assert.deepEqual(ctx.watched.targets.map(z => z.id), ['tz1'], 'the read is told exactly which legs are its mandate')
    assert.equal(ctx.watched.stop, null, 'a plain stop is the broker\'s')
    assert.ok(deps.writes[0]['position_state.metrics.r_multiple_now'] != null, 'metrics tracked on the way')
    assert.equal(deps.writes[0]['monitor_state.next_check_at'], new Date(T + 3600_000 + READ_LAG_MS).toISOString())
})

test('a fired guard names the wake and rides into the read', async () => {
    let ctx = null
    const woke = { price: 245, direction: 'above', means: 'manage', armed_at: 'earlier' }
    const deps = stubDeps({ assessPosition: async (_s, _ps, c) => { ctx = c; return { verdict: 'hold', read: 'x' } } })
    const res  = await _checkSetup(INPOS(PS(), { monitor_state: { woke_on: woke, conditions: {}, scenarios: {} } }), T, deps)
    assert.equal(res.reason, 'guard')
    assert.deepEqual(ctx.woke, woke)
    assert.equal(deps.entries[0].fired.price, 245)
    assert.equal(deps.writes[0]['monitor_state.woke_on'], null, 'one-shot')
})

test('take_partial names the watched leg; the monitor resolves its size and posts the card', async () => {
    let card = null
    const deps = stubDeps({
        getPrice: async () => 246,
        assessPosition: async () => ({ verdict: 'take_partial', proposal: { leg: 'tz1' }, read: 'Momentum faded into the level.' }),
        onManageCard: async (_s, c) => { card = c },
    })
    const res = await _checkSetup(INPOS(), T, deps)

    assert.equal(res.verdict, 'take_partial')
    assert.deepEqual(card.proposal, { leg: 'tz1', quantity: 50, size_pct: 50 }, 'the leg\'s own size, as a share of the original position')
    assert.equal(deps.entries[0].reason, 'candle')
    assert.equal(deps.entries[0].verdict, 'take_partial')
    assert.deepEqual(deps.entries[0].proposal, { leg: 'tz1', quantity: 50, size_pct: 50 })
    assert.equal(deps.writes[0]['position_state.pending_action'].verdict, 'take_partial')
})

test('take_partial with ONE watched target needs no leg id; with none it is a hold', async () => {
    const one = stubDeps({ assessPosition: async () => ({ verdict: 'take_partial' }) })
    assert.equal((await _checkSetup(INPOS(), T, one)).verdict, 'take_partial', 'unambiguous')

    const unsized = INPOS(PS(), {}, { ...PLAN, target_legs: [{ ...PLAN.target_legs[0], quantity: null }] })
    const noSize = stubDeps({ assessPosition: async () => ({ verdict: 'take_partial', proposal: { leg: 'tz1' } }) })
    assert.equal((await _checkSetup(unsized, T, noSize)).verdict, 'hold', 'a leg with no size cannot be banked')
})

test('the verdict is held to the menu the watched legs allow', async () => {
    // Only a target is watched here: the stop verdicts are not on the menu, however the model feels.
    let carded = false
    const deps = stubDeps({
        getPrice: async () => 235.7,
        assessPosition: async () => ({ verdict: 'exit_now', read: 'Thesis is gone.' }),
        onManageCard: async () => { carded = true },
    })
    const res = await _checkSetup(INPOS(), T, deps)
    assert.equal(res.verdict, 'hold')
    assert.equal(carded, false)
})

test('a watched STOP unlocks move_stop and exit_now, and a stop move needs a level', async () => {
    const plan = { ...PLAN, stop_legs: [{ id: 'sz1', price: 234.8, conditions: [COND('sz1c1', 'out early if it closes below the 4hr VWAP')] }] }
    let card = null
    const deps = stubDeps({
        assessPosition: async () => ({ verdict: 'move_stop', proposal: { stop: 237, why: 'the shelf held' }, read: 'Tightening.' }),
        onManageCard: async (_s, c) => { card = c },
    })
    const res = await _checkSetup(INPOS(PS(), {}, plan), T, deps)
    assert.equal(res.verdict, 'move_stop')
    assert.deepEqual(card.proposal, { stop: 237, why: 'the shelf held' })

    const noLevel = stubDeps({ assessPosition: async () => ({ verdict: 'move_stop', proposal: {} }) })
    assert.equal((await _checkSetup(INPOS(PS(), {}, plan), T, noLevel)).verdict, 'hold', 'a stop move with no level is a hold')

    const exit = stubDeps({ assessPosition: async () => ({ verdict: 'exit_now', read: 'Closed below VWAP.' }) })
    assert.equal((await _checkSetup(INPOS(PS(), {}, plan), T, exit)).verdict, 'exit_now')
})

test('hold is a real answer — journalled, but never a card', async () => {
    let carded = false
    const deps = stubDeps({
        getPrice: async () => 246,
        assessPosition: async () => ({ verdict: 'hold', read: 'Target tagged but the push is thin; holding.' }),
        onManageCard: async () => { carded = true },
    })
    const res = await _checkSetup(INPOS(), T, deps)

    assert.equal(res.verdict, 'hold')
    assert.equal(carded, false)
    assert.equal(deps.entries[0].verdict, 'hold')
    assert.match(deps.entries[0].note, /holding/)
})

test('the journal row says what the read checked and pulled', async () => {
    const deps = stubDeps({
        assessPosition: async () => ({
            verdict: 'hold', read: 'Momentum still fine.', timeframe_used: '15min',
            conditions: [{ id: 'tz1c1', met: 'no', note: 'volume still expanding' }],
            _tools: ['get_chart'],
        }),
    })
    await _checkSetup(INPOS(), T, deps)
    const row = deps.entries[0]
    // Where the read STOOD — the premise — not the `timeframe_used` it reported.
    assert.equal(row.rung, '1hr')
    assert.deepEqual(row.tools, ['get_chart'])
    assert.deepEqual(row.conditions, [{ id: 'tz1c1', met: 'no', note: 'volume still expanding' }])
    assert.deepEqual(deps.writes[0]['monitor_state.cost'].last, ['get_chart'])
    assert.deepEqual(deps.writes[0]['monitor_state.last_assessment'].tools, ['get_chart'])
})

test('a pending card is not re-posted by the same verdict on the next wake', async () => {
    let carded = false
    const ps = PS({ pending_action: { verdict: 'take_partial', at: new Date(T - 60_000).toISOString() } })
    const deps = stubDeps({
        getPrice: async () => 246,
        assessPosition: async () => ({ verdict: 'take_partial', proposal: { leg: 'tz1' } }),
        onManageCard: async () => { carded = true },
    })
    await _checkSetup(INPOS(ps), T, deps)
    assert.equal(carded, false)
})

test('a more urgent verdict DOES interrupt a pending one', async () => {
    const plan = { ...PLAN, stop_legs: [{ id: 'sz1', price: 234.8, conditions: [COND('sz1c1', 'out if it closes below VWAP')] }] }
    let card = null
    const ps = PS({ pending_action: { verdict: 'take_partial', at: new Date(T - 60_000).toISOString() } })
    const deps = stubDeps({
        getPrice: async () => 235.7,
        assessPosition: async () => ({ verdict: 'exit_now', read: 'Thesis is gone.' }),
        onManageCard: async (_s, c) => { card = c },
    })
    await _checkSetup(INPOS(ps, {}, plan), T, deps)
    assert.equal(card.verdict, 'exit_now')
})

test('an off-menu verdict degrades to hold rather than reaching a card', async () => {
    let carded = false
    const deps = stubDeps({
        assessPosition: async () => ({ verdict: 'YOLO' }),
        onManageCard: async () => { carded = true },
    })
    const res = await _checkSetup(INPOS(), T, deps)
    assert.equal(res.verdict, 'hold')
    assert.equal(carded, false)
})

test('a failed read says so and retries at the next close, rather than wedging or inventing a verdict', async () => {
    const deps = stubDeps({ assessPosition: async () => ({ _failReason: 'malformed', _tools: ['get_chart'] }) })
    const res = await _checkSetup(INPOS(), T, deps)

    assert.equal(res.failed, true)
    assert.equal(deps.entries[0].verdict, null, 'no verdict is better than a guessed one')
    assert.deepEqual(deps.entries[0].tools, ['get_chart'], 'what it spent is still recorded')
    assert.equal(deps.writes[0]['monitor_state.next_check_at'], new Date(T + 3600_000 + READ_LAG_MS).toISOString())
})

test('the rung the read asks for is opened next time and paces the next read', async () => {
    const asked = []
    const deps = stubDeps({
        assessPosition: async () => ({ verdict: 'hold', next_timeframe: '4hr' }),
        nextCandleCloseMs: (_s, _c, rung, now) => { asked.push(rung); return now + 60_000 },
    })
    await _checkSetup(INPOS(), T, deps)
    assert.equal(deps.writes[0]['monitor_state.timeframe'], '4hr')
    // The NEXT read is paced by the rung it opened on this time (the stored one, the premise by
    // default) — not by the one it just asked for.
    assert.deepEqual(asked, ['1hr'])
})

// ─── Off-hours ────────────────────────────────────────────────────────────────

test('a shut market buys nothing — no price, no read, no card, and it sleeps until the first close after the open', async () => {
    let priced = false, assessed = false, carded = false
    const deps = stubDeps({
        isAssetOpen: () => false,
        nextCandleCloseMs: () => T + 7 * 3600_000,
        getPrice:       async () => { priced = true; return 235.0 },
        assessPosition: async () => { assessed = true; return { verdict: 'exit_now' } },
        onManageCard:   async () => { carded = true },
    })
    const res = await _checkSetup(INPOS(), T, deps)

    assert.equal(res.reason, 'market_closed')
    assert.equal(priced, false, 'a frozen price is not worth fetching')
    assert.equal(assessed, false)
    assert.equal(carded, false, 'an exit_now card at 3am is about a trade nobody can exit')
    assert.equal(deps.entries[0], null, 'the market shutting on schedule is not news about the trade')
    assert.equal(deps.writes[0]['monitor_state.next_check_at'], new Date(T + 7 * 3600_000 + READ_LAG_MS).toISOString())
})

test('the fill stamp is bookkeeping, not monitoring, so a shut market does not defer it', async () => {
    const deps = stubDeps({ isAssetOpen: () => false })
    const res  = await _checkSetup(INPOS(PS({ entry: { intended: 238.6, direction: 'long' } })), T, deps)

    assert.equal(res.reason, 'entry')
    assert.equal(deps.writes[0]['position_state.stop.initial'], 234.8)
    assert.equal(deps.entries[0].reason, 'entry')
})

test('a setup awaiting its fill is left alone entirely', async () => {
    let assessed = false
    const deps = stubDeps({ assessPosition: async () => { assessed = true } })
    const res  = await _checkSetup(INPOS(PS(), { status: 'hit' }), T, deps)

    assert.equal(res.reason, 'awaiting_fill')
    assert.equal(assessed, false)
    assert.equal(deps.entries[0], null)
})

// ─── The card ─────────────────────────────────────────────────────────────────

test('the proposal is IN the card, not hidden behind a button', () => {
    const stop = buildSetupManage(INPOS(), { verdict: 'move_stop', proposal: { stop: 238.6, why: 'breakeven' } })
    assert.match(stop.content, /238\.6/)
    assert.match(stop.content, /breakeven/)

    const partial = buildSetupManage(INPOS(), { verdict: 'take_partial', proposal: { leg: 'tz1', quantity: 50, size_pct: 50 } })
    assert.match(partial.content, /bank 50/)
    assert.match(partial.content, /condition on your target/)
})

test('the card is Mentor speaking about a setup, never Kairos about a call', () => {
    const c = buildSetupManage(INPOS(), { verdict: 'exit_now', read: 'Thesis broke.' })
    assert.equal(c.botId, 'mentor')
    assert.equal(c.type, 'setup_manage')
    assert.equal(c.payload.setupId, 'setup_NVDA_1')
    assert.doesNotMatch(c.content, /Kairos/)
})

test('an unknown verdict still produces a readable card rather than an empty bubble', () => {
    const c = buildSetupManage(INPOS(), { verdict: 'something_new' })
    assert.ok(c.content.length)
    assert.doesNotMatch(c.content, /undefined/)
})

// ─── Scaling in ───────────────────────────────────────────────────────────────
// A premise with two entry legs. A pending leg is judged by the setup's entry conditions (the same
// mandate the first leg was taken on), so on a conditional setup it is watched.

const TWO_LEG_PLAN = {
    ...PLAN,
    target_legs: [{ id: 'tz1', price: 246, quantity: 100 }],   // plain target: only the leg is watched
    entry_legs: [{ id: 'ez1', price: 238.6, quantity: 60 },
                  { id: 'ez2', price: 236.6, quantity: 40 }],
}

/** In on leg ez1 only; ez2 is still pending below. */
const SCALING = (over = {}, psOver = {}) => INPOS({
    entry: { fill_price: 238.6, fill_at: '2026-07-26T09:00:00.000Z', size: 60, direction: 'long',
             legs: [{ leg_id: 'ez1', price: 238.6, quantity: 60 }] },
    stop:  { initial: 234.8, current: 234.8 },
    targets: [{ price: 246, quantity: 100, watched: false }],
    ...psOver,
}, over, TWO_LEG_PLAN)

test('a pending leg is watched on the setup\'s own conditions, and the read is told which', async () => {
    let ctx = null
    const deps = stubDeps({ getPrice: async () => 240, assessPosition: async (_s, _ps, c) => { ctx = c; return { verdict: 'hold' } } })
    const res = await _checkSetup(SCALING(), T, deps)
    assert.equal(res.reason, 'candle')
    assert.deepEqual(ctx.watched.entries.map(z => z.id), ['ez2'])
    assert.deepEqual(ctx.watched.targets, [], 'the plain target is not on the list')
})

test('add_leg places the LEG, at the leg size, and never touches status', async () => {
    let planned = null
    const deps = stubDeps({
        getPrice: async () => 236.6,                       // AT ez2
        assessPosition: async () => ({ verdict: 'add_leg', proposal: { leg: 'ez2' }, read: 'The dip leg printed.' }),
        buildOrderPlan: async (executable) => { planned = executable; return [{ accountId: 'a1', quantity: executable.quantity }] },
    })
    await _checkSetup(SCALING(), T, deps)
    const $set = deps.writes[0]

    assert.equal(planned.quantity, 40, 'the pending leg, not the premise total of 100')
    assert.equal($set.status, undefined, 'already long — adding to it does not change what it is')
    assert.equal($set.armed_leg_id, 'ez2', 'the fill will stamp against the right leg')
    assert.equal($set.orderState, 'awaiting_confirm')
    assert.ok($set.pendingOrder?.plan?.length)
})

test('a venue that shuts DURING the wake parks the leg rather than dropping it', async () => {
    let looks = 0
    const deps = stubDeps({
        getPrice: async () => 236.6,
        isAssetOpen: () => ++looks === 1,          // open at the gate, shut at the order
        assessPosition: async () => ({ verdict: 'add_leg', proposal: { leg: 'ez2' } }),
        buildOrderPlan: async () => [{ accountId: 'a1', quantity: 40 }],
    })
    await _checkSetup(SCALING(), T, deps)
    assert.equal(deps.writes[0].orderState, 'awaiting_market')
})

test('add_leg with the leg not printing is refused rather than trusted', async () => {
    // The prompt says the same thing; this is the half that cannot be talked out of it.
    const deps = stubDeps({
        getPrice: async () => 240,                         // outside every entry zone
        assessPosition: async () => ({ verdict: 'add_leg', proposal: { leg: 'ez2' } }),
        buildOrderPlan: async () => { throw new Error('must not be called') },
    })
    const res = await _checkSetup(SCALING(), T, deps)
    assert.equal(res.verdict, 'hold')
    assert.equal(deps.writes[0].orderState, undefined)
})

test('a guard armed at the pending leg counts as the leg printing, even if price has left it', async () => {
    // The sweep proved price reached 236.6 a minute ago; the spot read says 237 now. The crossing
    // that paid for the wake is not thrown away.
    const woke = { price: 236.6, direction: 'any', means: 'entry' }
    const deps = stubDeps({
        getPrice: async () => 237.0,
        assessPosition: async () => ({ verdict: 'add_leg', proposal: { leg: 'ez2' } }),
        buildOrderPlan: async () => [{ accountId: 'a1', quantity: 40 }],
    })
    await _checkSetup(SCALING({ monitor_state: { woke_on: woke, conditions: {}, scenarios: {} } }), T, deps)
    assert.equal(deps.writes[0].orderState, 'awaiting_confirm')
})

test('a guard re-touching a FILLED leg never adds it again', async () => {
    // ez1 is already on. A guard at its level firing is a wake, not a second helping.
    const woke = { price: 238.6, direction: 'any', means: 'entry' }
    const deps = stubDeps({
        getPrice: async () => 238.6,
        assessPosition: async () => ({ verdict: 'add_leg', proposal: { leg: 'ez1' } }),
        buildOrderPlan: async () => { throw new Error('must not be called') },
    })
    const res = await _checkSetup(SCALING({ monitor_state: { woke_on: woke, conditions: {}, scenarios: {} } }), T, deps)
    assert.equal(res.verdict, 'hold')
    assert.equal(deps.writes[0].orderState, undefined)
})

test('a fully-scaled position with plain exits is dormant', async () => {
    const both = SCALING({}, { entry: { fill_price: 236, fill_at: '2026-07-26T09:00:00.000Z', size: 100, direction: 'long',
        legs: [{ leg_id: 'ez1', price: 238.6, quantity: 60 }, { leg_id: 'ez2', price: 236.2, quantity: 40 }] } })
    const res = await _checkSetup(both, T, stubDeps())
    assert.equal(res.reason, 'dormant')
})
