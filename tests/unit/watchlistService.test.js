import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listWatchedItems, DEFAULT_KINDS } from '../../services/watchlist.service.js'

// "What am I watching?" across four kinds in one read.
//
// The behaviours worth pinning are all about being HONEST at the edges: a finished setup isn't
// being watched, a retired agent's leftovers aren't either, one desk failing must not silently
// shrink the answer, and enumerating books must not quietly fire a broker round-trip per book.
//
// `call` was the fifth and was the exemplar throughout this file; Kairos was archived on
// 2026-08-18 and the kind went with it. The exemplar is now `setup`, which exercises exactly the
// same paths — every behaviour above is kind-blind, which is the point of listWatchedItems.

const NOW = 1_700_000_000_000

const setup = (over = {}) => ({ id: 's1', asset: 'NVDA', direction: 'long', status: 'looking', savedAt: 4, ...over })
const book = (over = {}) => ({ portfolioId: 'p1', name: 'Growth', holdings: 2, savedAt: 3, statuses: { long: 2 }, symbols: ['MSFT'], ...over })
const cov = (over = {}) => ({ id: 'cov1', symbol: 'AVGO', status: 'active', updated_at: '2026-07-20T00:00:00Z', ...over })
const scan = (over = {}) => ({ id: 'sc1', thesis: 'laggards', period: { label: 'Aug' }, savedAt: 1, candidates: [], ...over })

const deps = (over = {}) => ({
    now: NOW,
    setups: async () => [setup()],
    portfolios: async () => [book()],
    coverage: async () => [cov()],
    scans: async () => [scan()],
    ...over,
})

test('one read answers across all four kinds', async () => {
    const res = await listWatchedItems('u1', {}, deps())
    assert.deepEqual(res.counts, { setup: 1, portfolio: 1, coverage: 1, scan: 1 })
    assert.equal(res.items.length, 4)
    assert.equal(res.asOf, NOW)
})

test('the default kinds exclude the retired Idea agent’s leftovers', async () => {
    // getIdeas returns holdings AND loose legacy ideas. Reporting one would have Axl offer to route
    // the user to a chat that no longer exists.
    assert.ok(!DEFAULT_KINDS.includes('idea'))
    // And `call` left for the same reason on 2026-08-18: Kairos is archived, so a listed call
    // would offer the user a door into a desk that is not there.
    assert.ok(!DEFAULT_KINDS.includes('call'))
    assert.deepEqual(DEFAULT_KINDS, ['setup', 'portfolio', 'coverage', 'scan'])
})

test('finished items are history, not something being watched', async () => {
    const res = await listWatchedItems('u1', {}, deps({ setups: async () => [setup(), setup({ id: 's2', status: 'closed' })] }))
    assert.equal(res.counts.setup, 1)
    assert.ok(!res.items.some(i => i.id === 's2'))
})

test('...unless the user actually asked for them', async () => {
    const res = await listWatchedItems('u1', { includeFinished: true },
        deps({ setups: async () => [setup(), setup({ id: 's2', status: 'closed' })] }))
    assert.equal(res.counts.setup, 2)
})

test('kinds with no status of their own are never filtered out as terminal', async () => {
    // A book and a scan report status:null. A naive isTerminal check would drop them both.
    const res = await listWatchedItems('u1', { kinds: ['portfolio', 'scan'] }, deps())
    assert.equal(res.items.length, 2)
})

test('a failed source is NAMED, never reported as nothing', async () => {
    // The whole point of threading onError:'throw' down to the crud. "You have no setups" and
    // "I couldn't read your setups" are different answers to the user.
    const res = await listWatchedItems('u1', {}, deps({ setups: async () => { throw new Error('mongo down') } }))
    assert.deepEqual(res.unavailable, ['setup'])
    assert.equal(res.counts.setup, undefined)
    assert.equal(res.items.length, 3, 'the other three desks still answer')
})

test('narrowing by kind reads only those sources', async () => {
    let touched = 0
    const res = await listWatchedItems('u1', { kinds: ['setup'] },
        deps({ scans: async () => { touched++; return [] } }))
    assert.equal(touched, 0)
    assert.deepEqual(Object.keys(res.counts), ['setup'])
})

test('narrowing by symbol drops rows on other names', async () => {
    const res = await listWatchedItems('u1', { symbol: 'NVDA' }, deps())
    assert.ok(res.items.every(i => i.symbol === 'NVDA'))
    assert.equal(res.counts.portfolio, 0, 'a book has no symbol, so it cannot match one')
})

test('a mixed list comes back newest-first across kinds', async () => {
    const res = await listWatchedItems('u1', {}, deps())
    const stamps = res.items.map(i => i.updatedAt ?? 0)
    assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a))
})

test('enumerating books never prices them — no broker fan-out behind one question', async () => {
    // computePortfolioState costs a broker getPositions + FMP round-trip PER BOOK, so reaching for
    // it inside a list would put N of them behind one chat message. The guarantee is structural:
    // the enumeration is read exactly once and nothing else is consulted per book, so a priced
    // field could not appear on a row even if someone added the call later.
    let reads = 0
    const res = await listWatchedItems('u1', { kinds: ['portfolio'] }, deps({
        portfolios: async () => { reads++; return [book(), book({ portfolioId: 'p2', name: 'Income' })] },
    }))
    assert.equal(reads, 1, 'one enumeration, not one read per book')
    assert.equal(res.counts.portfolio, 2)
    for (const rowOut of res.items) {
        assert.deepEqual(Object.keys(rowOut.detail).sort(), ['byStatus', 'holdings', 'symbols'],
            'a book row carries only what the enumeration already knew — no pnl, no weights')
    }
})

test('no user means an empty answer, without touching a single source', async () => {
    let touched = 0
    const res = await listWatchedItems(null, {}, deps({ calls: async () => { touched++; return [] } }))
    assert.equal(touched, 0)
    assert.deepEqual(res.items, [])
})
