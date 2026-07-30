import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listWatchedItems, DEFAULT_KINDS } from '../../services/watchlist.service.js'

// "What am I watching?" across five kinds in one read.
//
// The behaviours worth pinning are all about being HONEST at the edges: a finished call isn't
// being watched, a retired agent's leftovers aren't either, one desk failing must not silently
// shrink the answer, and enumerating books must not quietly fire a broker round-trip per book.

const NOW = 1_700_000_000_000

const call = (over = {}) => ({ id: 'c1', asset: 'NVDA', bias: 'long', status: 'looking', savedAt: 5, ...over })
const setup = (over = {}) => ({ id: 's1', asset: 'SPY', direction: 'long', status: 'waiting', savedAt: 4, ...over })
const book = (over = {}) => ({ portfolioId: 'p1', name: 'Growth', holdings: 2, savedAt: 3, statuses: { long: 2 }, symbols: ['MSFT'], ...over })
const cov = (over = {}) => ({ id: 'cov1', symbol: 'AVGO', status: 'active', updated_at: '2026-07-20T00:00:00Z', ...over })
const scan = (over = {}) => ({ id: 'sc1', thesis: 'laggards', period: { label: 'Aug' }, savedAt: 1, candidates: [], ...over })

const deps = (over = {}) => ({
    now: NOW,
    calls: async () => [call()],
    setups: async () => [setup()],
    portfolios: async () => [book()],
    coverage: async () => [cov()],
    scans: async () => [scan()],
    ...over,
})

test('one read answers across all five kinds', async () => {
    const res = await listWatchedItems('u1', {}, deps())
    assert.deepEqual(res.counts, { call: 1, setup: 1, portfolio: 1, coverage: 1, scan: 1 })
    assert.equal(res.items.length, 5)
    assert.equal(res.asOf, NOW)
})

test('the default kinds exclude the retired Idea agent’s leftovers', async () => {
    // getIdeas returns holdings AND loose legacy ideas. Reporting one would have Axl offer to route
    // the user to a chat that no longer exists.
    assert.ok(!DEFAULT_KINDS.includes('idea'))
    assert.deepEqual(DEFAULT_KINDS, ['call', 'setup', 'portfolio', 'coverage', 'scan'])
})

test('finished items are history, not something being watched', async () => {
    const res = await listWatchedItems('u1', {}, deps({ calls: async () => [call(), call({ id: 'c2', status: 'closed' })] }))
    assert.equal(res.counts.call, 1)
    assert.ok(!res.items.some(i => i.id === 'c2'))
})

test('...unless the user actually asked for them', async () => {
    const res = await listWatchedItems('u1', { includeFinished: true },
        deps({ calls: async () => [call(), call({ id: 'c2', status: 'closed' })] }))
    assert.equal(res.counts.call, 2)
})

test('kinds with no status of their own are never filtered out as terminal', async () => {
    // A book and a scan report status:null. A naive isTerminal check would drop them both.
    const res = await listWatchedItems('u1', { kinds: ['portfolio', 'scan'] }, deps())
    assert.equal(res.items.length, 2)
})

test('a failed source is NAMED, never reported as nothing', async () => {
    // The whole point of threading onError:'throw' down to the crud. "You have no calls" and
    // "I couldn't read your calls" are different answers to the user.
    const res = await listWatchedItems('u1', {}, deps({ calls: async () => { throw new Error('mongo down') } }))
    assert.deepEqual(res.unavailable, ['call'])
    assert.equal(res.counts.call, undefined)
    assert.equal(res.items.length, 4, 'the other four desks still answer')
})

test('narrowing by kind reads only those sources', async () => {
    let touched = 0
    const res = await listWatchedItems('u1', { kinds: ['call'] },
        deps({ scans: async () => { touched++; return [] } }))
    assert.equal(touched, 0)
    assert.deepEqual(Object.keys(res.counts), ['call'])
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
