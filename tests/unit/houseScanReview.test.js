import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runHouseScan, REJECTED_DAYS } from '../../services/houseScan.service.js'
import { _bookAddGate } from '../../api/trade-ideas/tradeIdeas.controller.js'

// Code review 2026-10-11: the house scan does not buy back names passed on recently, and a rerun of a finished week
// stays inside the week's ceiling; an edit-mode add to a book goes through the house's limits.

const NOW = Date.parse('2026-10-11T12:00:00Z')
const deps = (over = {}) => {
    const queued = []
    return {
        queued,
        deps: {
            covered: async () => new Set(),
            sub: async (code) => ({ code }),
            candidates: async () => ({ rows: ['NUE', 'STLD', 'CLF', 'X', 'CMC'].map(symbol => ({ symbol, covered: false })), total: 5 }),
            // The code order (Argus's fallback) — what the test is about is the queue's rules, not his choice.
            pick: async ({ rows, max }) => ({ picks: rows.slice(0, max).map(r => ({ symbol: r.symbol })), source: 'code' }),
            attachPicks: async () => ({ attached: true }),
            theme: async () => null,
            assessment: async () => ({ subject: { name: 'Steel' }, verdict: 'swing', thesis: 't', risks: [] }),
            enqueue: async (row) => { queued.push(row); return { ok: true } },
            rejected: async () => [
                { symbol: 'NUE', updated_at: '2026-10-01T00:00:00Z' },                  // ten days ago: still out
                { symbol: 'STLD', updated_at: new Date(NOW - (REJECTED_DAYS + 1) * 86_400_000).toISOString() },   // long ago: back in
            ],
            perIndustry: () => 3, weeklyMax: () => 30,
            ...over,
        },
    }
}
const week = [{ kind: 'industry', code: '11', name: 'Steel', outcome: 'published', verdict: 'swing' }]

test('a name passed on in the last eight weeks is not queued again; an older rejection is', async () => {
    const { queued, deps: d } = deps()
    await runHouseScan(week, d, { now: NOW })
    assert.deepEqual(queued.map(q => q.symbol), ['STLD', 'CLF', 'X'])
})

test("a rerun of a finished week counts what the week already queued against its ceiling", async () => {
    const { queued, deps: d } = deps({ weeklyMax: () => 30 })
    const r = await runHouseScan(week, d, { now: NOW, alreadyQueued: 29 })
    assert.equal(r.queued.length, 1)
    assert.equal(queued.length, 1)
})

test('an edit-mode add to a book goes through the limits: Avoid needs the named OK, hype halves', async () => {
    const views = async () => ({ XOM: { code: 'oil', name: 'Oil', assessment: { verdict: 'avoid' } }, NVDA: { code: 'semis', assessment: { hype: true } }, MSFT: { code: 'sw' } })
    const book = { siblings: async () => [{ asset: 'MSFT', allocationRatio: 0.8, status: 'waiting' }, { asset: 'OLD', allocationRatio: 0.5, status: 'closed' }], mandate: async () => null, views }
    const refused = await _bookAddGate({ asset: 'XOM', portfolioId: 'p1', allocationRatio: 0.1 }, 'u1', book)
    assert.equal(refused.reason, 'avoid_industry')
    assert.deepEqual(refused.avoid, [{ asset: 'XOM', industry: 'Oil' }])
    assert.equal((await _bookAddGate({ asset: 'XOM', portfolioId: 'p1', allocationRatio: 0.1, avoid_ok: ['XOM'] }, 'u1', book)).ok, true)
    assert.equal((await _bookAddGate({ asset: 'NVDA', portfolioId: 'p1', allocationRatio: 0.2 }, 'u1', book)).allocationRatio, 0.1)
})
