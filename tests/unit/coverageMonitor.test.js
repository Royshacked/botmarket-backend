import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _checkCoverage, _runRemodels } from '../../monitoring/coverage.monitor.service.js'

// Analyst P5 — the monitor's per-coverage check, with mocked price/consensus/DB (deps injectable).

const cov = (over = {}) => ({
    id: 'cov1', userId: 'u1', symbol: 'NVDA', rating: 'buy',
    price_target: { value: 200 },
    gap: { our_pt: 200, consensus_pt: 180, pct: 11.11 },
    risk_reward: { bull: 240, base: 200, bear: 150 },
    ...over,
})

// mock db that records collection().updateOne calls
function harness({ price, consensusPt }) {
    const db = { _updates: [], collection: () => ({ updateOne: async (q, u) => { db._updates.push({ q, u }) } }) }
    const updates = []
    const notifies = []
    const deps = {
        getPrice:       async () => price,
        getConsensusPt: async () => consensusPt,
        updateCoverage: async (id, patch, userId, isAdmin) => { updates.push({ id, patch, userId, isAdmin }); return { ok: true } },
        notify:         (c, v) => notifies.push({ symbol: c.symbol, state: v.state }),
    }
    return { db, deps, updates, notifies }
}

test('target_hit: updates status + gap + revision, notifies, and KEEPS watching', async () => {
    const h = harness({ price: 205, consensusPt: 190 })
    const v = await _checkCoverage(h.db, cov(), 0, h.deps)
    assert.equal(v.state, 'target_hit')
    assert.equal(h.updates.length, 1)
    assert.equal(h.updates[0].patch.status, 'target_hit')
    assert.equal(h.updates[0].patch.revision_kind, 'target_hit')
    assert.equal(h.notifies.length, 1)
    // Hitting our target ends nothing — it prompts the next question (harvest? re-model?).
    const book = h.db._updates.at(-1)
    assert.equal(book.u.$set['monitor.next_check_at'], '1970-01-02T00:00:00.000Z')
})

test('validating: updates gap + revision (status unchanged), notifies, stays active (next_check_at set)', async () => {
    const h = harness({ price: 190, consensusPt: 195 })   // 180→195 up → validating
    const v = await _checkCoverage(h.db, cov(), 0, h.deps)
    assert.equal(v.state, 'validating')
    assert.equal(h.updates.length, 1)
    assert.equal('status' in h.updates[0].patch, false)   // signal, not terminal
    assert.equal(h.updates[0].patch.revision_kind, 'validating')
    assert.equal(h.notifies.length, 1)
    assert.equal(h.db._updates.at(-1).u.$set['monitor.next_check_at'], '1970-01-02T00:00:00.000Z')  // +1 day from 0
})

test('stable: refreshes gap + bookkeeping ONLY — no revision (no updateCoverage), no notify', async () => {
    const h = harness({ price: 190, consensusPt: 181 })   // 0.55% move → stable
    const v = await _checkCoverage(h.db, cov(), 0, h.deps)
    assert.equal(v.state, 'stable')
    assert.equal(h.updates.length, 0)     // no revision-appending update
    assert.equal(h.notifies.length, 0)    // quiet
    // single direct db write with the refreshed gap + next check
    assert.equal(h.db._updates.length, 1)
    assert.deepEqual(h.db._updates[0].u.$set.gap,
        { our_pt: 200, consensus_pt: 181, pct: 10.5, low: null, high: null, median: null, pctile: null })
})

test('the Street distribution is stored whole when the provider returns it', async () => {
    const h = harness({ price: 190, consensusPt: { consensus: 181, low: 150, high: 250, median: 180 } })
    await _checkCoverage(h.db, cov(), 0, h.deps)
    const gap = h.db._updates[0].u.$set.gap
    assert.deepEqual([gap.low, gap.high, gap.median], [150, 250, 180])
    assert.equal(gap.pctile, 50)   // our 200 sits mid-range of 150–250
})

test('price through the old "bear case" is a quiet tick — no kill, no card', async () => {
    const h = harness({ price: 145, consensusPt: 180 })   // 145 ≤ bear 150 — used to be thesis_broken
    const v = await _checkCoverage(h.db, cov(), 0, h.deps)
    assert.equal(v.state, 'stable')
    assert.equal(h.updates.length, 0)
    assert.equal(h.notifies.length, 0)
})

// Nothing terminal stops the loop now, so a price parked above our PT must not re-fire daily.
test('target_hit already recorded → refreshed quietly, no second revision or card', async () => {
    const h = harness({ price: 205, consensusPt: 190 })
    const v = await _checkCoverage(h.db, cov({ status: 'target_hit' }), 0, h.deps)
    assert.equal(v.state, 'target_hit')
    assert.equal(v.applied, false)
    assert.equal(h.updates.length, 0)
    assert.equal(h.notifies.length, 0)
    assert.equal(h.db._updates.length, 1)   // bookkeeping only
})

// ── the expensive tier: the re-model decision rides the same daily fetch ─────
test('the edge category + next re-model date are persisted on every tick', async () => {
    const h = harness({ price: 190, consensusPt: { consensus: 181, low: 150, high: 250, median: 180 } })
    await _checkCoverage(h.db, cov({ catalysts: [{ date: '2030-05-01' }] }), 0, h.deps)
    const set = h.db._updates[0].u.$set
    assert.equal(set['monitor.edge_category'], 'contained')       // our 200 sits inside 150–250
    assert.equal(set['monitor.next_remodel_at'], '2030-05-02T00:00:00.000Z')
})

test('a quiet DAY still reports the re-model decision — a quarter is not a day', async () => {
    const h = harness({ price: 190, consensusPt: 181 })           // stable tick
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()
    const res = await _checkCoverage(h.db, cov({ created_at: old }), Date.now(), h.deps)
    assert.equal(res.state, 'stable')
    assert.equal(res.remodel.due, true)                           // the floor expired regardless
    assert.match(res.remodel.reason, /no re-model in/)
})

test('a failed thesis write reports no re-model — an unrecordable run would repeat every tick', async () => {
    const h = harness({ price: 190, consensusPt: 195 })
    h.deps.updateCoverage = async () => ({ ok: false, reason: 'forbidden' })
    const res = await _checkCoverage(h.db, cov(), 0, h.deps)
    assert.equal(res.remodel, undefined)
})

test('a watched thesis is always re-scheduled — even after target_hit', async () => {
    const h = harness({ price: 205, consensusPt: 190 })
    await _checkCoverage(h.db, cov(), 0, h.deps)
    assert.equal(h.db._updates.at(-1).u.$set['monitor.next_check_at'], '1970-01-02T00:00:00.000Z')
})

// Regression: a dead price feed must be a QUIET tick, not a book-wide kill. This is the shape the
// real outage took — getPrice returning null on every symbol, every tick.
test('a null price is a stable tick — no status change, no card', async () => {
    const h = harness({ price: null, consensusPt: 180 })
    const v = await _checkCoverage(h.db, cov(), 0, h.deps)
    assert.equal(v.state, 'stable')
    assert.equal(h.updates.length, 0)
    assert.equal(h.notifies.length, 0)
})

// A card that claims a thesis broke, over a doc that still says active, is worse than no card.
test('a failed thesis write suppresses the card AND the bookkeeping (retry next tick)', async () => {
    const h = harness({ price: 190, consensusPt: 195 })   // 180→195 → validating
    h.deps.updateCoverage = async () => ({ ok: false, reason: 'forbidden' })
    const v = await _checkCoverage(h.db, cov(), 0, h.deps)
    assert.equal(v.state, 'validating')
    assert.equal(v.applied, false)
    assert.equal(h.notifies.length, 0)
    assert.equal(h.db._updates.length, 0)   // still due → re-checked next tick
})

// ── re-model dispatch: the cap, the priority, and the pre-stamp ───────────────

function remodelHarness({ heldSymbols = [] } = {}) {
    const db = { _updates: [], collection: () => ({ updateOne: async (q, u) => { db._updates.push({ q, u }) } }) }
    const ran = []
    const deps = {
        getHeldSymbols: async () => new Set(heldSymbols),
        remodel: async (c, reason) => { ran.push({ symbol: c.symbol, reason }) },
    }
    return { db, deps, ran }
}
const cand = (symbol, reason = 'floor') => ({ cov: { id: `cov_${symbol}`, symbol, userId: 'u1' }, reason })

test('re-models are capped per tick, and the deferred ones are never silently dropped', async () => {
    const h = remodelHarness()
    await _runRemodels(h.db, ['A', 'B', 'C', 'D', 'E'].map(s => cand(s)), h.deps)
    assert.equal(h.ran.length, 3)                       // MAX_REMODELS_PER_TICK
    // The two left over got no stamp either, so they stay due and land on a later tick.
    assert.equal(h.db._updates.length, 3)
})

test('held names take the scarce slots first', async () => {
    const h = remodelHarness({ heldSymbols: ['D', 'E'] })
    await _runRemodels(h.db, ['A', 'B', 'C', 'D', 'E'].map(s => cand(s)), h.deps)
    const ran = h.ran.map(r => r.symbol)
    assert.ok(ran.includes('D') && ran.includes('E'), `held names must run, got ${ran}`)
    assert.equal(ran.length, 3)
})

test('the stamp lands BEFORE the run — an hourly tick must not start a second run mid-flight', async () => {
    const h = remodelHarness()
    const order = []
    h.deps.remodel = async () => { order.push('run') }
    const realDb = { collection: () => ({ updateOne: async () => { order.push('stamp') } }) }
    await _runRemodels(realDb, [cand('A')], h.deps)
    assert.deepEqual(order, ['stamp', 'run'])
})

test('a re-model that throws is contained — the rest of the tick still runs', async () => {
    const h = remodelHarness()
    h.deps.remodel = async (c) => { if (c.symbol === 'A') throw new Error('LLM timeout'); h.ran.push({ symbol: c.symbol }) }
    await _runRemodels(h.db, [cand('A'), cand('B')], h.deps)
    assert.deepEqual(h.ran.map(r => r.symbol), ['B'])
})

test('the ownership key is user-scoped — one user\'s holdings cannot prioritise another\'s research', async () => {
    const h = remodelHarness({ heldSymbols: ['A'] })
    h.deps.getHeldSymbols = async (userId) => new Set(userId === 'u1' ? ['A'] : [])
    const candidates = [
        { cov: { id: 'c1', symbol: 'A', userId: 'u2' }, reason: 'floor' },   // u2 does NOT hold A
        { cov: { id: 'c2', symbol: 'B', userId: 'u1' }, reason: 'floor' },
    ]
    await _runRemodels(h.db, candidates, h.deps)
    assert.equal(h.ran.length, 2)   // both fit under the cap; the point is no crash + no cross-user credit
})
