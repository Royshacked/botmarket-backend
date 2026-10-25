import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indicators, trade, runHypothesis, report, verdict, costFor, HYPOTHESES, testable } from '../../services/screenerLab.service.js'
import { prepare } from '../../services/screenerLab.data.js'

// The screener lab (Roy, 2026-10-24: "think of more criteria and we test one by one") — every idea on one yardstick.

const DAY = 86_400_000
/** Weekday bars from `start`: `f(i)` → { close, open?, high?, low?, volume? }; timestamps 00:00 ET in seconds. */
function bars(start, n, f) {
    const out = []
    for (let t = Date.parse(`${start}T04:00:00Z`), i = 0; out.length < n; t += DAY) {
        const d = new Date(t).getUTCDay()
        if (d === 0 || d === 6) continue
        const b = f(i++)
        out.push({ timestamp: t / 1000, open: b.open ?? b.close, high: b.high ?? b.close * 1.01, low: b.low ?? b.close * 0.99, close: b.close, volume: b.volume ?? 1e6 })
    }
    return out
}
const etDay = (b) => new Date(b.timestamp * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const named = (rows, reports = new Map()) => ({ rows, ind: indicators(rows, rows.map(etDay)), reports })

test('indicators: rolling averages, the 5-session return, the 2-day RSI, the year high, dollar volume', () => {
    const rows = bars('2026-01-05', 260, (i) => ({ close: 100 + i, volume: 1e6 }))
    const ind = indicators(rows, rows.map(etDay))
    assert.equal(ind.sma5[3], null)
    assert.equal(ind.sma5[4], 102)
    assert.equal(ind.sma200[199], 199.5)
    assert.equal(Math.round(ind.ret5[5] * 100) / 100, 5)
    assert.equal(ind.rsi2[10], 100, 'only up days')
    assert.equal(ind.high252[251], Math.max(...rows.slice(0, 252).map(b => b.high)))
    assert.equal(ind.adv20[19], 109.5e6)
    const down = bars('2026-01-05', 10, (i) => ({ close: 100 - i }))
    assert.equal(indicators(down, down.map(etDay)).rsi2[5], 0, 'only down days')
})

test('a trade: open to the close `hold` sessions on, against SPY over the same sessions, less the cost by liquidity', () => {
    const rows = bars('2026-03-02', 40, (i) => ({ close: 50 + i, open: 50 + i - 0.5, volume: 3e6 }))
    const spy = bars('2026-03-02', 40, () => ({ close: 500, open: 500 }))
    const s = named(rows)
    const t = trade({ rows, i: 25, ind: s.ind, hold: 5, spyByDay: new Map(spy.map(b => [etDay(b), b])) })
    assert.equal(t.day, s.ind.date[25])
    assert.equal(t.exit_day, s.ind.date[29])
    assert.equal(Math.round(t.ret * 100) / 100, Math.round(((79 / 74.5) - 1) * 10000) / 100)
    assert.equal(t.spy, 0)
    assert.equal(costFor(s.ind.adv20[24]), 0.05, '~$200M a day')
    assert.equal(Math.round((t.excess - t.net) * 100) / 100, 0.05)
    assert.equal(trade({ rows, i: 38, ind: s.ind, hold: 5, spyByDay: new Map(spy.map(b => [etDay(b), b])) }), null, 'the window is not complete')
    // An exit rule ends it early.
    const early = trade({ rows, i: 25, ind: s.ind, hold: 5, exit: ({ k }) => k === 26, spyByDay: new Map(spy.map(b => [etDay(b), b])) })
    assert.equal(early.exit_day, s.ind.date[26])
    assert.deepEqual([costFor(30e6), costFor(6e6), costFor(1e6)], [0.1, 0.25, 0.5])
})

test('testable: the price and the dollar volume as of the evening before', () => {
    const cheap = named(bars('2026-01-05', 30, () => ({ close: 4, volume: 1e7 })))
    const thin = named(bars('2026-01-05', 30, () => ({ close: 50, volume: 1e4 })))
    const ok = named(bars('2026-01-05', 30, () => ({ close: 50, volume: 1e6 })))
    assert.deepEqual([testable(cheap.rows, 25, cheap.ind), testable(thin.rows, 25, thin.ind), testable(ok.rows, 25, ok.ind)], [false, false, true])
})

test('beat on day two: the report two sessions back, tagged by the size of the surprise', () => {
    const rows = bars('2026-01-05', 60, () => ({ close: 50 }))
    const dates = rows.map(etDay)
    const reports = new Map([[dates[40], { epsActual: 1.2, epsEstimated: 1.0, revenueActual: 10, revenueEstimated: 9 }], [dates[45], { epsActual: 1.02, epsEstimated: 1.0 }]])
    const s = named(rows, reports)
    const sig = (i) => HYPOTHESES.beat_day2.signal({ rows, i, ind: s.ind, reports })
    assert.equal(sig(42), '10-25%')
    assert.equal(sig(41), null, 'day one is not day two')
    assert.equal(sig(47), null, 'a 2% beat is not a beat')
})

test('the one-week reversal: down 8–25% over its 200-day — but not with a report in the week', () => {
    const rows = bars('2025-01-06', 230, (i) => ({ close: i < 220 ? 50 + i * 0.2 : 94 - (i - 220) * 2.2 }))
    const s = named(rows)
    const i = 226
    assert.ok(s.ind.ret5[i - 1] <= -8 && s.ind.ret5[i - 1] >= -25, `ret5 ${s.ind.ret5[i - 1]}`)
    assert.ok(HYPOTHESES.reversal_1w.signal({ rows, i, ind: s.ind, reports: new Map() }))
    assert.equal(HYPOTHESES.reversal_1w.signal({ rows, i, ind: s.ind, reports: new Map([[s.ind.date[i - 3], {}]]) }), null)
})

test('a run: the baseline takes every testable name-session, a hypothesis its signals; the report counts each session once, in halves', () => {
    const spy = bars('2025-06-02', 300, () => ({ close: 500 }))
    const up = bars('2025-06-02', 300, (i) => ({ close: 50 + i * 0.1, volume: 1e6 }))
    const flat = bars('2025-06-02', 300, () => ({ close: 50, volume: 1e6 }))
    const data = prepare({ spy, names: { UP: up, FLAT: flat }, calendar: [{ symbol: 'UP', date: etDay(up[280]), epsActual: 2, epsEstimated: 1 }], calendar_from: etDay(up[250]) })
    const days = data.spyDays.slice(-40)
    const base = runHypothesis(null, data, { days })
    assert.ok(base.length > 60, 'both names, most sessions')
    const beats = runHypothesis(HYPOTHESES.beat_day2, data, { days })
    assert.deepEqual(beats.map(t => [t.symbol, t.day, t.tag]), [['UP', etDay(up[282]), '25%+']])
    const r = report(base, days)
    assert.equal(r.all.n, base.length)
    assert.ok(r.halves.first.n > 0 && r.halves.second.n > 0)
    assert.equal(r.by_tag, undefined, 'the baseline has no tags')
    assert.ok(r.all.ci95, 'a range across sessions')
    assert.equal(verdict([]).n, 0)
    assert.ok(report(beats, days).by_tag['25%+'])
})

test('an insider cluster: 2+ buyers in 14 days, $50k+, on the day the filing completes it — once', async () => {
    const { clusterOn } = await import('../../services/screenerLab.service.js')
    const buys = [
        { filed: '2026-05-01', who: 'a', usd: 30_000 },
        { filed: '2026-05-08', who: 'b', usd: 30_000 },
        { filed: '2026-05-09', who: 'c', usd: 10_000 },
    ]
    assert.equal(clusterOn(buys, '2026-05-07', '2026-05-06'), null, 'one buyer so far')
    assert.equal(clusterOn(buys, '2026-05-08', '2026-05-07'), '2 buyers', 'the second filing completes it')
    assert.equal(clusterOn(buys, '2026-05-09', '2026-05-08'), null, 'already a cluster the day before — no second signal')
    assert.equal(clusterOn([{ filed: '2026-05-01', who: 'a', usd: 10_000 }, { filed: '2026-05-02', who: 'b', usd: 10_000 }], '2026-05-02', '2026-05-01'), null, 'under $50k')
    assert.equal(clusterOn([{ filed: '2026-04-01', who: 'a', usd: 90_000 }, { filed: '2026-05-02', who: 'b', usd: 90_000 }], '2026-05-02', '2026-05-01'), null, 'a month apart')
    assert.equal(clusterOn([], '2026-05-02', null), null)
})

test('prepare: the earnings history merged under the calendar, insider purchases only, sectors by session', () => {
    const rows = bars('2026-01-05', 40, (i) => ({ close: 50 + i }))
    const raw = { spy: rows, calendar: [{ symbol: 'A', date: '2026-02-10', epsActual: 2, epsEstimated: 1 }], calendar_from: '2026-01-05',
        names: Object.fromEntries(Array.from({ length: 9 }, (_, k) => [`S${k}`, bars('2026-01-05', 40, (i) => ({ close: 50 + i * (k + 1) * 0.1 }))]).concat([['A', rows]])),
        sectors: { A: 'Tech', ...Object.fromEntries(Array.from({ length: 9 }, (_, k) => [`S${k}`, 'Tech'])) } }
    const extras = {
        history: { A: [{ symbol: 'A', date: '2026-02-10', epsActual: 9, epsEstimated: 1 }, { symbol: 'A', date: '2025-11-10', epsActual: 1, epsEstimated: 1.1 }] },
        insiders: { A: [{ filingDate: '2026-01-20 00:00:00', transactionType: 'P-Purchase', reportingCik: 'x', securitiesTransacted: 100, price: 10 }, { filingDate: '2026-01-21', transactionType: 'S-Sale', reportingCik: 'y' }] },
    }
    const data = prepare(raw, extras)
    const a = data.names.get('A')
    assert.equal(a.reports.get('2026-02-10').epsActual, 2, 'the calendar wins on a shared date')
    assert.ok(a.reports.has('2025-11-10'), 'the history adds the older report')
    assert.deepEqual(a.insiders, [{ filed: '2026-01-20', who: 'x', role: '', usd: 1000 }])
    assert.equal(a.sector, 'Tech')
    const day = a.ind.date[20]
    assert.equal(data.sectorDay.get(day).get('Tech').n, 10)
    assert.ok(data.sectorDay.get(day).get('Tech').median > 0)
})

test('the run-up by streak: entered seven sessions before the report, out the close before it', () => {
    const rows = bars('2026-01-05', 60, (i) => ({ close: 50 + i * 0.1 }))
    const spy = bars('2026-01-05', 60, () => ({ close: 500 }))
    const dates = rows.map(etDay)
    const reports = new Map([[dates[10], { epsActual: 1, epsEstimated: 0.9 }], [dates[20], { epsActual: 1, epsEstimated: 0.9 }], [dates[30], { epsActual: 1, epsEstimated: 0.9 }], [dates[45], {}]])
    const s = named(rows, reports)
    const h = HYPOTHESES.runup_streak
    const fired = []
    for (let i = 31; i < 45; i++) if (h.signal({ rows, i, ind: s.ind, reports, name: s })) fired.push(i)
    assert.deepEqual(fired, [38], 'once, seven sessions before the report on 45')
    assert.equal(h.signal({ rows, i: 38, ind: s.ind, reports, name: s }), '3 of 3 beat')
    const t = trade({ rows, i: 38, ind: s.ind, name: s, hold: h.hold, exit: h.exit, spyByDay: new Map(spy.map(b => [etDay(b), b])) })
    assert.equal(t.exit_day, dates[44], 'the close before the report')
    // The stress tests: another entry, and held through the report.
    const at = (id) => { const out = []; for (let i = 31; i < 45; i++) if (HYPOTHESES[id].signal({ rows, i, ind: s.ind, reports, name: s, data: { spyByDay: new Map() } })) out.push(i); return out }
    assert.deepEqual([at('runup_3'), at('runup_10')], [[42], [35]])
    const through = HYPOTHESES.runup_7_through
    const t2 = trade({ rows, i: 38, ind: s.ind, name: s, hold: through.hold, exit: through.exit, spyByDay: new Map(spy.map(b => [etDay(b), b])) })
    assert.equal(t2.exit_day, dates[46], 'the close of the session after the report')
    assert.match(HYPOTHESES.runup_7_trend.signal({ rows, i: 38, ind: s.ind, reports, name: s, data: { spyByDay: new Map() } }), /^(over|under) 200d|200d \?/)
})

test('the sector laggard: bottom tenth of a rising sector, under water, no report', () => {
    const rows = bars('2026-01-05', 30, (i) => ({ close: 50 - i * 0.5 }))
    const s = { ...named(rows), sector: 'Tech' }
    const day = s.ind.date[19]
    const data = { sectorDay: new Map([[day, new Map([['Tech', { median: 3, p10: -2, n: 20 }]])]]) }
    assert.equal(HYPOTHESES.sector_laggard.signal({ rows, i: 20, ind: s.ind, reports: new Map(), name: s, data }), 'sector up 2%+')
    const flat = { sectorDay: new Map([[day, new Map([['Tech', { median: -1, p10: -6, n: 20 }]])]]) }
    assert.equal(HYPOTHESES.sector_laggard.signal({ rows, i: 20, ind: s.ind, reports: new Map(), name: s, data: flat }), null, 'the sector fell too')
})

// Roy, 2026-10-25: "each stock swing and market regime".
test('a stock’s swing character: its 5-session moves reversing, continuing, or neither', async () => {
    const { swingCharacter } = await import('../../services/screenerLab.service.js')
    const zig = bars('2025-01-06', 300, (i) => ({ close: 50 + (Math.floor(i / 5) % 2 ? 3 : -3) }))
    assert.equal(swingCharacter(zig, 290), 'swinger')
    const trend = bars('2025-01-06', 300, (i) => ({ close: 50 * Math.exp(0.002 * i + 0.0005 * i * i / 100) }))
    assert.notEqual(swingCharacter(trend, 290), 'swinger')
    assert.equal(swingCharacter(zig, 100), 'unknown', 'under a year of bars')
})

test('the swing low: 2 sd under the 20-day once per dip, out back at the average', () => {
    const rows = bars('2026-01-05', 60, (i) => ({ close: i === 40 ? 40 : i > 40 && i < 44 ? 45 : 50 + (i % 2) * 0.5 }))
    const s = named(rows)
    const sig = (i) => HYPOTHESES.swing_low.signal({ rows, i, ind: s.ind })
    assert.equal(sig(41), 'unknown', 'the dip on 40 — under a year of bars, so no character')
    assert.equal(sig(42), null, 'not again the next day')
    assert.equal(sig(30), null)
    const spy = bars('2026-01-05', 60, () => ({ close: 500 }))
    const t = trade({ rows, i: 41, ind: s.ind, hold: 10, exit: HYPOTHESES.swing_low.exit, spyByDay: new Map(spy.map(b => [etDay(b), b])) })
    assert.equal(t.exit_day, s.ind.date[44], 'the first close back at the average')
})

test('the market regime: SPY over/under its 200-day · calm/stormy against its past year', async () => {
    const { spyRegimes } = await import('../../services/screenerLab.service.js')
    const spy = Array.from({ length: 400 }, (_, i) => ({ day: `d${String(i).padStart(3, '0')}`, close: i < 380 ? 400 + i * 0.5 : 590 - (i - 380) * 8 * (i % 2 ? 1 : -0.5) }))
    const r = spyRegimes(spy)
    assert.equal(r.get('d269'), undefined, 'not enough history')
    assert.equal(r.get('d300'), 'SPY over 200d · calm')
    assert.match(r.get('d399'), /stormy/)
})

test('the slower cycles: a range bottom once per visit, out at the middle; the past year’s swings', async () => {
    const { rangeSwings } = await import('../../services/screenerLab.service.js')
    // Sideways 100 ↔ 120 (a 20% range, the 50-day flat), a 40-session period; a dip to the bottom at bar 380.
    const wave = (i) => 110 + 10 * Math.sin((i / 40) * 2 * Math.PI)
    const rows = bars('2025-01-06', 420, (i) => ({ close: wave(i) }))
    const s = named(rows)
    assert.equal(rangeSwings(rows, s.ind, 300), 'unknown', 'under 310 bars')
    assert.equal(rangeSwings(rows, s.ind, 400), '4+ swings', 'six periods in a year')
    const sig = (i) => HYPOTHESES.range_low.signal({ rows, i, ind: s.ind })
    const hits = []
    for (let i = 320; i < 420; i++) if (sig(i)) hits.push(i)
    assert.ok(hits.length >= 2, 'one per trough')
    assert.ok(hits.every((h, k) => k === 0 || h - hits[k - 1] > 5), 'not on the next day again')
    const spy = bars('2025-01-06', 420, () => ({ close: 500 }))
    const t = trade({ rows, i: hits[0], ind: s.ind, hold: 20, exit: HYPOTHESES.range_low.exit, spyByDay: new Map(spy.map(b => [etDay(b), b])) })
    assert.ok(rows[s.ind.date.indexOf(t.exit_day)].close >= 109, 'out back at the range middle')
})

test('a name’s season: how often it beat SPY in that month, over 7+ of the 10 years before; month-end closes', async () => {
    const { seasonRate } = await import('../../services/screenerLab.service.js')
    const { monthEnds } = await import('../../services/screenerLab.data.js')
    const m = new Map(), spy = new Map()
    for (let y = 2014; y <= 2026; y++) for (let k = 1; k <= 12; k++) {
        const ym = `${y}-${String(k).padStart(2, '0')}`
        // Every March up 10%, SPY flat; the year 2026's own March is not "before".
        m.set(ym, k === 3 ? 110 : 100); spy.set(ym, 100)
    }
    assert.equal(seasonRate(m, spy, '2026-03-02'), 1)
    assert.equal(seasonRate(m, spy, '2026-04-01'), 0, 'April falls back from 110')
    assert.equal(seasonRate(m, spy, '2019-03-01'), null, 'five years before only')
    const b = bars('2026-01-27', 10, (i) => ({ close: 100 + i }))
    assert.deepEqual(monthEnds(b), [['2026-01', 103], ['2026-02', 109]])
    const rows = bars('2026-02-23', 30, () => ({ close: 50 }))
    const s = named(rows)
    const first = s.ind.date.findIndex(d => d.startsWith('2026-03'))
    const tag = (i) => HYPOTHESES.season_month.signal({ i, ind: s.ind, name: { months: m }, data: { spyMonths: spy } })
    assert.equal(tag(first), 'beat 80%+ of years')
    assert.equal(tag(first + 1), null, 'only on the month’s first session')
    assert.equal(HYPOTHESES.season_month.exit({ k: first - 1, ind: s.ind }), true, 'the last session of February')
})

test('the false break of last week’s low: under it intraday, closed back over, the first of the week; the stop', () => {
    // Week one (Mon 2026-01-05) lows 99; week two: Tuesday trades to 97 and closes 100 — the break; Wednesday again — not the first.
    // Midday stamps: the helper's 04:00 UTC is the evening before in New York, which would shift the calendar weeks.
    const noon = (xs) => xs.map(x => ({ ...x, timestamp: x.timestamp + 10 * 3600 }))
    const rows = noon(bars('2026-01-05', 25, (i) => ({ close: 100, low: i === 6 || i === 7 ? 97 : 99 })))
    const s = named(rows)
    assert.equal(s.ind.wkLowPrev[6], 99)
    assert.equal(s.ind.wkLowPrev[3], null)
    const sig = (i) => HYPOTHESES.falsebreak_5.signal({ rows, i, ind: s.ind })
    assert.equal(sig(7), '200d ? · break 2%+', 'bought the session after the break')
    assert.equal(sig(8), null, 'not the second break of the week')
    assert.equal(sig(3), null, 'week one has no week before it')
    rows[9].close = 96
    const spy = noon(bars('2026-01-05', 25, () => ({ close: 500 })))
    const t = trade({ rows, i: 7, ind: s.ind, hold: 10, exit: HYPOTHESES.falsebreak_stop.exit, spyByDay: new Map(spy.map(b => [etDay(b), b])) })
    assert.equal(t.exit_day, s.ind.date[9], 'out on the first close under the break day’s low')
})

test('the false break on a mover: only where the name is in play, tagged by the kind of mover', () => {
    const noon = (xs) => xs.map(x => ({ ...x, timestamp: x.timestamp + 10 * 3600 }))
    // Falls 10% over week two into the break (Tuesday of week three trades under week two's low, closes back over).
    const rows = noon(bars('2026-01-05', 25, (i) => ({ close: i < 5 ? 100 : i < 10 ? 100 - (i - 4) * 2 : 91, low: i === 11 ? 85 : undefined })))
    const s = named(rows)
    const spy = noon(bars('2026-01-05', 25, () => ({ close: 500 })))
    const data = { spyByDay: new Map(spy.map(b => [etDay(b), b])) }
    assert.equal(HYPOTHESES.falsebreak_movers_10.signal({ rows, i: 12, ind: s.ind, data }), '200d ? · big week down')
    // The same break on a quiet name is not a mover's.
    const calm = noon(bars('2026-01-05', 25, (i) => ({ close: 100, low: i === 11 ? 97 : 99 })))
    const c = named(calm)
    assert.equal(HYPOTHESES.falsebreak_movers_10.signal({ rows: calm, i: 12, ind: c.ind, data }), null)
    assert.equal(HYPOTHESES.falsebreak_10.signal({ rows: calm, i: 12, ind: c.ind }), '200d ? · break 2%+')
})

test('the false break of last month’s low: the month’s first break of the month before’s low', () => {
    const noon = (xs) => xs.map(x => ({ ...x, timestamp: x.timestamp + 10 * 3600 }))
    // January lows 99; on 2026-02-03 (bar 21) the low trades 96 and closes 100; the next day again — not the first.
    const rows = noon(bars('2026-01-05', 30, (i) => ({ close: 100, low: i === 21 || i === 22 ? 96 : 99 })))
    const s = named(rows)
    assert.equal(s.ind.date[21], '2026-02-03')
    assert.equal(s.ind.moLowPrev[21], 99)
    const sig = (i) => HYPOTHESES.falsebreak_month_10.signal({ rows, i, ind: s.ind })
    assert.equal(sig(22), '200d ? · break 2%+')
    assert.equal(sig(23), null)
})

test('Wyckoff’s spring: a real range, a break under support closed back inside; out at the range top or the stop', async () => {
    const { springAt } = await import('../../services/screenerLab.service.js')
    // 60 sessions falling 150 → 110, then a 40-session range 100–120 (support touched on 70 and 90), the break on 110
    // (low 97, close 98, light volume), back over on 111 (close 102), then up to the range top by 116.
    const close = (i) => i < 70 ? 150 - (i / 70) * 40 : i < 110 ? (i === 75 || i === 95 ? 101 : 110 + 8 * Math.sin(i)) : i === 110 ? 98 : i === 111 ? 102 : 102 + (i - 111) * 4
    const rows = bars('2025-01-06', 130, (i) => ({ close: close(i), low: i === 75 || i === 95 ? 100 : i === 110 ? 97 : close(i) * 0.99, high: i < 110 ? Math.min(120, close(i) * 1.01) : close(i) * 1.01, volume: i === 110 ? 5e5 : 1e6 }))
    const sp = springAt(rows, 111)
    assert.ok(sp, 'a spring on 111')
    assert.equal(sp.b, 110)
    assert.equal(sp.support, 100)
    assert.equal(sp.springLow, 97)
    assert.ok(sp.volRatio < 1 && sp.decline)
    assert.equal(springAt(rows, 110), null, 'the break day itself closed under support')
    const s = named(rows)
    assert.equal(HYPOTHESES.wyckoff_spring.signal({ rows, i: 112, ind: s.ind }), 'after a decline · light volume')
    const spy = bars('2025-01-06', 130, () => ({ close: 500 }))
    const t = trade({ rows, i: 112, ind: s.ind, hold: 20, exit: HYPOTHESES.wyckoff_spring.exit, spyByDay: new Map(spy.map(b => [etDay(b), b])) })
    assert.ok(rows[s.ind.date.indexOf(t.exit_day)].close >= sp.resistance, 'out at the range top')
})
