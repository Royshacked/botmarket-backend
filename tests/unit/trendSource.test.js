import { test } from 'node:test'
import assert from 'node:assert/strict'
import { industryDaily, industryEx, decompose } from '../../services/trendSource.service.js'
import { surprisePct, surpriseBand, collectDrift, peerSeason, PEER_FEATURES } from '../../services/reportReaction.service.js'
import { prepare } from '../../services/screenerLab.data.js'

// Where a trend comes from (test D) and the drift after a report by its surprise (test E) — Roy, 2026-10-26.

const DAY = 86_400_000
function bars(start, n, f) {
    const out = []
    for (let t = Date.parse(`${start}T04:00:00Z`), i = 0; out.length < n; t += DAY) {
        const d = new Date(t).getUTCDay()
        if (d === 0 || d === 6) continue
        const b = f(i++)
        out.push({ timestamp: t / 1000, open: b.open ?? b.close, high: b.close * 1.01, low: b.close * 0.99, close: b.close, volume: 1e6 })
    }
    return out
}
const etDay = (b) => new Date(b.timestamp * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

// A rises 1% a session and jumps 10% the session after its report (bar 70); its three peers rise 0.5% a session; SPY is flat.
function fixture() {
    const n = 100, R = 70
    const a = bars('2025-01-02', n, (i) => ({ close: 20 * 1.01 ** i * (i > R ? 1.1 : 1) }))
    const peer = () => bars('2025-01-02', n, (i) => ({ close: 30 * 1.005 ** i }))
    const ds = a.map(etDay)
    const raw = { names: { A: a, P1: peer(), P2: peer(), P3: peer() }, spy: bars('2025-01-02', n, () => ({ close: 500 })), sectors: {}, calendar_from: ds[0],
        calendar: [{ symbol: 'A', date: ds[R], epsActual: 1.2, epsEstimated: 1 }] }
    return { data: prepare(raw), industryOf: new Map([['A', 'X'], ['P1', 'X'], ['P2', 'X'], ['P3', 'X']]), R, n }
}

test('the industry’s move that day, the name taken out; too few others → null', () => {
    assert.equal(industryEx({ sum: 4, n: 4 }, 1), 1)
    assert.equal(industryEx({ sum: 3, n: 3 }, 1), null, 'two others is under three')
    assert.equal(industryEx(undefined, 1), null)
})

test('a year cut three ways: the report window, the industry between, the name’s own — they add up', () => {
    const { data, industryOf, R, n } = fixture()
    const inds = industryDaily(data, industryOf)
    const r = decompose(data.names.get('A'), 1, n - 1, data, 'X', inds)
    const l = (x) => Math.log(x) * 100
    assert.equal(r.report_days, 2, 'the report session and the one after')
    assert.ok(Math.abs(r.reports - (2 * l(1.01) + l(1.1))) < 1e-9, 'its two sessions: 1% each and the jump')
    assert.ok(Math.abs(r.industry - (n - 2 - 2) * l(1.005)) < 1e-9, 'the peers’ 0.5% on every other session')
    assert.ok(Math.abs(r.own - (n - 2 - 2) * (l(1.01) - l(1.005))) < 1e-9)
    assert.ok(Math.abs(r.total - (r.reports + r.industry + r.own)) < 1e-9)
    assert.ok(Math.abs(r.total - l(data.names.get('A').rows[n - 1].close / data.names.get('A').rows[1].close)) < 1e-9, 'the whole move, SPY flat')
    assert.ok(R > 1)
})

test('the surprise: the estimate floored at 5 cents, clipped at ±100; its bands', () => {
    assert.equal(Math.round(surprisePct({ epsActual: 1.2, epsEstimated: 1 })), 20)
    assert.equal(Math.round(surprisePct({ epsActual: -0.01, epsEstimated: -0.02 })), 20, 'a near-zero estimate reads against 5 cents')
    assert.equal(surprisePct({ epsActual: 5, epsEstimated: 0.01 }), 100)
    assert.equal(surprisePct({ epsActual: null, epsEstimated: 1 }), null)
    assert.deepEqual([-5, 0, 2, 5, 10.5, null].map(surpriseBand), ['miss', 'in line', 'in line', 'beat', 'big beat', null])
})

test('the drift rows: the trade enters the SECOND session after the report; the band and the reaction ride along', () => {
    const { data, R } = fixture()
    const [r, ...rest] = collectDrift(data)
    assert.equal(rest.length, 0)
    assert.equal(r.j, R + 1, 'shockTrades buys at j + 1 = R + 2')
    assert.equal(r.band, 'big beat')
    assert.equal(r.reacted, 'up')
})

test('the early reporters: the industry’s others in the window, their reaction over by the target’s evening before', () => {
    const n = 120, T = 100
    const flat = () => bars('2025-01-02', n, () => ({ close: 40 }))
    const ds = flat().map(etDay)
    const raw = { names: { T: flat(), E1: flat(), E2: flat(), LATE: flat(), OLD: flat(), OTHER: flat() }, spy: flat(), sectors: {}, calendar_from: ds[0],
        calendar: [
            { symbol: 'T', date: ds[T], epsActual: 1, epsEstimated: 1 },
            { symbol: 'E1', date: ds[T - 10], epsActual: 1.2, epsEstimated: 1 },  // +20%, a beat
            { symbol: 'E2', date: ds[T - 5], epsActual: 0.9, epsEstimated: 1 },   // −10%
            { symbol: 'LATE', date: ds[T - 1], epsActual: 2, epsEstimated: 1 },   // its window closes ON the target's day — out
            { symbol: 'OLD', date: ds[T - 60], epsActual: 2, epsEstimated: 1 },   // past 45 days — out
            { symbol: 'OTHER', date: ds[T - 5], epsActual: 2, epsEstimated: 1 },  // another industry — out
        ] }
    const data = prepare(raw)
    const industryOf = new Map([['T', 'X'], ['E1', 'X'], ['E2', 'X'], ['LATE', 'X'], ['OLD', 'X'], ['OTHER', 'Y']])
    const r = peerSeason(data, industryOf).find(x => x.symbol === 'T')
    assert.equal(r.f.early_n, 2)
    assert.equal(Math.round(r.f.early_surprise), 5, 'the mean of +20 and −10')
    assert.equal(r.f.early_beat, 0.5)
    assert.equal(r.beat, false, 'in line is no beat')
    assert.equal(r.x.length, PEER_FEATURES.length)
    assert.equal(peerSeason(data, industryOf, { min: 3 }).some(x => x.symbol === 'T'), false, 'under `min` early reporters → left out')
})
