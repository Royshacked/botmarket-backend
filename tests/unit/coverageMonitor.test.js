import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _checkCoverage } from '../../monitoring/coverage.monitor.service.js'

// Analyst P5 — the monitor's per-coverage check, with mocked price/consensus/DB (deps injectable).

const cov = (over = {}) => ({
    id: 'cov1', user_id: 'u1', symbol: 'NVDA', rating: 'buy',
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

test('target_hit: updates status + gap + revision, notifies, stops watching (next_check_at null)', async () => {
    const h = harness({ price: 205, consensusPt: 190 })
    const v = await _checkCoverage(h.db, cov(), 0, h.deps)
    assert.equal(v.state, 'target_hit')
    assert.equal(h.updates.length, 1)
    assert.equal(h.updates[0].patch.status, 'target_hit')
    assert.equal(h.updates[0].patch.revision_kind, 'target_hit')
    assert.equal(h.notifies.length, 1)
    // bookkeeping updateOne set next_check_at to null (terminal → stop)
    const book = h.db._updates.at(-1)
    assert.equal(book.u.$set['monitor.next_check_at'], null)
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
    assert.deepEqual(h.db._updates[0].u.$set.gap, { our_pt: 200, consensus_pt: 181, pct: 10.5 })
})

test('thesis_broken: price through the bear case → status thesis_broken + notify', async () => {
    const h = harness({ price: 145, consensusPt: 180 })
    const v = await _checkCoverage(h.db, cov(), 0, h.deps)
    assert.equal(v.state, 'thesis_broken')
    assert.equal(h.updates[0].patch.status, 'thesis_broken')
    assert.equal(h.notifies.length, 1)
})
