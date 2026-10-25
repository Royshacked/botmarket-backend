import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featuresAt, collectMovers, binByFeature, fitAndScore, FEATURES, pack } from '../../services/moverDiff.service.js'
import { prepare } from '../../services/screenerLab.data.js'

// What tells an up mover from a down mover (Roy, 2026-10-25) — the two set against each other, the last year held out.

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

test('the facts at Monday’s open: the gap, Friday, the trend, the last report and its reaction', () => {
    const n = 300
    const rows = bars('2025-06-02', n, (i) => ({ close: i < 200 ? 50 : i === 200 ? 55 : 60, open: i === n - 5 ? 63 : undefined }))
    const ds = rows.map(b => new Date(b.timestamp * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }))
    const raw = { names: { A: rows }, spy: bars('2025-06-02', n, () => ({ close: 500 })), sectors: {}, calendar_from: '2025-06-02',
        calendar: [{ symbol: 'A', date: ds[200], epsActual: 1.2, epsEstimated: 1 }] }
    const data = prepare(raw)
    const s = data.names.get('A')
    const f = featuresAt(s, data, n - 6, n - 5, n - 1)
    assert.equal(Math.round(f.gap_open), 5, 'Monday opened 5% over Friday')
    assert.equal(f.report_in_week, 0)
    assert.equal(f.days_since_report, n - 6 - 200)
    assert.equal(Math.round(f.last_surprise), 20)
    assert.equal(Math.round(f.last_reaction), 20, 'from the close before the report to the session after')
    assert.equal(f.spy_over200, 0, 'SPY flat — not over its average')
    assert.deepEqual(Object.keys(f).sort(), [...FEATURES].sort())
})

test('the movers: only 5%+ either way; the bins cut before the split; the model scores held out', () => {
    // Synthetic: `gap_open` decides the direction, `noise` decides nothing.
    const movers = []
    for (let k = 0; k < 2000; k++) {
        const gap = (k % 7) - 3, noise = (k * 37) % 11
        const week = k < 1400 ? '2025-01-06' : '2026-01-05'
        movers.push({ week, symbol: `S${k}`, up: gap + ((k * 13) % 5) - 2 > 0, net: gap, x: pack(Object.fromEntries(FEATURES.map(x => [x, x === 'gap_open' ? gap : x === 'ret5' ? noise : null]))) })
    }
    const bins = binByFeature(movers, '2025-06-01')
    assert.ok(bins.gap_open.spread_before > 50 && bins.gap_open.spread_held > 50, 'the deciding fact spreads in both periods')
    assert.ok(Math.abs(bins.ret5.spread_held) < 15, 'the noise does not')
    assert.equal(bins.vs_sma20, undefined, 'a fact never present is left out')
    const fit = fitAndScore(movers, '2025-06-01', { epochs: 200 })
    assert.equal(fit.train, 1400)
    assert.ok(fit.held.auc > 0.8)
    assert.ok(fit.held.deciles.at(-1).up > fit.held.deciles[0].up)
    assert.equal(Object.keys(fit.weights)[0], 'gap_open')
    const none = { names: new Map(), spyDays: [], spyByDay: new Map() }
    assert.deepEqual(collectMovers(none), [])
})

test('the week after: a 5%+ week, then its next week — by hold, against every name', async () => {
    const { followThrough } = await import('../../services/moverDiff.service.js')
    // UP rises 10% in its next-to-last full week, then 2% more; FLAT does nothing. SPY flat.
    const n = 120
    const up = bars('2026-01-05', n, (i) => ({ close: i < n - 10 ? 50 : i < n - 5 ? 50 * (1 + 0.1 * (i - (n - 11)) / 5) : 55 * (1 + 0.02 * (i - (n - 6)) / 5) }))
    const raw = { names: { UP: up, FLAT: bars('2026-01-05', n, () => ({ close: 40 })) }, spy: bars('2026-01-05', n, () => ({ close: 500 })),
        sectors: {}, calendar: [], calendar_from: '2026-01-05' }
    const r = followThrough(prepare(raw), { weeks: 1, min: 5 })
    assert.equal(r.groups['every name'].n, 2)
    assert.equal(r.groups['up 5%+'].n, 1)
    assert.ok(r.groups['up 5%+'].next_mean > 1, 'it kept rising the next week')
    assert.equal(r.groups['down 5%+'].n, 0)
    assert.equal(followThrough(prepare(raw), { weeks: 1, min: 5, hold: 21 }).groups['every name'].n, 0, 'no month after the last week')
})
