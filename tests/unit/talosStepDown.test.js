import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ripeStepDown } from '../../monitoring/talos.gates.js'
import { clampGuards, normalizeSetup } from '../../services/setup.schema.js'
import { _checkSetup } from '../../monitoring/talos.monitor.service.js'

// THE STEP-DOWN (talos.gates ripeStepDown). A `wait` whose only missing piece is the trigger is
// "ripe": the next look moves to the setup's FINEST rung, on its very next close, with an entry
// guard at the level. EXPD (2026-10-19) is the case: ripe on a 4hr rung with 2hr allowed, no entry
// guard, so the pullback to 196 printed (low 196.00) and nothing woke until noon the next day.

const EXPD = {
    id: 'setup_EXPD_1', kind: 'setup', asset: 'EXPD', asset_class: 'stock', direction: 'long',
    type: 'swing', timeframe: 'day', pace_rungs: ['day', '4hr', '2hr'],
    scenarios: [{
        id: 's3', entry_legs: [{ id: 's3e1', price: 196, quantity: 16 }],
        stop_legs: [{ id: 's3s1', price: 190.01 }], target_legs: [{ id: 's3t1', price: 207.14 }],
        conditions: [{ id: 's3c1', text: 'A daily close above 195.73 is followed by a 4hr retest that holds above 195.73.', weight: 'primary', mode: 'measured' }],
    }],
}
const S3 = EXPD.scenarios[0]
const RIPE = { verdict: 'wait', premise: 'intact', ripe: true }

test('a ripe wait: the finest rung, the next close, and an entry guard at the level', () => {
    const r = ripeStepDown(EXPD, S3, RIPE, [], 197.6)
    assert.equal(r.rung, '2hr', 'pace_rungs run coarse → fine; the last is the finest')
    assert.equal(r.expensiveDue, 1)
    assert.deepEqual(r.guards, [{ price: 196, direction: 'below', means: 'entry' }],
        'price is above the level, so it waits for the pullback')
    assert.equal(r.level, 196)
})

test('below the level the guard waits for the break instead', () => {
    const r = ripeStepDown(EXPD, S3, RIPE, [], 195.2)
    assert.deepEqual(r.guards, [{ price: 196, direction: 'above', means: 'entry' }])
})

test('price ON the level: no guard — it is already true, and re-arming it would pay for a read every sweep', () => {
    const r = ripeStepDown(EXPD, S3, RIPE, [], 196)
    assert.deepEqual(r.guards, [])
    assert.equal(r.rung, '2hr', 'the step-down itself still happens')
})

test('the read\'s own entry guard at the level is kept, not doubled; its other guards follow', () => {
    const own = clampGuards([{ price: 196, direction: 'below', means: 'entry' }, { price: 190.01, direction: 'below', means: 'invalidation' }], 197.6)
    const r = ripeStepDown(EXPD, S3, RIPE, own, 197.6)
    assert.deepEqual(r.guards, own)
})

test('the added entry guard goes first, so the guard cap can never squeeze it out', () => {
    const many = clampGuards([200, 201, 202, 203, 204, 205].map(p => ({ price: p, direction: 'above', means: 'manage' })), 197.6)
    const r = ripeStepDown(EXPD, S3, RIPE, many, 197.6)
    assert.equal(r.guards[0].price, 196)
    assert.equal(r.guards[0].means, 'entry')
    assert.ok(r.guards.length <= 6, 'inside the cap')
})

test('not ripe, not a wait, or a hurt premise → null: the read\'s own pacing stands', () => {
    assert.equal(ripeStepDown(EXPD, S3, { verdict: 'wait', premise: 'intact' }, [], 197.6), null)
    assert.equal(ripeStepDown(EXPD, S3, { ...RIPE, ripe: 'yes' }, [], 197.6), null, 'only a real true')
    assert.equal(ripeStepDown(EXPD, S3, { ...RIPE, verdict: 'enter' }, [], 197.6), null)
    assert.equal(ripeStepDown(EXPD, S3, { ...RIPE, verdict: 'stand_aside' }, [], 197.6), null)
    assert.equal(ripeStepDown(EXPD, S3, { ...RIPE, premise: 'damaged' }, [], 197.6), null)
    assert.equal(ripeStepDown(EXPD, S3, { ...RIPE, premise: 'stale' }, [], 197.6), null)
})

test('an entry with no price (a trigger in words) still steps down, with no guard to arm', () => {
    const words = { ...S3, entry_legs: [{ id: 'w1', price: null, trigger: 'a bullish engulfing on the 2hr' }] }
    const r = ripeStepDown(EXPD, words, RIPE, [], 197.6)
    assert.equal(r.rung, '2hr')
    assert.deepEqual(r.guards, [])
    assert.equal(r.level, null)
})

// ─── Through the monitor ──────────────────────────────────────────────────────

const T = Date.parse('2026-10-19T17:30:30Z')   // 13:30 ET, the close the retest bar printed on

function deps(assess) {
    const writes = [], entries = []
    return {
        isAssetOpen: () => true,
        nextCandleCloseMs: (_s, _c, _rung, now) => now + 3600_000,
        getPrice: async () => 197.6,
        assess,
        cheapTier: () => false,
        cheapRead: async () => { throw new Error('the cheap tier is off') },
        buildOrderPlan: async () => [],
        onCard: async () => {}, onManualCard: async () => {}, onEditCard: async () => {}, onInvalidation: async () => {},
        getClose: async () => null, getFillPrice: async () => null,
        writes, entries,
        persist: async (_id, $set, entry = null) => { writes.push($set); entries.push(entry) },
    }
}

// Built through normalizeSetup like talosMonitor.test.js's fixtures: the persisted projection, not a
// hand-written one that could drift from what the service stores.
const LIVE = {
    id: 'setup_EXPD_1', kind: 'setup', status: 'looking', armed_leg_id: null, armed_scenario_id: null,
    ...normalizeSetup({
        asset: 'EXPD', asset_class: 'stock', direction: 'long', type: 'swing', trade_mode: 'smc',
        timeframe: 'day', pace_rungs: ['day', '4hr', '2hr'],
        entry_legs: S3.entry_legs, stop_legs: S3.stop_legs, target_legs: S3.target_legs, conditions: S3.conditions,
    }),
    broker: 'paper', accounts: ['a1'], mainAccountId: 'a1', quantity: 16, valid_until: null,
    monitor_state: { timeframe: '4hr', last_assessment: { at: 'earlier' }, expensive_due: 0, conditions: {}, scenarios: {} },
}

test('monitor: a ripe wait on a 4hr setup writes the 2hr rung, a read next close and the entry guard', async () => {
    const d = deps(async () => ({ verdict: 'wait', premise: 'intact', ripe: true, read: 'Holding above; only the pullback to 196 is left.',
        next_timeframe: '4hr', next_expensive_in: 3, guards: [{ price: 190.01, direction: 'below', means: 'invalidation' }] }))
    const res = await _checkSetup(LIVE, T, d)
    const $set = d.writes.at(-1)
    assert.ok($set, JSON.stringify(res))
    assert.equal($set['monitor_state.timeframe'], '2hr', 'not the 4hr the read asked for')
    assert.equal($set['monitor_state.expensive_due'], 1, 'not the 3 closes it asked for')
    assert.deepEqual($set['monitor_state.guards'][0], { price: 196, direction: 'below', means: 'entry' })
    assert.ok($set['monitor_state.guards'].some(g => g.means === 'invalidation'), 'its own guard survives')
    assert.equal($set['monitor_state.last_assessment'].ripe, true)
    assert.equal(d.entries.at(-1).ripe, true, 'and the journal says why the pace changed')
})

test('monitor: a plain wait keeps the pace the read asked for', async () => {
    const d = deps(async () => ({ verdict: 'wait', premise: 'intact', read: 'Nothing yet.', next_timeframe: '4hr', next_expensive_in: 3, guards: [] }))
    await _checkSetup(LIVE, T, d)
    const $set = d.writes.at(-1)
    assert.equal($set['monitor_state.timeframe'], '4hr')
    assert.equal($set['monitor_state.expensive_due'], 3)
    assert.deepEqual($set['monitor_state.guards'], [])
    assert.equal($set['monitor_state.last_assessment'].ripe, false)
})
