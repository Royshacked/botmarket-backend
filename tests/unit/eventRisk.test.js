import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEventRisk } from '../../services/eventRisk.service.js'

// Fixed clock so the from/to window the earnings fetcher receives is deterministic.
const NOW = Date.parse('2026-07-12T14:00:00Z')

function deps({ earnings = [], fed = [] } = {}) {
    const calls = { earningsArgs: null, fedArgs: null }
    return {
        calls,
        fetchEarnings: async (from, to) => { calls.earningsArgs = { from, to }; return { earningsCalendar: earnings } },
        fetchFed:      async (opts)     => { calls.fedArgs = opts;              return fed },
    }
}

test('buildEventRisk: equity earnings matched by symbol, bmo → pre_market', async () => {
    const d = deps({ earnings: [
        { symbol: 'TSLA', date: '2026-07-15', hour: 'bmo', epsEstimate: 0.6 },
        { symbol: 'AAPL', date: '2026-07-14', hour: 'amc' },   // different symbol → dropped
    ] })
    const out = await buildEventRisk({ asset: 'tsla', assetClass: 'equity', now: NOW }, d)
    assert.deepEqual(out, [
        { type: 'earnings', label: 'TSLA earnings', date: '2026-07-15', when: 'pre_market', impact: 'high' },
    ])
    // window is [today, today+10d]
    assert.equal(d.calls.earningsArgs.from, '2026-07-12')
    assert.equal(d.calls.earningsArgs.to,   '2026-07-22')
})

test('buildEventRisk: amc → after_hours, unknown hour → during_session', async () => {
    const d = deps({ earnings: [
        { symbol: 'NVDA', date: '2026-07-16', hour: 'amc' },
        { symbol: 'NVDA', date: '2026-07-18', hour: 'dmh' },
    ] })
    const out = await buildEventRisk({ asset: 'NVDA', assetClass: 'equity', now: NOW }, d)
    assert.equal(out[0].when, 'after_hours')
    assert.equal(out[1].when, 'during_session')
})

test('buildEventRisk: non-equity class skips the earnings fetch entirely', async () => {
    const d = deps({ earnings: [{ symbol: 'BTC', date: '2026-07-15', hour: 'bmo' }] })
    const out = await buildEventRisk({ asset: 'BTC-USD', assetClass: 'crypto', now: NOW }, d)
    assert.equal(d.calls.earningsArgs, null)                 // never called
    assert.equal(out.length, 0)
})

test('buildEventRisk: fed/macro merged, low-impact dropped, sorted soonest-first with earnings', async () => {
    const d = deps({
        earnings: [{ symbol: 'TSLA', date: '2026-07-20', hour: 'bmo' }],
        fed: [
            { date: '2026-07-15', event: 'CPI (Inflation)', impact: 'high', kind: 'data', time: '8:30a' },
            { date: '2026-07-17', event: 'Jobless Claims',  impact: 'low',  kind: 'data', time: '8:30a' },  // dropped
            { date: '2026-07-14', event: 'FOMC Rate Decision', impact: 'high', kind: 'fomc', time: '2:00p' },
        ],
    })
    const out = await buildEventRisk({ asset: 'TSLA', assetClass: 'equity', now: NOW }, d)
    assert.deepEqual(out.map(e => `${e.date}:${e.type}`), ['2026-07-14:fomc', '2026-07-15:macro', '2026-07-20:earnings'])
    assert.ok(!out.some(e => e.label === 'Jobless Claims'))  // low-impact filtered
    assert.equal(d.calls.fedArgs.days, 10)
})

test('buildEventRisk: no asset → [] (no fetches)', async () => {
    const d = deps({ fed: [{ date: '2026-07-14', event: 'CPI', impact: 'high', kind: 'data' }] })
    const out = await buildEventRisk({ asset: '', assetClass: 'equity', now: NOW }, d)
    assert.deepEqual(out, [])
    assert.equal(d.calls.fedArgs, null)
})

test('buildEventRisk: a throwing provider is swallowed — the other still contributes', async () => {
    const out = await buildEventRisk({ asset: 'TSLA', assetClass: 'equity', now: NOW }, {
        fetchEarnings: async () => { throw new Error('finnhub 429') },
        fetchFed:      async () => [{ date: '2026-07-14', event: 'CPI', impact: 'high', kind: 'data', time: '8:30a' }],
    })
    assert.deepEqual(out.map(e => e.type), ['macro'])        // earnings failure didn't abort fed
})
