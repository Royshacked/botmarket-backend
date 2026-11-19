// ECHO'S RETURN CALCULATOR (docs/design/echo-pipeline.md, Steps 4 and 7) — ported from the engine's echo/returns.py and
// echo/events.py day0, so the numbers mean the same thing on both sides.
//
// An event + tickers → each name's return, and its excess over SPY and over its SPDR sector fund, at 1, 5, 20, 60 and
// 120 sessions, on two bases:
//   reaction  from the last close BEFORE the event, the gap included — what Step 4 compares across layers;
//   tradable  from the Day 0 OPEN — what a trade taken on the news could have had (Step 7 grades this).
// Plus the doc's "the market noticed" signal: VOLUME over Day 0 → day k against the 20 sessions before the event.
//
// DAY 0 (the doc's default, the engine's): an event before the open counts from that day's open (the next session's
// when the day is not one); during the session or after the close, from the NEXT session's open.
//
// Bars are FMP's DIVIDEND-ADJUSTED daily series (the engine's endpoint): one request per symbol per event, one scale —
// an unadjusted series shows a split as a −50% day. A missing bar is missing, never a neighbouring day.

import { fmpGet } from '../providers/fmp.price.provider.js'
import { createTtlCache } from './ttlCache.util.js'
import { logger } from './logger.service.js'

const LOG = '[echoReturns]'
export const HORIZONS = [1, 5, 20, 60, 120]
export const BENCHMARK = 'SPY'
export const VOLUME_BASE = 20
const LOOKBACK_DAYS = 40      // calendar days before: the reaction base and 20 sessions of volume
const LOOKAHEAD_DAYS = 200    // calendar days after: 120 sessions and holidays

// GICS sector → its SPDR fund (the engine's table).
export const SECTOR_ETF = { 10: 'XLE', 15: 'XLB', 20: 'XLI', 25: 'XLY', 30: 'XLP', 35: 'XLV', 40: 'XLF', 45: 'XLK', 50: 'XLC', 55: 'XLU', 60: 'XLRE' }
const SECTOR_CODE = {
    energy: 10, 'basic materials': 15, materials: 15, industrials: 20, 'consumer cyclical': 25, 'consumer discretionary': 25,
    'consumer defensive': 30, 'consumer staples': 30, healthcare: 35, 'health care': 35, 'financial services': 40, financials: 40,
    technology: 45, 'information technology': 45, 'communication services': 50, utilities: 55, 'real estate': 60,
}
/** The SPDR fund for a sector name (FMP's or GICS's), or null. Pure. */
export function sectorEtf(sector) {
    const code = SECTOR_CODE[String(sector ?? '').trim().toLowerCase()]
    return code ? SECTOR_ETF[code] : null
}

/** First index in sorted `xs` with xs[i] >= x (left) or > x (right). Pure. */
function bisect(xs, x, right = false) {
    let lo = 0, hi = xs.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (right ? xs[m] <= x : xs[m] < x) lo = m + 1; else hi = m }
    return lo
}

/** Day 0's index in the sorted session list, or null past its end. Pure. */
export function day0Index(ev, sessions) {
    const i = ev.timing === 'before_open' ? bisect(sessions, ev.date) : bisect(sessions, ev.date, true)
    return i < sessions.length ? i : null
}

const ret = (bars, base, field, end) => {
    const b = bars?.[base], e = bars?.[end]
    if (!b || !e || !b[field] || e.close == null) return null
    return e.close / b[field] - 1
}
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)

/**
 * One name's returns for one event. Pure: `bars` holds the name, SPY and `etf` as {date: {open, high, low, close,
 * volume}}; `sessions` is SPY's sorted trading days. Every number it cannot honestly compute is null, with the reason in
 * `missing`. → `{ ticker, sectorEtf, day0, base, gap, openSuspect, horizons: {h: {...}}, volume: {h: ratio}, missing }`.
 */
export function measure(ev, ticker, bars, sessions, etf = null, horizons = HORIZONS) {
    const row = { ticker, sectorEtf: etf, day0: null, base: null, gap: null, openSuspect: false, horizons: {}, volume: {}, missing: [] }
    const i0 = day0Index(ev, sessions)
    if (i0 == null) { row.missing.push('no session on or after the event in the price calendar'); return row }
    const d0 = sessions[i0]
    // The last close BEFORE the event: the session before Day 0 — except an event DURING a session, whose own close
    // came after it, so the base is the session before that one.
    let ib = i0 - 1
    if (ev.timing === 'during_session' && ib >= 0 && sessions[ib] === ev.date) ib -= 1
    const base = ib >= 0 ? sessions[ib] : null
    Object.assign(row, { day0: d0, base })
    const mine = bars[ticker] ?? {}
    const traded = Boolean(mine[d0])
    if (!traded) row.missing.push(`no ${ticker} bar on Day 0 (${d0})`)
    else {
        row.openSuspect = mine[d0].open === mine[d0].close
        if (row.openSuspect) row.missing.push(`${ticker}'s Day 0 open equals its close — not traded from (tradable left empty)`)
        if (base && mine[base]?.close) row.gap = mine[d0].open / mine[base].close - 1
    }
    const spy = bars[BENCHMARK] ?? {}, sec = etf ? bars[etf] ?? {} : {}
    if (etf && !sec[d0]) row.missing.push(`${etf} did not trade on Day 0 — no sector excess`)
    // Volume: the 20 sessions before the event against Day 0 → day h (the doc: "heavy volume means the market noticed").
    const before = sessions.slice(Math.max(0, (ib >= 0 ? ib : 0) - VOLUME_BASE + 1), ib + 1).map(d => mine[d]?.volume).filter(v => Number.isFinite(v) && v > 0)
    const baseVol = before.length >= VOLUME_BASE / 2 ? avg(before) : null
    for (const h of horizons) {
        const j = i0 + h - 1
        if (j >= sessions.length) {
            row.horizons[h] = { tradable: null, reaction: null, xsSpyTradable: null, xsSpyReaction: null, xsSectorTradable: null, xsSectorReaction: null }
            row.volume[h] = null
            row.missing.push(`${h}d: the calendar ends before it`)
            continue
        }
        const end = sessions[j]
        // STRICT: no Day 0 bar (a halt) → no number at all; a suspect open → no TRADABLE number, the reaction stands.
        const tTrad = traded && !row.openSuspect ? ret(mine, d0, 'open', end) : null
        const tReac = traded && base ? ret(mine, base, 'close', end) : null
        if (traded && tReac == null) row.missing.push(`${h}d: no ${ticker} bar on ${end}`)
        const out = { tradable: tTrad, reaction: tReac }
        for (const [name, bench] of [['Spy', spy], ['Sector', sec]]) {
            const bTrad = ret(bench, d0, 'open', end)
            const bReac = base ? ret(bench, base, 'close', end) : null
            out[`xs${name}Tradable`] = tTrad == null || bTrad == null ? null : tTrad - bTrad
            out[`xs${name}Reaction`] = tReac == null || bReac == null ? null : tReac - bReac
        }
        row.horizons[h] = out
        const during = sessions.slice(i0, j + 1).map(d => mine[d]?.volume).filter(v => Number.isFinite(v))
        row.volume[h] = baseVol && during.length === j - i0 + 1 ? avg(during) / baseVol : null
    }
    return row
}

/** The calendar range one event needs, capped at today. Pure. */
export function windowFor(ev, today = new Date()) {
    const d = new Date(`${ev.date}T00:00:00Z`)
    const from = new Date(d.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10)
    const end = new Date(Math.min(d.getTime() + LOOKAHEAD_DAYS * 86_400_000, today.getTime())).toISOString().slice(0, 10)
    return { from, to: end }
}

const BARS_TTL_MS = 30 * 60 * 1000
const _barsCache = createTtlCache({ ttlMs: BARS_TTL_MS, max: 400 })

/** {date: bar} from FMP's dividend-adjusted series over [from, to]. One request, one scale. Throws on a failed read. */
export async function fetchBars(symbol, from, to) {
    const key = `${symbol}|${from}|${to}`
    const hit = _barsCache.get(key)
    if (hit) return hit
    const rows = await fmpGet(`/historical-price-eod/dividend-adjusted?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`, { label: `FMP adjusted ${symbol}` })
    const out = {}
    for (const r of Array.isArray(rows) ? rows : []) {
        const d = String(r?.date ?? '').slice(0, 10)
        const close = Number(r?.adjClose)
        if (!d || !Number.isFinite(close)) continue
        const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : close)
        out[d] = { open: n(r.adjOpen), high: n(r.adjHigh), low: n(r.adjLow), close, volume: Number(r.volume) || 0 }
    }
    _barsCache.set(key, out)
    return out
}

/** Today's New York date while its session may still be trading (before 16:15 ET), else null. Pure. */
export function unfinishedSession(now = new Date()) {
    const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const minutes = ny.getHours() * 60 + ny.getMinutes()
    return minutes < 16 * 60 + 15 ? now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : null
}

const _deps = { bars: fetchBars, now: () => new Date() }
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * The closed sessions from `from` (YYYY-MM-DD) to today — SPY's calendar, one cached read, the session in progress left
 * out. What a step reads to know whether its day has come BEFORE it fetches every name (CR 2026-11-19).
 */
export async function closedSessionsSince(from) {
    const now = _deps.now()
    const open = unfinishedSession(now)
    const spy = await _deps.bars(BENCHMARK, from, now.toISOString().slice(0, 10))
    return Object.keys(spy ?? {}).filter(d => d !== open).sort()
}

/**
 * Every ticker's row for one event. `sectors` is {ticker: SPDR fund or null}. SPY failing stops the event (no calendar);
 * any other symbol failing costs only that symbol — its row says why. → `{ sessions, rows }`.
 */
export async function eventReturns(ev, tickers, sectors = {}) {
    const now = _deps.now()
    const { from, to } = windowFor(ev, now)
    const spy = await _deps.bars(BENCHMARK, from, to)
    // TODAY'S BAR before the close is a price, not a close: FMP serves the session in progress. It is no session of the
    // calendar until 16:15 New York time, so no horizon ends on a number that will still move.
    const open = unfinishedSession(now)
    const sessions = Object.keys(spy).filter(d => d !== open).sort()
    if (!sessions.length) throw new Error(`no ${BENCHMARK} bars for ${from}..${to} — the calendar is empty`)
    const bars = { [BENCHMARK]: spy }
    const failed = {}
    const symbols = [...new Set([...tickers, ...Object.values(sectors).filter(Boolean)])]
    for (const s of symbols) {
        if (bars[s]) continue
        try { bars[s] = await _deps.bars(s, from, to) } catch (err) { bars[s] = {}; failed[s] = err.message }
    }
    if (Object.keys(failed).length) logger.warn(LOG, 'prices failed for some names', { event: ev.id, failed: Object.keys(failed) })
    const rows = tickers.map(t => {
        const row = measure(ev, t, bars, sessions, sectors[t] ?? null)
        for (const s of [t, sectors[t]]) if (s && failed[s]) row.missing.unshift(`${s} prices failed — ${failed[s]}`)
        return row
    })
    return { sessions, rows }
}

export const echoReturnsService = { eventReturns, measure, day0Index, sectorEtf, fetchBars, closedSessionsSince }
