// THE THESIS LENS'S TOOLS (Roy, 2026-10-30; docs/design/stock-playbook.md) — Mentor judges the stop and the targets from
// the chart; these hand him the facts he judges from (get_price_structure) and do the entry arithmetic once he has the
// user's limits (get_entry_level). The mechanism is services/swingStructure.service.js, shared with the lab that tested
// the approach; this file is only the tool boundary: fetch, call, word the answer.

import { makeToolHandler } from '../agentUtils.js'
import { getTickerAggregates } from '../../providers/candles.provider.js'
import { structureFacts, entryLevel, toWeekly, mirror } from '../swingStructure.service.js'

const LOG = '[thesisStructure.tools]'
const YEAR_MS = 365 * 86_400_000
const _etDay = (sec) => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

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
        candidates: { ...f.candidates, stop: p(f.candidates.stop), deep_stop: p(f.candidates.deep_stop), target: p(f.candidates.target) },
        heavy_days: f.heavy_days.map(d => ({ ...d, close: p(d.close), change_pct: -d.change_pct })),
    }
}

/** The target candidate in words, for the chart and the side it was read on. Pure. */
export function targetWords({ target_kind, lookback_bars }, timeframe = 'day', side = 'long') {
    const bars = `${lookback_bars} ${timeframe === 'week' ? 'weeks' : 'sessions'}`
    if (target_kind === 'measured_move') return `a measured move — at its ${side === 'short' ? 'lows' : 'highs'}, the range's height added ${side === 'short' ? 'under its low' : 'to its high'}`
    return side === 'short'
        ? `the lowest low of the last ${bars} — the start of the rise, or the trend's low before the bounce`
        : `the highest high of the last ${bars} — the start of the fall, or the trend's high before the pullback`
}

/** The facts for `ticker` on the day or week chart, as the JSON text Mentor reads. `get` — the bar source (a seam). */
export async function priceStructureText({ ticker, timeframe = 'day', side = 'long' }, { get = getTickerAggregates, now = Date.now() } = {}) {
    const sym = String(ticker ?? '').toUpperCase().trim()
    if (!sym) return 'Give a ticker.'
    // Two years of days for a swing read; six for the weekly one (60+ weeks before the first fact).
    const years = timeframe === 'week' ? 6 : 2
    const raw = await get(sym, { timeSpan: 'day', multiplier: 1, from: now - years * YEAR_MS, to: now })
    const days = (Array.isArray(raw) ? raw : []).filter(b => b?.close > 0)
        .map(b => ({ date: _etDay(b.timestamp), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }))
    const rows = timeframe === 'week' ? toWeekly(days) : days
    const facts = side === 'short' ? unmirrorFacts(structureFacts(mirror(rows))) : structureFacts(rows)
    if (!facts) return `Not enough ${timeframe} history for ${sym} (${rows.length} bars; 60 needed).`
    facts.candidates = { ...facts.candidates, target_kind: targetWords(facts.candidates, timeframe, side), lookback_bars: undefined }
    return `${sym} ${timeframe} structure, ${side} side (swings of ≥ ${facts.swing_threshold_atr}× ATR; the candidates are the tested rule's — a starting point you judge, never the answer):\n${JSON.stringify({ ...facts, swing_threshold_atr: undefined })}`
}

/** The entry level as the sentence Mentor reads out. Pure. */
export function entryLevelText({ stop, target, risk_limit_pct, min_rr, side = 'long' }) {
    const r = entryLevel({ stop, target, riskPct: risk_limit_pct ?? null, minRR: min_rr ?? null, side })
    if (r.problem) return `No entry level: ${r.problem}.`
    const under = side === 'short' ? 'and above' : 'and below'
    return `Entry level ${r.level} (${under}) — set by the ${r.by === 'risk_limit' ? 'risk limit' : 'reward to risk'}. At the level: reward to risk ${r.rr_at_level}, the stop ${r.risk_pct_at_level}% away. This is the entry leg's price; an entry past it is no trade.`
}

export const THESIS_STRUCTURE_HANDLERS = {
    get_price_structure: makeToolHandler('get_price_structure', (args) => priceStructureText(args),
        (err, { ticker }) => `Could not read the structure of ${ticker}: ${err.message}`, LOG),
    get_entry_level: makeToolHandler('get_entry_level', async (args) => entryLevelText(args),
        (err) => `Could not compute the entry level: ${err.message}`, LOG),
}
