import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getUpcomingEvents, symbolsFromWatched } from '../../services/upcomingEvents.service.js'

// "Anything coming up?" — and the reason this service exists at all: the JOIN from the user's own
// names to the earnings calendar happens HERE, in code. Left to the agent it becomes a two-hop
// chain (list items → extract symbols → call the calendar) that a model half-completes, and a join
// is a computation, not a judgment.

const NOW = Date.parse('2026-07-30T12:00:00Z')
const TODAY = '2026-07-30'

const watchedItems = [
    { kind: 'call', symbol: 'NVDA', detail: {} },
    { kind: 'coverage', symbol: 'AVGO', detail: {} },
    { kind: 'portfolio', symbol: null, detail: { symbols: ['MSFT', 'NVDA'] } },
    { kind: 'scan', symbol: null, detail: {} },
]

const deps = (over = {}) => ({
    now: NOW,
    watched: async () => ({ items: watchedItems }),
    earningsRaw: async (_f, _t, symbols) => (symbols.length
        ? symbols.map(s => ({ symbol: s, date: '2026-08-05', epsEstimated: 1 }))
        : [{ symbol: 'RANDOM', date: '2026-08-05' }, { symbol: 'OTHER', date: '2026-08-06' }]),
    fed: async () => ({ items: [{ date: '2026-08-12', event: 'CPI', impact: 'high' }] }),
    ...over,
})

test('symbols come from the rows AND from inside each book', () => {
    // A holding's name lives in the book row's detail — without it, "what's coming up on my
    // holdings" would silently cover only calls and coverage.
    assert.deepEqual(symbolsFromWatched(watchedItems).sort(), ['AVGO', 'MSFT', 'NVDA'])
})

test('symbols are de-duplicated and uppercased', () => {
    assert.deepEqual(symbolsFromWatched([{ symbol: 'nvda' }, { symbol: 'NVDA' }]), ['NVDA'])
})

test("'mine' joins earnings to the user's own names, server-side", async () => {
    const res = await getUpcomingEvents('u1', {}, deps())
    assert.equal(res.scope, 'mine')
    assert.deepEqual(res.symbols.sort(), ['AVGO', 'MSFT', 'NVDA'])
    assert.ok(res.earnings.every(e => res.symbols.includes(e.symbol)))
    assert.ok(!res.earnings.some(e => e.symbol === 'RANDOM'), 'no unrelated tickers reach the answer')
})

test("'market' does not filter", async () => {
    const res = await getUpcomingEvents('u1', { scope: 'market' }, deps())
    assert.equal(res.scope, 'market')
    assert.ok(res.earnings.some(e => e.symbol === 'RANDOM'))
    assert.deepEqual(res.symbols, [], 'nothing was resolved because nothing needed to be')
})

test('a personal scope with no names answers with NO earnings, not everyone’s', async () => {
    // The trap: an empty symbol list falls through to market-wide in the provider, which is the
    // opposite of what was asked. Guarded before the call rather than filtered after.
    const res = await getUpcomingEvents('u1', {}, deps({ watched: async () => ({ items: [] }) }))
    assert.deepEqual(res.earnings, [])
    assert.deepEqual(res.symbols, [])
})

test('Fed rows are never symbol-joined — a rate decision is everyone’s event', async () => {
    const res = await getUpcomingEvents('u1', {}, deps({ watched: async () => ({ items: [] }) }))
    assert.equal(res.fed.length, 1)
    assert.equal(res.fed[0].event, 'CPI')
})

test('the Fed feed is trimmed to the window that was asked for', async () => {
    // The provider works to its own 45-day horizon; "anything this week?" must not answer with
    // next month's meeting.
    const res = await getUpcomingEvents('u1', { from: TODAY, to: '2026-08-01' }, deps())
    assert.deepEqual(res.fed, [])
})

test('the window defaults to the next 30 days from today', async () => {
    const res = await getUpcomingEvents('u1', {}, deps())
    assert.equal(res.from, TODAY)
    assert.equal(res.to, '2026-08-29')
})

test('an explicit window is passed straight through to the provider', async () => {
    let seen = null
    await getUpcomingEvents('u1', { from: '2026-09-01', to: '2026-09-30' },
        deps({ earningsRaw: async (f, t) => { seen = [f, t]; return [] } }))
    assert.deepEqual(seen, ['2026-09-01', '2026-09-30'])
})

test('one feed failing does not cost the other', async () => {
    const res = await getUpcomingEvents('u1', {}, deps({ earningsRaw: async () => { throw new Error('fmp down') } }))
    assert.deepEqual(res.unavailable, ['earnings'])
    assert.equal(res.fed.length, 1)
})

test('failing to resolve the user’s names is reported, not treated as "no names"', async () => {
    const res = await getUpcomingEvents('u1', {}, deps({ watched: async () => { throw new Error('down') } }))
    assert.ok(res.unavailable.includes('symbols'))
})
