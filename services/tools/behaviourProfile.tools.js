/**
 * get_behaviour_profile — Proteus's measured profile as text (docs/design/proteus.md §2, §6). The numbers come from
 * code (behaviourProfile.engine, counted from candles, every rate against a baseline); this formatter only lays them
 * out so the model reads them the way they were meant: a rule "holds" only when it cleared the bar, a near-miss is
 * a near-miss, and "nothing holds" is the usual and honest answer (the 11-name sample: 0 of 396 tests held, out of
 * sample — docs/design/proteus.md §10).
 *
 * UNBOUND — no userId: the profile is the house's. READ-ONLY apart from the shared weekly cache.
 */

import { makeToolHandler } from '../agentUtils.js'
import { profileFor } from '../behaviourProfile.service.js'
import { PROFILE } from '../behaviourProfile.engine.js'

const LOG = '[behaviourProfile.tools]'

export const BEHAVIOUR_PROFILE_TOOL_SPEC = {
    get_behaviour_profile: `The MEASURED behaviour profile of one stock — how its price has actually behaved, counted from its candles on 5-minute (~3 months), 1-hour (~1 year), daily (~10 years) and weekly (~10 years) bars, LONG SIDE: does it hold at the 20 EMA / 50 / 200 SMA / VWAP, what follows RSI under 30, a MACD cross up, a high-volume up bar; how often its breaks of a swing low are FALSE (closed back above within 3 bars), how deep those sweeps go in ATRs, how many bars until it picks a direction; whether bullish order blocks hold on a retest; its ATR %, gap, dollar volume; and whether it fits a day trade / a swing. Every rate is against a BASELINE (the same line shifted, or the stock's own drift) and must still hold in the most recent third. Kept for a week, shared by everyone; the first ask for a name takes several seconds. \`ticker\`; \`fresh: true\` recomputes now (only when the user asks for it).`,
}

const _pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—')
const LABEL = Object.freeze({
    ema20: '20 EMA', sma50: '50 SMA', sma200: '200 SMA', vwap: 'VWAP',
    rsi_oversold: 'RSI under 30', macd_cross_up: 'MACD cross up', volume_up_bar: 'high-volume up bar',
})
const VERDICT = Object.freeze({
    respects: 'HOLDS', faded: 'held in the older history, NOT lately', unconfirmed: 'held, too few recent cases to confirm',
    no: 'no edge', thin: 'too few cases to say',
})
const TF = Object.freeze({ '5min': '5-MINUTE', '1hour': '1-HOUR', day: 'DAILY', week: 'WEEKLY' })

/**
 * One test → "20 EMA: no edge — 66% vs 71% baseline (53 touches in the older two-thirds, z -0.5; recent third 71% vs
 * 70%, 18)". The rate and z are the older part's — where the rule is found; the recent third is the check. Pure.
 */
export function testLine(name, s, unit = 'cases') {
    if (!s.n && !s.recent?.n) return `${name}: none in this history`
    const recent = s.recent?.n ? `; recent third ${_pct(s.recent.rate)} vs ${_pct(s.recent.base)}, ${s.recent.n}` : ''
    return `${name}: ${VERDICT[s.verdict] ?? s.verdict} — ${_pct(s.rate)} vs ${_pct(s.base)} baseline (${s.n} ${unit} in the older two-thirds${Number.isFinite(s.z) ? `, z ${s.z}` : ''}${recent})`
}

/** One timeframe → its lines. Pure. */
export function timeframeLines(tf, t) {
    if (!t) return [`${TF[tf] ?? tf}: too few bars to measure (the 200 SMA needs ~260)`]
    const fb = t.false_breaks
    const head = [`${TF[tf] ?? tf} (${t.bars} bars, ${t.from.slice(0, 10)} → ${t.to.slice(0, 10)}): ATR ${t.atr_pct != null ? `${t.atr_pct}%` : 'unknown'}`,
        t.gap_pct != null ? `typical gap ${t.gap_pct}%` : null,
        `base win rate ${_pct(t.drift.rate)} (the drift any bar has)`].filter(Boolean).join(' · ')
    return [
        head,
        ...Object.entries(t.indicators).map(([k, s]) => `  ${testLine(LABEL[k] ?? k, s, ['ema20', 'sma50', 'sma200', 'vwap'].includes(k) ? 'touches' : 'events')}`),
        `  Breaks of a swing low: ${fb.breaks}, ${_pct(fb.false_rate)} FALSE (closed back above within ${PROFILE.sweepBack} bars; recent ${_pct(fb.recent.false_rate)})` +
            `${fb.sweep_depth_atr?.median != null ? `; sweeps went ${fb.sweep_depth_atr.median} ATR under the low (80% within ${fb.sweep_depth_atr.p80})` : ''}` +
            `${fb.bars_to_direction != null ? `; a direction ~${fb.bars_to_direction} bars after the break` : ''}`,
        `  ${testLine('After a sweep (from the reclaim)', fb.after_sweep, 'sweeps')}`,
        `  ${testLine(`Bullish order blocks (${t.order_blocks.blocks} found) on a retest`, t.order_blocks, 'retests')}`,
    ]
}

/** The whole profile → the tool's text. Pure. */
export function formatProfile(p) {
    const holds = Object.entries(p.timeframes).flatMap(([tf, t]) => (t ? [
        ...Object.entries(t.indicators).filter(([, s]) => s.verdict === 'respects').map(([k]) => `${LABEL[k] ?? k} (${TF[tf].toLowerCase()})`),
        ...(t.false_breaks.after_sweep.verdict === 'respects' ? [`sweeps of lows (${TF[tf].toLowerCase()})`] : []),
        ...(t.order_blocks.verdict === 'respects' ? [`order blocks (${TF[tf].toLowerCase()})`] : []),
    ] : []))
    const fit = (v) => `${v.fits ? 'yes' : 'no'} — ${v.why}${v.edges.length ? ` (${v.edges.join(', ')})` : ''}`
    return [
        `${p.symbol} — measured behaviour profile, long side, computed ${String(p.computed_at ?? '').slice(0, 10)}.`,
        `How to read it: a test HOLDS only when it beat its baseline by ${PROFILE.edge * 100}+ points at z ≥ ${PROFILE.z} in the OLDER two-thirds of the history AND still beat it in the most recent third, which the finding never saw. Win = +${PROFILE.up} ATR before a close ${PROFILE.down} ATR lower, within ${PROFILE.horizon} bars. Across 11 names tested, none held — "nothing holds" is the usual answer; daily and weekly samples are small, so a strong rate that did not clear is a near-miss; a hold can still be chance.`,
        `WHAT HOLDS: ${holds.length ? holds.join('; ') : 'nothing — no indicator, sweep or order-block rule beat its baseline on any timeframe'}.`,
        '',
        ...Object.entries(p.timeframes).flatMap(([tf, t]) => [...timeframeLines(tf, t), '']),
        `FITS: day trade ${fit(p.suitability.day_trade)}. Swing ${fit(p.suitability.swing)}.`,
    ].join('\n')
}

/**
 * The profile as ONE line — what Mentor reads beside Prometheus's coverage to decide a trade, and the line Proteus posts in
 * the chat (argus-rework.md §2.3): what holds (or nothing), the daily false breaks and their depth, the daily ATR, the fit.
 * Pure.
 */
export function profileBrief(p) {
    const tfs = p?.timeframes ?? {}
    const holds = Object.entries(tfs).flatMap(([tf, t]) => (t ? [
        ...Object.entries(t.indicators).filter(([, s]) => s.verdict === 'respects').map(([k]) => `${LABEL[k] ?? k} (${TF[tf].toLowerCase()})`),
        ...(t.false_breaks.after_sweep.verdict === 'respects' ? [`sweeps of lows (${TF[tf].toLowerCase()})`] : []),
        ...(t.order_blocks.verdict === 'respects' ? [`order blocks (${TF[tf].toLowerCase()})`] : []),
    ] : []))
    const d = tfs.day
    const fb = d?.false_breaks
    const fit = p?.suitability ? `day trade ${p.suitability.day_trade.fits ? 'yes' : 'no'}, swing ${p.suitability.swing.fits ? 'yes' : 'no'}` : null
    return [
        holds.length ? `holds: ${holds.join(', ')}` : 'nothing technical holds',
        fb?.breaks ? `breaks of a daily swing low are false ${_pct(fb.false_rate)}${fb.sweep_depth_atr?.median != null ? `, sweeps ~${fb.sweep_depth_atr.median} ATR deep (80% within ${fb.sweep_depth_atr.p80})` : ''}` : null,
        Number.isFinite(d?.atr_pct) ? `daily ATR ${d.atr_pct}%` : null,
        fit,
    ].filter(Boolean).join('; ')
}

/** The handler. `deps` — test seams passed to profileFor. */
export function makeBehaviourProfileHandlers({ deps = {} } = {}) {
    return {
        get_behaviour_profile: makeToolHandler('get_behaviour_profile', async ({ ticker, fresh = false } = {}) => {
            const sym = String(ticker ?? '').trim().toUpperCase()
            if (!sym) return 'Pass `ticker`.'
            return formatProfile(await profileFor(sym, { fresh: fresh === true, deps }))
        }, (err, args) => `Could not measure ${String(args?.ticker ?? '').toUpperCase()}: ${err.message} — say so; do not describe its behaviour from memory.`, LOG),
    }
}
