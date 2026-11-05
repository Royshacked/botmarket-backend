// THE THESIS LENS'S TOOLS (Roy, 2026-10-30; docs/design/stock-playbook.md) — Mentor judges the stop and the targets from
// the chart; these hand him the facts he judges from (get_price_structure) and do the entry arithmetic once he has the
// user's limits (get_entry_level). The mechanism is services/swingStructure.service.js, shared with the lab that tested
// the approach; this file is only the tool boundary: fetch, call, word the answer.

import { makeToolHandler } from '../agentUtils.js'
import { logger } from '../logger.service.js'
import { getTickerAggregates } from '../../providers/candles.provider.js'
import { structureFacts, entryLevel, toWeekly, mirror, lastTradedUnder } from '../swingStructure.service.js'

const LOG = '[thesisStructure.tools]'
const YEAR_MS = 365 * 86_400_000
const _etDay = (sec) => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const _fixedCents = (x) => Math.round(x * 100) / 100

/** What a short's mirrored facts mean upside down: every price back to positive, high ↔ low. Pure. */
export function unmirrorFacts(f) {
    if (!f) return f
    const p = (x) => (x == null ? x : -x)
    const pt = (s) => (s ? { ...s, type: s.type === 'high' ? 'low' : 'high', price: p(s.price) } : s)
    return {
        ...f, close: p(f.close),
        swings: f.swings.map(pt), last_swing_low: pt(f.last_swing_high), last_swing_high: pt(f.last_swing_low),
        control: f.control === 'buyers' ? 'sellers' : f.control === 'sellers' ? 'buyers' : f.control,
        fall: f.fall ? { rise_from: { ...f.fall.from, price: p(f.fall.from.price) }, high: { ...f.fall.low, price: p(f.fall.low.price) }, atrs: f.fall.atrs } : null,
        candidates: { ...f.candidates, stop: p(f.candidates.stop), deep_stop: p(f.candidates.deep_stop), target: p(f.candidates.target), range_high: p(f.candidates.range_high) },
        heavy_days: f.heavy_days.map(d => ({ ...d, close: p(d.close), change_pct: -d.change_pct })),
        break_candidate: f.break_candidate ? {
            swing_to_break: pt(f.break_candidate.swing_to_break), lower_swing: pt(f.break_candidate.higher_swing),
            rise_high: { ...f.break_candidate.fall_low, price: p(f.break_candidate.fall_low.price) }, stop: p(f.break_candidate.stop),
            stop_is: f.break_candidate.stop_is, floor: p(f.break_candidate.floor), target: p(f.break_candidate.target), context: f.break_candidate.context,
        } : f.break_candidate,
    }
}

/** What the break candidate is, in words for its side. Pure. */
export function breakWords(side = 'long') {
    return side === 'short'
        ? "scenario B's facts: the nearest low under the price (swing_to_break), which a day close under arms B. The stop is ASSUMED: the lower high that break would leave has not printed, so `stop` is the first one the break could confirm plus the noise buffer. `target` is the next swing low under the line, or a measured move; `lower_swing` is the last lower high printed. A starting point you judge."
        : "scenario B's facts: the nearest high over the price (swing_to_break), which a day close over arms B. The stop is ASSUMED: the higher low that break would leave has not printed, so `stop` is the first one the break could confirm minus the noise buffer. `target` is the next swing high over the line, or a measured move; `higher_swing` is the last higher low printed. A starting point you judge."
}

/** `years` of day bars for `sym`, oldest first, dated in ET. `get` — the bar source (a seam). */
async function dayRows(sym, years, get, now) {
    const raw = await get(sym, { timeSpan: 'day', multiplier: 1, from: now - years * YEAR_MS, to: now })
    return (Array.isArray(raw) ? raw : []).filter(b => b?.close > 0)
        .map(b => ({ date: _etDay(b.timestamp), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }))
}

/** The target candidate in words, for the chart and the side it was read on. Pure. */
export function targetWords({ target_kind, lookback_bars }, timeframe = 'day', side = 'long') {
    const bars = `${lookback_bars} ${timeframe === 'week' ? 'weeks' : 'sessions'}`
    if (target_kind === 'measured_move') return `a measured move — at its ${side === 'short' ? 'lows' : 'highs'}, the range's height added ${side === 'short' ? 'under its low' : 'to its high'}`
    return side === 'short'
        ? `the lowest low of the last ${bars} — the start of the rise, or the trend's low before the bounce`
        : `the highest high of the last ${bars} — the start of the fall, or the trend's high before the pullback`
}

/** Whether the week starting Monday `monday` (YYYY-MM-DD) is still trading at `now`: today (ET) is its Monday–Friday. Pure. */
export function unfinishedWeek(monday, now = Date.now()) {
    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const friday = new Date(Date.parse(`${monday}T12:00:00Z`) + 4 * 86_400_000).toISOString().slice(0, 10)
    return today >= monday && today <= friday
}

/**
 * The facts for `sym` on the day or week chart, the right way up for `side` → `{ facts (null under 60 bars), rows,
 * open (the week still trading, or null) }`. One read for the tool and for the turn's break-scenario line.
 */
async function structureRead(sym, timeframe, side, get, now) {
    // Two years of days for a swing read; six for the weekly one (60+ weeks before the first fact).
    const years = timeframe === 'week' ? 6 : 2
    const days = await dayRows(sym, years, get, now)
    const weeks = timeframe === 'week' ? toWeekly(days) : null
    // The week still trading is left out: a swing "confirmed" by a week that has not closed can be gone by Friday.
    const open = weeks?.length && unfinishedWeek(weeks.at(-1).date, now) ? weeks.at(-1) : null
    const rows = weeks ? (open ? weeks.slice(0, -1) : weeks) : days
    const facts = side === 'short' ? unmirrorFacts(structureFacts(mirror(rows))) : structureFacts(rows)
    return { facts, rows, open }
}

/**
 * The facts a thesis ENTRIES turn is told before the model writes (thesis-lens-followups): today's close and normal
 * move, the two candidate stops — what the risk read is made from — and the break candidate (scenario B) or null.
 * → null for a blank ticker or too little history. `get` — the bar source.
 */
export async function thesisTurnFacts({ ticker, timeframe = 'day', side = 'long' }, { get = getTickerAggregates, now = Date.now() } = {}) {
    const sym = String(ticker ?? '').toUpperCase().trim()
    if (!sym) return null
    const tf = timeframe === 'week' ? 'week' : 'day'
    const { facts } = await structureRead(sym, tf, side, get, now)
    if (!facts) return null
    return {
        timeframe: tf, side, close: facts.close, atr: facts.atr,
        stop: facts.candidates.stop, deep_stop: facts.candidates.deep_stop, deep_stop_last_traded: facts.candidates.deep_stop_last_traded,
        target: facts.candidates.target, target_kind: facts.candidates.target_kind, range_high: facts.candidates.range_high,
        break: facts.break_candidate ?? null,
    }
}

/** The facts for `ticker` on the day or week chart, as the JSON text Mentor reads. `get` — the bar source (a seam). */
export async function priceStructureText({ ticker, timeframe = 'day', side = 'long' }, { get = getTickerAggregates, now = Date.now() } = {}) {
    const sym = String(ticker ?? '').toUpperCase().trim()
    if (!sym) return 'Give a ticker.'
    const { facts, rows, open } = await structureRead(sym, timeframe, side, get, now)
    if (!facts) return `Not enough ${timeframe} history for ${sym} (${rows.length} bars; 60 needed).`
    facts.candidates = { ...facts.candidates, target_kind: targetWords(facts.candidates, timeframe, side), lookback_bars: undefined }
    if (facts.break_candidate) facts.break_candidate = { what: breakWords(side), ...facts.break_candidate }
    if (open) facts.this_week = { note: 'still trading — not in the swings above', from: open.date, high: open.high, low: open.low, close: open.close }
    return `${sym} ${timeframe} structure, ${side} side (swings of ≥ ${facts.swing_threshold_atr}× ATR; the candidates are the tested rule's — a starting point you judge, never the answer):\n${JSON.stringify({ ...facts, swing_threshold_atr: undefined })}`
}

/** The entry level as the sentence Mentor reads out. Pure. */
export function entryLevelText({ stop, target, risk_limit_pct, min_rr, side = 'long' }) {
    const r = entryLevel({ stop, target, riskPct: risk_limit_pct ?? null, minRR: min_rr ?? null, side })
    if (r.problem) return `No entry level: ${r.problem}.`
    const under = side === 'short' ? 'and above' : 'and below'
    return `Entry level ${r.level} (${under}) — set by the ${r.by === 'risk_limit' ? 'risk limit' : 'reward to risk'}. At the level: reward to risk ${r.rr_at_level}, the stop $${_fixedCents(Math.abs(r.level - Number(stop)))} (${r.risk_pct_at_level}%) away. This is the entry leg's price; an entry past it is no trade.`
}

/**
 * The entry level, and — given the `ticker` — the last date price traded past the stop (under it; over, on a short):
 * "a price it has not visited since" is read off the bars, never guessed (GNRC drive 5, 2026-11-02: "since September 8"
 * for a stop last traded under on Feb 5). A bar fetch that fails still answers the level. `get` — the bar source.
 */
export async function entryLevelReply(args, { get = getTickerAggregates, now = Date.now() } = {}) {
    const text = entryLevelText(args)
    const sym = String(args?.ticker ?? '').toUpperCase().trim()
    const stop = Number(args?.stop)
    if (!sym || text.startsWith('No entry level')) return text
    const short = args.side === 'short', past = short ? 'over' : 'under'
    let rows
    const unread = `${text} (When ${sym} last traded ${past} ${stop} could not be read.)`
    try { rows = await dayRows(sym, 2, get, now) } catch (err) {
        logger.warn(LOG, `last visit ${past} the stop for ${sym} — not read`, err.message)
        return unread
    }
    // No bars is "not read", never "not traded" (CR 2026-11-03): an empty feed would otherwise hand Mentor the very
    // invented "not since" this line exists to stop.
    if (!rows.length) return unread
    const j = short ? lastTradedUnder(mirror(rows), -stop) : lastTradedUnder(rows, stop)
    return `${text} ${sym} last traded ${past} ${stop} on ${j == null ? `no day in the last two years (${rows.length} sessions read)` : rows[j].date}.`
}

export const THESIS_STRUCTURE_HANDLERS = {
    get_price_structure: makeToolHandler('get_price_structure', (args) => priceStructureText(args),
        (err, { ticker }) => `Could not read the structure of ${ticker}: ${err.message}`, LOG),
    get_entry_level: makeToolHandler('get_entry_level', (args) => entryLevelReply(args),
        (err) => `Could not compute the entry level: ${err.message}`, LOG),
}
