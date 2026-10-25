// ARGUS'S JUDGMENT, REPLAYED ON PAST WEEKS (Roy, 2026-10-25: "build the Argus replay"). The winners study
// (screenerLab winnersStudy) found that what precedes a big week — volatility, a report, the sector — precedes the big
// LOSERS as much: price and volume pick the movers, not their direction. Most moves were news. So: can Argus's reading of
// the news tell the week's winners from its losers?
//
// THE TEST, FAIR BY CONSTRUCTION. Each week, from that Monday's likely movers (MOVER_VOL — a 20-day volatility of
// MOVER_VOL% or more — or a report inside the week), a sample of `per` names that went on to beat SPY by MOVE% or more,
// `per` that lagged it by as much, and `per` in between — shuffled, the outcome hidden. Argus reads them as he reads the
// live board (hotlist.argus — the same prompt, the same normalizing): the week column's cells from the same overnight
// stats and free range (dailyScreener.stats, hotlist.columns), each name's headlines up to Monday's open. His picks and
// avoids are then scored on the week (screenerLab trade: Monday's open to Friday's close, against SPY, after the cost).
// A third of the sample went up hard, a third down: picks no better than that are no judgment.
//
// `tech` puts each row's technicals on it (techLine) — the re-run (Roy, 2026-10-25: "Argus should check headlines and
// technicals"). The model must not remember the weeks: the house model is asked its cutoff before a run (the script). Pure, but for
// the reads the deps make.

import { screenerStats } from './dailyScreener.stats.js'
import { overheadLevels, freeRange } from './hotlist.columns.js'
import { withNews } from './hotlist.boards.js'
import { argusRead, techLine } from './hotlist.argus.js'
import { trade, testable } from './screenerLab.service.js'

/** A likely mover: a 20-day volatility of daily closes at least this % of the price — or a report inside the week. */
export const MOVER_VOL = 8
/** The sample's outcome bands: beat SPY by this % or more over the week — or lagged it by as much. */
export const MOVE = 5
/** How many names of each band a week's sample takes. */
export const PER_BAND = 10
/** Days of headlines before Monday's open that Argus reads. */
export const NEWS_DAYS = 10

const _r = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
const _mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const _addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** A seeded generator (mulberry32) — the same week draws the same sample on every run. Pure. */
export function seeded(text) {
    let a = [...String(text)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 1779033703)
    return () => {
        a = (a + 0x6D2B79F5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/**
 * The week's likely movers, each with how it went (hidden from Argus) → `[{ symbol, s, i0, i1, net, band }]`; `band`
 * 'up' (net ≥ MOVE), 'down' (net ≤ −MOVE) or 'flat'. `ds` the week's sessions. Pure.
 */
export function weekMovers(data, ds) {
    const out = []
    for (const [symbol, s] of data.names) {
        const i0 = s.ind.date.indexOf(ds[0]), i1 = s.ind.date.indexOf(ds.at(-1))
        if (i0 < 1 || i1 < i0 || !testable(s.rows, i0, s.ind)) continue
        const j = i0 - 1, vol = s.ind.sd20[j] != null && s.ind.sma20[j] > 0 ? (s.ind.sd20[j] / s.ind.sma20[j]) * 100 : null
        let report = false
        for (let k = i0; k <= i1; k++) if (s.reports.has(s.ind.date[k])) report = true
        if (!(vol >= MOVER_VOL) && !report) continue
        const t = trade({ rows: s.rows, i: i0, ind: s.ind, hold: i1 - i0 + 1, spyByDay: data.spyByDay })
        if (!t) continue
        out.push({ symbol, s, i0, i1, net: t.net, band: t.net >= MOVE ? 'up' : t.net <= -MOVE ? 'down' : 'flat' })
    }
    return out
}

/** `per` of each band, drawn with `rand`, shuffled together. Pure. */
export function sampleWeek(movers, { per = PER_BAND, rand = Math.random } = {}) {
    const draw = (xs, n) => {
        const a = [...xs]
        for (let k = a.length - 1; k > 0; k--) { const m = Math.floor(rand() * (k + 1)); [a[k], a[m]] = [a[m], a[k]] }
        return a.slice(0, n)
    }
    const picked = ['up', 'down', 'flat'].flatMap(b => draw(movers.filter(x => x.band === b), per))
    return draw(picked, picked.length)
}

/**
 * The sample as a week-column board in the live shape (hotlist.argus boardText): each row's price, ATR and next report
 * from the bars to the Friday before, the week cell's free range from the same overnight stats the Hotlist grades from;
 * the regime from the whole universe that evening. `headlines` Map(symbol → [{ title, at }]). Pure.
 */
export function boardFor(data, ds, sample, headlines = new Map(), { tech = false } = {}) {
    const j0 = (s) => s.ind.date.indexOf(ds[0]) - 1
    const fri = data.spyDays[data.spyDays.indexOf(ds[0]) - 1]
    const spyRows = data.spyDays.filter(d => d <= fri).map(d => data.spyByDay.get(d))
    const rows = sample.map(({ symbol, s }) => {
        const j = j0(s)
        const stats = screenerStats(s.rows.slice(0, j + 1), spyRows)
        const next = [...s.reports.keys()].sort().find(d => d >= ds[0] && d <= _addDays(ds[0], 21)) ?? null
        return {
            symbol, sector: s.sector ?? null, price: stats?.close ?? s.rows[j].close, gap_pct: null, atr_pct: stats?.atr_pct ?? null,
            catalyst: null, next_earnings: next,
            // `tech` (2026-10-25, the re-run): the chart beside the story — techLine, the 200-day from the lab's bars.
            ...(tech ? { tech: techLine(stats, { sma200: s.ind.sma200[j] }) } : {}),
            cells: { week: { grade: 'in play', range: stats ? freeRange(stats.close, overheadLevels('week', stats), stats.atr14) : null } },
        }
    })
    // The regime that Friday: the share of the universe over its 20-day average; SPY against its own, its 5-session return.
    let over = 0, n = 0
    for (const s of data.names.values()) {
        const j = s.ind.date.indexOf(fri)
        if (j < 0 || s.ind.sma20[j] == null) continue
        n++
        if (s.rows[j].close > s.ind.sma20[j]) over++
    }
    const k = spyRows.length - 1
    const spy20 = k >= 19 ? _mean(spyRows.slice(-20).map(b => b.close)) : null
    return {
        id: `argus-replay-${ds[0]}`, checkpoint: 'before the open', day: ds[0], columns: ['week'],
        regime: { breadth_above_sma20: n ? (over / n) * 100 : null,
            spy: { above_sma20: spy20 != null && spyRows[k].close > spy20, ret5: k >= 5 ? (spyRows[k].close / spyRows[k - 5].close - 1) * 100 : null } },
        rows: withNews(rows, headlines), pool: [],
    }
}

/** FMP news rows → Map(symbol → [{ title, at }]), only what was out before `cutoff` ('YYYY-MM-DD HH:MM'). Pure. */
export function headlinesBefore(news, cutoff) {
    const out = new Map()
    for (const n of news ?? []) {
        const s = String(n?.symbol ?? '').toUpperCase(), at = String(n?.publishedDate ?? '')
        if (!s || !at || !(at < cutoff) || !n.title) continue
        if (!out.has(s)) out.set(s, [])
        out.get(s).push({ title: n.title, at })
    }
    return out
}

/**
 * One week's sample scored on Argus's read → `{ start, picks, avoid, rest }`, each `{ n, net_mean, up, down }` (`up`/
 * `down` the names of that band). Pure.
 */
export function scoreWeek(start, sample, read) {
    const picked = new Set((read?.picks ?? []).map(p => p.symbol)), avoided = new Set((read?.avoid ?? []).map(a => a.symbol))
    const group = (xs) => ({ n: xs.length, net_mean: _r(_mean(xs.map(x => x.net))), up: xs.filter(x => x.band === 'up').length, down: xs.filter(x => x.band === 'down').length })
    return {
        start,
        picks: group(sample.filter(x => picked.has(x.symbol))),
        avoid: group(sample.filter(x => avoided.has(x.symbol))),
        rest: group(sample.filter(x => !picked.has(x.symbol) && !avoided.has(x.symbol))),
        all: group(sample),
        names: sample.map(x => ({ symbol: x.symbol, net: _r(x.net), band: x.band, call: picked.has(x.symbol) ? 'pick' : avoided.has(x.symbol) ? 'avoid' : null })),
    }
}

/**
 * The replay's weeks summed → per call (picks / avoid / rest / all): the names, the mean net, the share that went up
 * hard against down hard, and the mean of each WEEK's mean (each week once — the names of a week move together). Pure.
 */
export function summarizeArgusReplay(weeks) {
    const sum = (key) => {
        const ws = weeks.filter(w => w[key].n)
        const names = weeks.flatMap(w => w.names.filter(x => (key === 'all') || (key === 'picks' ? x.call === 'pick' : key === 'avoid' ? x.call === 'avoid' : x.call == null)))
        const up = names.filter(x => x.band === 'up').length, down = names.filter(x => x.band === 'down').length
        const means = ws.map(w => w[key].net_mean)
        const m = _mean(means), sd = means.length > 1 ? Math.sqrt(means.reduce((s, x) => s + (x - m) ** 2, 0) / (means.length - 1)) : null
        return { names: names.length, weeks: ws.length, net_mean: _r(_mean(names.map(x => x.net))), week_mean: _r(m),
            ci95: sd != null ? [_r(m - 1.96 * sd / Math.sqrt(means.length)), _r(m + 1.96 * sd / Math.sqrt(means.length))] : null,
            up, down, up_share: up + down ? _r((up / (up + down)) * 100, 1) : null }
    }
    return { picks: sum('picks'), avoid: sum('avoid'), rest: sum('rest'), all: sum('all') }
}

/**
 * Replay one week: its sample, the headlines (deps.news), Argus's read (deps.read — argusRead by default) → the scored
 * week, plus the read itself; null when the read failed (argusRead fails soft). `deps` = `{ news(symbols, from, to),
 * read(board), rand }`.
 */
export async function replayArgusWeek(data, ds, { per = PER_BAND, tech = false, deps }) {
    const sample = sampleWeek(weekMovers(data, ds), { per, rand: deps.rand ?? seeded(ds[0]) })
    if (!sample.length) return null
    // FMP stamps news in UTC-ish time with no zone (newsArticle): 13:00 is before 09:30 ET in either season.
    const news = await deps.news(sample.map(x => x.symbol), _addDays(ds[0], -NEWS_DAYS), ds[0])
    const board = boardFor(data, ds, sample, headlinesBefore(news, `${ds[0]} 13:00`), { tech })
    const read = await (deps.read ?? argusRead)(board)
    if (!read) return null
    return { ...scoreWeek(ds[0], sample, read), summary: read.summary, model: read.model, read: { picks: read.picks, avoid: read.avoid } }
}
