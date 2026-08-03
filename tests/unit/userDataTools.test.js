import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    makeUserDataHandlers, USER_DATA_TOOL_SPEC,
    formatWatchedItems, formatPerformance, formatUpcomingEvents,
} from '../../services/userData.tools.js'
import { isToolError } from '../../services/toolResult.util.js'

// The ADAPTER layer: structured rows in, compact text out. It must not query anything, and it must
// never turn a failed read into a confident "you have nothing" — that sentence, said wrongly, is
// worse than no answer at all.

const row = (over = {}) => ({ kind: 'call', id: 'c1', symbol: 'NVDA', title: 'reclaim', direction: 'long', status: 'looking', updatedAt: 5, detail: { rr: 2.4, nearestEntry: { low: 170, high: 172 }, entryZones: 1 }, ...over })

// ─── formatting ───────────────────────────────────────────────────────────────

test('an empty book reads as "nothing yet"', () => {
    const out = formatWatchedItems({ items: [], counts: {}, unavailable: [] })
    assert.match(out, /Nothing in the app yet/)
})

test('a FAILED read never reads as "nothing" — the distinction the whole chain exists for', () => {
    const out = formatWatchedItems({ items: [], counts: {}, unavailable: ['call', 'setup'] })
    assert.doesNotMatch(out, /Nothing in the app yet/)
    assert.match(out, /Could not read: call, setup/)
    assert.match(out, /rather than saying they have nothing/)
})

test('a partial failure is flagged even when other kinds answered', () => {
    const out = formatWatchedItems({ items: [row()], counts: { call: 1 }, unavailable: ['scan'] })
    assert.match(out, /NVDA/)
    assert.match(out, /Could not read: scan/)
})

test('detail is separated from status, and vanishes cleanly when there is none', () => {
    // The first cut ran them together — "· lookingentry 170–172" — because the leading separator
    // was a '' that filter(Boolean) then dropped. Both halves matter: a separator when there IS
    // detail, and no dangling one when there isn't.
    const withDetail = formatWatchedItems({ items: [row()], counts: { call: 1 } })
    assert.match(withDetail, /· looking · entry 170–172/)

    const bare = formatWatchedItems({ items: [row({ detail: {} })], counts: { call: 1 } })
    assert.match(bare, /NVDA long · looking — reclaim$/m)
    assert.doesNotMatch(bare, /· *$/m, 'no separator left hanging at the end of a line')
})

// Without the id the model can only name a symbol, and "edit that coverage" has to become a route
// to Prometheus — which opens a BLANK research chat on a name already covered. The id in the bracket
// is what lets Axl say `<edit>coverage <id></edit>` and reopen the thesis that exists.
test('every row leads with its id — the handle the edit hand-off is built on', () => {
    const out = formatWatchedItems({
        items: [
            row({ kind: 'call', id: 'c1' }),
            row({ kind: 'coverage', id: 'cov_9', symbol: 'ZTS', status: 'active', detail: { rating: 'buy', ourPT: 210 } }),
            row({ kind: 'scan', id: 'sc3', symbol: null, title: 'laggards', status: null, detail: { candidates: 4 } }),
        ],
        counts: { call: 1, coverage: 1, scan: 1 },
    })
    assert.match(out, /\[call:c1\] NVDA/)
    assert.match(out, /\[coverage:cov_9\] ZTS/)
    assert.match(out, /\[scan:sc3\] laggards/)
})

test('a row with no id still renders — a missing handle costs the edit, not the answer', () => {
    const out = formatWatchedItems({ items: [row({ id: null })], counts: { call: 1 } })
    assert.match(out, /\[call\] NVDA/)
})

test('the summary line counts what was found', () => {
    const out = formatWatchedItems({ items: [row()], counts: { call: 1, setup: 2 }, unavailable: [] })
    assert.match(out, /1 call, 2 setups/)
})

test('a book renders as a book — holdings and names, not a ticker', () => {
    const out = formatWatchedItems({
        items: [row({ kind: 'portfolio', symbol: null, title: 'Growth', status: null, detail: { holdings: 2, byStatus: { long: 2 }, symbols: ['NVDA', 'MSFT'] } })],
        counts: { portfolio: 1 },
    })
    assert.match(out, /\[book:c1\] Growth/)
    assert.match(out, /2 holdings/)
    assert.match(out, /NVDA, MSFT/)
})

test('a stale scan says so — that is the only thing a scan has to report', () => {
    const out = formatWatchedItems({
        items: [row({ kind: 'scan', symbol: null, title: 'laggards', status: null, detail: { candidates: 7, stale: true, period: 'Aug' } })],
        counts: { scan: 1 },
    })
    assert.match(out, /STALE/)
    assert.match(out, /7 candidates/)
})

test('performance states outright that the rates are already percentages', () => {
    // The model is one careless multiply away from reporting 62% as 6200%.
    const out = formatPerformance({
        realized: { overall: { count: 10, winRatePct: 62, netPnl: 100 }, byMode: {}, byOrigin: {}, bySymbol: {} },
        calls: null, filter: {},
    })
    assert.match(out, /62% win/)
    assert.match(out, /PERCENTAGES already/)
})

test('no closed trades reads as no record, not as a zero win rate', () => {
    const out = formatPerformance({ realized: { overall: { count: 0 }, byMode: {}, byOrigin: {}, bySymbol: {} }, calls: null })
    assert.match(out, /No closed trades on record/)
    assert.doesNotMatch(out, /0% win/)
})

test('only the busiest symbols reach the answer — the full table stays in the data', () => {
    const bySymbol = Object.fromEntries('ABCDEFGH'.split('').map((s, i) => [s, { count: i + 1, winRatePct: 50 }]))
    const out = formatPerformance({ realized: { overall: { count: 36, winRatePct: 50, netPnl: 1 }, byMode: {}, byOrigin: {}, bySymbol }, calls: null })
    assert.match(out, /by symbol:/)
    assert.equal((out.match(/\d+×\//g) ?? []).length, 5)
})

test('a personal calendar with no names says why it is empty', () => {
    const out = formatUpcomingEvents({ from: 'a', to: 'b', scope: 'mine', symbols: [], earnings: [], fed: [] })
    assert.match(out, /no names in the app/)
})

test('the calendar names which symbols it actually covered', () => {
    const out = formatUpcomingEvents({ from: 'a', to: 'b', scope: 'mine', symbols: ['NVDA'], earnings: [{ date: 'd', symbol: 'NVDA' }], fed: [] })
    assert.match(out, /NVDA/)
})

// ─── handlers ─────────────────────────────────────────────────────────────────

const handlers = (over = {}) => makeUserDataHandlers('u1', {
    watched: async () => ({ items: [row()], counts: { call: 1 }, unavailable: [] }),
    performance: async () => ({ realized: { overall: { count: 1, winRatePct: 100, netPnl: 5 }, byMode: {}, byOrigin: {}, bySymbol: {} }, calls: null, filter: {}, unavailable: [] }),
    events: async () => ({ from: 'a', to: 'b', scope: 'mine', symbols: [], earnings: [], fed: [], unavailable: [] }),
    ...over,
})

test('handlers return TEXT, not an object graph', async () => {
    // The adapter's whole job. A raw object here would push a call's full detail tree at the model.
    for (const name of ['get_watched_items', 'get_performance', 'get_upcoming_events']) {
        const out = await handlers()[name]({})
        assert.equal(typeof out, 'string', name)
    }
})

test('a throwing read becomes a toolError the model can act on', async () => {
    const out = await handlers({ watched: async () => { throw new Error('mongo down') } }).get_watched_items({})
    assert.ok(isToolError(out))
    assert.match(JSON.stringify(out), /mongo down/)
})

test('a lowercase ticker is normalised before it reaches the read', async () => {
    let seen = null
    await handlers({ watched: async (_u, o) => { seen = o; return { items: [], counts: {}, unavailable: [] } } })
        .get_watched_items({ symbol: 'nvda' })
    assert.equal(seen.symbol, 'NVDA')
})

test('a junk date is dropped rather than passed on as a filter', async () => {
    let seen = null
    await handlers({ performance: async (_u, o) => { seen = o; return {} } }).get_performance({ from: 'last tuesday' })
    assert.equal(seen.from, null)
})

test('a real date becomes the ms the trade store expects', async () => {
    let seen = null
    await handlers({ performance: async (_u, o) => { seen = o; return {} } }).get_performance({ from: '2026-07-01' })
    assert.equal(seen.from, Date.parse('2026-07-01T00:00:00Z'))
})

test('scope falls back to the personal one on anything unrecognised', async () => {
    let seen = null
    const h = handlers({ events: async (_u, o) => { seen = o; return { earnings: [], fed: [] } } })
    await h.get_upcoming_events({ scope: 'everything' })
    assert.equal(seen.scope, 'mine')
})

// ─── the descriptions the model reads ─────────────────────────────────────────

test('get_watched_items disambiguates itself from get_trading_context', () => {
    // It cannot be fixed from the other side: TRADING_CONTEXT_TOOL_SPEC is shared by seven agents
    // and the snapshot asserts every description verbatim, so the NOT-clause has to live here.
    assert.match(USER_DATA_TOOL_SPEC.get_watched_items, /NOT their open broker positions/)
    assert.match(USER_DATA_TOOL_SPEC.get_watched_items, /get_trading_context/)
})

test('the performance description warns against re-scaling the win rate', () => {
    assert.match(USER_DATA_TOOL_SPEC.get_performance, /PERCENTAGES already|never multiply/)
})

test('the calendar description says it is personal by default', () => {
    assert.match(USER_DATA_TOOL_SPEC.get_upcoming_events, /OWN names/)
})
