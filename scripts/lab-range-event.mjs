// RANGE + AN EVENT A WEEK AWAY — descriptive, no trade (Roy, 2026-11-09: "range is last 2 months, the event is a week
// away, no trade yet, just what happened to these companies — distribution for last year"). A fresh question, not built
// on the earlier lab tests.
//
// The event is an earnings report (the only event in our data that is dated in advance). The scan day S is 5 sessions
// before the report day D. The range is the 42 sessions ending at S: width = (highest high − lowest low) / lowest low.
// Names are grouped by that width, every report is the control. FMP gives no before/after-market time, so the
// report's reaction is measured close D-1 → close D+1, which covers both.
//
// Windows (each raw and minus SPY over the same closes):
//   into   S → D-1        the week into the report
//   react  D-1 → D+1      the report
//   after  D+1 → D+20     the month after
//   all    S → D+20
// Plus where price stood at D+20 against the range: above its high, below its low, or still inside.
// Accumulation, described for the ranges under 15%: up-day volume / down-day volume over the range (> 1.2 vs < 0.8).
//
// Universe: data/lab/broad-* (lab-broad-fetch.mjs), at S price ≥ $5 and 20-day $ volume ≥ $10M. Reports from
// 2025-10-27 to the bars' end (2026-10-26); a window that runs past the bars is left out of that window's count.
//
//   node scripts/lab-range-event.mjs        → data/lab/range-event.out.txt + range-event.rows.csv
import fs from 'fs'
import readline from 'readline'

// --src=sp500 (Roy, 2026-11-09: "run the prev years"): the S&P 500 as it was, 2019-01 → 2026-10
// (data/lab/sp500-2019-01-02_2026-10-26.json + sp500.extras.json, gone names in), a report kept only when its name was
// in the index on the scan day → range-event.sp500.{out.txt,rows.csv}. Duplicate tickers NOT removed (Roy's call).
const SRC = process.argv.find(a => a.startsWith('--src='))?.slice(6) ?? 'broad'
const FROM = SRC === 'sp500' ? '2019-01-02' : '2025-10-27', LOOK = 42, LEAD = 5, AFTER = 20
const TAG = SRC === 'sp500' ? '.sp500' : ''
const OUT = `data/lab/range-event${TAG}.out.txt`, CSV = `data/lab/range-event${TAG}.rows.csv`
const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10)

const reports = new Map(), hist = new Map()
const SP = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8')).spans
const inSP = (sym, d) => (SP[sym] ?? []).some(([a, z]) => d >= a && (z == null || d < z))
function addHistory(symbol, h) {
    const byDate = new Map((h ?? []).map(r => [r.date, r]))
    const dates = [...byDate.keys()].filter(d => d >= FROM).sort()
    if (dates.length) { reports.set(symbol, dates); hist.set(symbol, [...byDate.values()].sort((a, z) => (a.date < z.date ? -1 : 1))) }
}
let SECTOR, spy = null
/** Every name's bars as [ts, o, h, l, c, v] arrays; sets `spy` (date → close) on the way. */
async function* source() {
    if (SRC === 'sp500') {
        const d = JSON.parse(fs.readFileSync('data/lab/sp500-2019-01-02_2026-10-26.json', 'utf8'))
        for (const [s, h] of Object.entries(JSON.parse(fs.readFileSync('data/lab/sp500.extras.json', 'utf8')).history)) addHistory(s, h)
        SECTOR = new Map(Object.entries(d.sectors))
        spy = new Map(d.spy.map(x => [day(x.timestamp), x.close]))
        for (const [symbol, bars] of Object.entries(d.names)) yield { symbol, b: bars.map(x => [x.timestamp, x.open, x.high, x.low, x.close, x.volume]) }
        return
    }
    SECTOR = new Map(JSON.parse(fs.readFileSync('data/lab/broad-universe.json', 'utf8')).names.map(n => [n.symbol, n.sector]))
    for await (const line of readline.createInterface({ input: fs.createReadStream('data/lab/broad-history.jsonl') })) {
        if (line) { const { symbol, h } = JSON.parse(line); addHistory(symbol, h) }
    }
    for await (const line of readline.createInterface({ input: fs.createReadStream('data/lab/broad-bars.jsonl') })) {
        if (!line) continue
        const o = JSON.parse(line)
        if (o.symbol === 'SPY') { spy = new Map(o.b.map(b => [day(b[0]), b[4]])); continue }
        yield o
    }
}

const rows = []
for await (const o of source()) {
    const dates = reports.get(o.symbol)
    if (!dates) continue
    const b = o.b, ds = b.map(x => day(x[0]))
    for (const D of dates) {
        const d = ds.findIndex(x => x >= D)
        if (d < 0 || ds[d] > addDays(D, 4)) continue           // report day not in the bars
        const s = d - LEAD
        if (s - LOOK + 1 < 20) continue
        if (SRC === 'sp500' && !inSP(o.symbol, ds[s])) continue
        const win = b.slice(s - LOOK + 1, s + 1)
        const close = b[s][4]
        const adv = mean(b.slice(s - 19, s + 1).map(x => x[4] * x[5]))
        if (!(close >= 5 && adv >= 10e6)) continue
        const hi = Math.max(...win.map(x => x[2])), lo = Math.min(...win.map(x => x[3]))
        let upV = 0, dnV = 0
        for (let k = s - LOOK + 1; k <= s; k++) { if (b[k][4] > b[k - 1][4]) upV += b[k][5]; else if (b[k][4] < b[k - 1][4]) dnV += b[k][5] }
        const ret = (i, j) => (j < b.length && i >= 0 ? (b[j][4] / b[i][4] - 1) * 100 : null)
        const sret = (i, j) => {
            if (j >= b.length) return null
            const a = spy?.get(ds[i]), z = spy?.get(ds[j])
            return a && z ? (z / a - 1) * 100 : null
        }
        const ex = (i, j) => { const r = ret(i, j), m = sret(i, j); return r == null || m == null ? null : r - m }
        const end = d + AFTER
        // The stock's OWN usual range: the median width of its 42-session windows ending every 5th session over the
        // year before this window (ends s-252 … s-42 — none overlaps this one, nothing after S). Null under 20 windows.
        const widths = []
        for (let k = s - LOOK; k >= Math.max(LOOK, s - 252); k -= 5) {
            const w = b.slice(k - LOOK + 1, k + 1)
            widths.push((Math.max(...w.map(x => x[2])) / Math.min(...w.map(x => x[3])) - 1) * 100)
        }
        // The next report (≥ 30 days on, so a duplicate date is not it), and the close before it; null past the bars.
        const nextD = hist.get(o.symbol).map(r => r.date).find(x => x >= addDays(D, 30))
        const nd = nextD ? ds.findIndex(x => x >= nextD) : -1
        const ownWidth = widths.length >= 20 ? widths.sort((a, z) => a - z)[Math.floor(widths.length / 2)] : null
        // Traits, all known on the scan day except `beatThis` (the report itself — an outcome, kept apart).
        const tr = []
        for (let k = s - 13; k <= s; k++) tr.push(Math.max(b[k][2], b[k - 1][4]) - Math.min(b[k][3], b[k - 1][4]))
        const past = hist.get(o.symbol).filter(r => r.date < D && r.revenueActual != null)
        const last = past.at(-1), yearAgo = past.at(-5)
        const thisR = hist.get(o.symbol).find(r => r.date === D)
        const prevD = past.at(-1)?.date, pd = prevD ? ds.findIndex(x => x >= prevD) : -1
        const surprise = (r) => (r?.epsActual != null && r?.epsEstimated ? ((r.epsActual - r.epsEstimated) / Math.abs(r.epsEstimated)) * 100 : null)
        // Longer trend, all to the scan day (2026-11-09, "what do the risers have in common").
        const sma = (n) => (s - n + 1 >= 0 ? mean(b.slice(s - n + 1, s + 1).map(x => x[4])) : null)
        const sma50 = sma(50), sma200 = sma(200)
        const hi252 = s >= 251 ? Math.max(...b.slice(s - 251, s + 1).map(x => x[2])) : null
        const last4 = hist.get(o.symbol).filter(r => r.date < D && r.epsActual != null).slice(-4)
        const revSurp = (r) => (r?.revenueActual != null && r?.revenueEstimated ? ((r.revenueActual - r.revenueEstimated) / r.revenueEstimated) * 100 : null)
        rows.push({
            symbol: o.symbol, report: D, scan: ds[s],
            sector: SECTOR.get(o.symbol) ?? '', sp500: inSP(o.symbol, ds[s]) ? 1 : 0,
            price: close, advM: adv / 1e6,
            atrPct: (mean(tr) / close) * 100,
            netChange: (close / b[s - LOOK + 1][4] - 1) * 100,
            fromHigh: (close / hi - 1) * 100,
            revTtmB: past.length >= 4 ? past.slice(-4).reduce((a, r) => a + r.revenueActual, 0) / 1e9 : null,
            revYoy: last && yearAgo?.revenueActual > 0 ? (last.revenueActual / yearAgo.revenueActual - 1) * 100 : null,
            profitable: last?.epsActual != null ? (last.epsActual > 0 ? 1 : 0) : null,
            lastSurprise: surprise(last),
            prevReact: pd > 0 && pd + 1 < b.length && pd + 1 < s ? Math.abs(b[pd + 1][4] / b[pd - 1][4] - 1) * 100 : null,
            beatThis: surprise(thisR) == null ? null : surprise(thisR) > 0 ? 1 : 0,
            // THIS report — known only once it is out (2026-11-09, "the nature of the reports").
            thisEpsSurp: surprise(thisR), thisRevSurp: revSurp(thisR),
            thisRevYoy: thisR?.revenueActual != null && past.at(-4)?.revenueActual > 0 ? (thisR.revenueActual / past.at(-4).revenueActual - 1) * 100 : null,
            // THE ESTIMATE's bar (2026-11-09, "what about estimates?"): the growth this report's consensus asks for —
            // vs the same quarter a year ago (y/y) and vs the last quarter (q/q). Known before the report.
            estEpsYoy: thisR?.epsEstimated != null && past.at(-4)?.epsActual > 0 ? (thisR.epsEstimated / past.at(-4).epsActual - 1) * 100 : null,
            estRevYoy: thisR?.revenueEstimated > 0 && past.at(-4)?.revenueActual > 0 ? (thisR.revenueEstimated / past.at(-4).revenueActual - 1) * 100 : null,
            estRevQoq: thisR?.revenueEstimated > 0 && last?.revenueActual > 0 ? (thisR.revenueEstimated / last.revenueActual - 1) * 100 : null,
            prevReactS: pd > 0 && pd + 1 < b.length && pd + 1 < s ? (b[pd + 1][4] / b[pd - 1][4] - 1) * 100 : null,
            beats4: last4.length === 4 ? last4.filter(r => surprise(r) > 0).length : null,
            lastRevSurprise: revSurp(last),
            chg126: s >= 126 ? (close / b[s - 126][4] - 1) * 100 : null,
            chg252: s >= 252 ? (close / b[s - 252][4] - 1) * 100 : null,
            from52wHigh: hi252 ? (close / hi252 - 1) * 100 : null,
            vs50: sma50 ? (close / sma50 - 1) * 100 : null,
            vs200: sma200 ? (close / sma200 - 1) * 100 : null,
            width: (hi / lo - 1) * 100,
            ownWidth, relWidth: ownWidth ? ((hi / lo - 1) * 100) / ownWidth : null,
            posInRange: (close - lo) / (hi - lo),
            volRatio: dnV ? upV / dnV : null,
            into: ret(s, d - 1), intoX: ex(s, d - 1),
            react: ret(d - 1, d + 1), reactX: ex(d - 1, d + 1),
            after: ret(d + 1, end), afterX: ex(d + 1, end),
            all: ret(s, end), allX: ex(s, end),
            pre5: ret(d - 6, d - 1), pre5X: ex(d - 6, d - 1),
            // The run-up into the report as the market's own expectation (2026-11-09, option 3): 20 and 60 sessions.
            pre20X: d - 21 >= 0 ? ex(d - 21, d - 1) : null, pre60X: d - 61 >= 0 ? ex(d - 61, d - 1) : null,
            nextReport: nd > d + 1 ? ds[nd] : null, sessionsToNext: nd > d + 1 ? nd - 1 - (d + 1) : null,
            toNext: nd > d + 1 ? ret(d + 1, nd - 1) : null, toNextX: nd > d + 1 ? ex(d + 1, nd - 1) : null,
            exitPos: end < b.length ? (b[end][4] > hi ? 'above' : b[end][4] < lo ? 'below' : 'inside') : null,
        })
    }
}

function addDays(d, n) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
function mean(xs) { return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null }
function q(xs, p) { const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }
const f = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`.padStart(w))
const pct = (n, of) => `${of ? Math.round((n / of) * 100) : 0}%`.padStart(5)

const BUCKETS = [['< 10%', 0, 10], ['10–15%', 10, 15], ['15–20%', 15, 20], ['20–30%', 20, 30], ['30%+', 30, Infinity], ['every report', 0, Infinity]]
const lines = []
const say = (s = '') => { lines.push(s); console.log(s) }
say(`RANGE + EARNINGS A WEEK AWAY — ${rows.length} reports, ${new Set(rows.map(r => r.symbol)).size} names, reports ${FROM} → ${rows.map(r => r.report).sort().at(-1)}`)
say(`Range = the ${LOOK} sessions to the scan day (${LEAD} sessions before the report). Moves in %, "vs SPY" = minus SPY over the same closes.`)

function dist(title, key, sets) {
    say(`\n── ${title}`)
    say(`${'range width'.padEnd(13)}${'n'.padStart(6)}${'p10'.padStart(8)}${'p25'.padStart(8)}${'median'.padStart(8)}${'p75'.padStart(8)}${'p90'.padStart(8)}${'mean'.padStart(8)}${'up'.padStart(6)}${'|>10%|'.padStart(8)}`)
    for (const [name, rs] of sets) {
        const xs = rs.map(r => r[key]).filter(x => x != null)
        if (!xs.length) { say(`${name.padEnd(13)}${'0'.padStart(6)}`); continue }
        say(`${name.padEnd(13)}${String(xs.length).padStart(6)}${f(q(xs, 0.1), 8)}${f(q(xs, 0.25), 8)}${f(q(xs, 0.5), 8)}${f(q(xs, 0.75), 8)}${f(q(xs, 0.9), 8)}${f(mean(xs), 8)}${pct(xs.filter(x => x > 0).length, xs.length)}${pct(xs.filter(x => Math.abs(x) > 10).length, xs.length).padStart(8)}`)
    }
}
const byWidth = BUCKETS.map(([n, lo, hi]) => [n, rows.filter(r => r.width >= lo && r.width < hi)])
for (const [t, k] of [['INTO the report (S → D-1)', 'into'], ['  vs SPY', 'intoX'], ['THE REPORT (D-1 → D+1)', 'react'], ['  vs SPY', 'reactX'],
    ['THE MONTH AFTER (D+1 → D+20)', 'after'], ['  vs SPY', 'afterX'], ['ALL (S → D+20)', 'all'], ['  vs SPY', 'allX']]) dist(t, k, byWidth)

say(`\n── WHERE IT STOOD 20 SESSIONS AFTER THE REPORT, against the range`)
say(`${'range width'.padEnd(13)}${'n'.padStart(6)}${'above'.padStart(8)}${'inside'.padStart(8)}${'below'.padStart(8)}`)
for (const [name, rs] of byWidth) {
    const xs = rs.filter(r => r.exitPos)
    say(`${name.padEnd(13)}${String(xs.length).padStart(6)}${pct(xs.filter(r => r.exitPos === 'above').length, xs.length).padStart(8)}${pct(xs.filter(r => r.exitPos === 'inside').length, xs.length).padStart(8)}${pct(xs.filter(r => r.exitPos === 'below').length, xs.length).padStart(8)}`)
}

const tight = rows.filter(r => r.width < 15 && r.volRatio != null)
const acc = [['up-vol > 1.2', tight.filter(r => r.volRatio > 1.2)], ['0.8–1.2', tight.filter(r => r.volRatio >= 0.8 && r.volRatio <= 1.2)], ['up-vol < 0.8', tight.filter(r => r.volRatio < 0.8)]]
say(`\n══ RANGES UNDER 15%, BY VOLUME (up-day volume / down-day volume over the range)`)
for (const [t, k] of [['THE REPORT vs SPY', 'reactX'], ['ALL (S → D+20) vs SPY', 'allX']]) dist(t, k, acc)
const posSets = [['top third', tight.filter(r => r.posInRange >= 2 / 3)], ['middle', tight.filter(r => r.posInRange >= 1 / 3 && r.posInRange < 2 / 3)], ['bottom third', tight.filter(r => r.posInRange < 1 / 3)]]
say(`\n══ RANGES UNDER 15%, BY WHERE PRICE SAT IN THE RANGE ON THE SCAN DAY`)
for (const [t, k] of [['THE REPORT vs SPY', 'reactX'], ['ALL (S → D+20) vs SPY', 'allX']]) dist(t, k, posSets)

fs.writeFileSync(OUT, lines.join('\n') + '\n')
const cols = Object.keys(rows[0] ?? {})
fs.writeFileSync(CSV, [cols.join(','), ...rows.map(r => cols.map(c => (typeof r[c] === 'number' ? r[c].toFixed(3) : r[c] ?? '')).join(','))].join('\n'))
console.log(`\n→ ${OUT}, ${CSV}`)
