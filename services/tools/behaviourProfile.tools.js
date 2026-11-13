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

/** The profile's timeframe → get_chart's spelling of it. */
export const CHART_TF = Object.freeze({ '5min': '5min', '1hour': '1hr', day: 'day', week: 'week' })

/**
 * The latest false break, as the example to SHOW (Roy, 2026-11-13) — with the get_chart call that draws it, so the
 * model draws the event the count found, at its exact prices. Intraday bars carry the time; daily and weekly the date. Pure.
 */
export function latestLine(tf, l) {
    const when = (iso) => (tf === '5min' || tf === '1hour' ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(0, 10))
    return `Latest false break (the example to show): ${when(l.at)} the swing low ${l.level} was swept to ${l.swept_to}` +
        `${l.depth_atr != null ? ` (${l.depth_atr} ATR under)` : ''}, closed back above ${when(l.reclaimed_at)} — ` +
        `chart it: get_chart timeframe "${CHART_TF[tf] ?? tf}", levels ${l.level} "swing low" and ${l.swept_to} "swept to"`
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
        ...(fb.latest ? [`  ${latestLine(tf, fb.latest)}`] : []),
        `  ${testLine('After a sweep (from the reclaim)', fb.after_sweep, 'sweeps')}`,
        `  ${testLine(`Bullish order blocks (${t.order_blocks.blocks} found) on a retest`, t.order_blocks, 'retests')}`,
    ]
}

// ─── The Hotlist badge (proteus.md §8.2, build step 5, 2026-11-13) ─────────────
// "What the name obeys, in a word or two (e.g. '20 MA', 'sweeps lows', 'nothing')" — on the timeframes the ROW's horizon
// trades on: a day trade reads the 5-minute and 1-hour bars, a swing the daily and weekly.

/** The timeframes each Hotlist horizon reads. The day boards' columns are day trades. */
export const BADGE_TIMEFRAMES = Object.freeze({
    intraday: ['5min', '1hour'], open: ['5min', '1hour'], mid: ['5min', '1hour'], close: ['5min', '1hour'], day: ['5min', '1hour'],
    week: ['1hour', 'day'], swing: ['day', 'week'], long_term: ['week', 'day'], covered: ['day', 'week'],
})
const BADGE_WORDS = Object.freeze({
    ema20: '20 EMA', sma50: '50 MA', sma200: '200 MA', vwap: 'VWAP', rsi_oversold: 'RSI under 30',
    macd_cross_up: 'MACD cross', volume_up_bar: 'volume', sweeps: 'sweeps lows', order_blocks: 'order blocks',
})

/**
 * The badge for one row: `{ badge, kind, holds, tip }` — the first thing that holds (and how many more), `kind: 'holds'`.
 * When nothing holds — the usual answer — the trait every name DOES have, measured on the horizon's first timeframe: how
 * often its breaks of a swing low turned out false ("fakes 74%", `kind: 'trait'`; Roy 2026-11-13, option 2: a badge that
 * reads "nothing" on nearly every row tells the user nothing). "nothing" only when even that was not measured. Null when
 * the profile has none of the horizon's timeframes (too little history to say). Pure.
 */
export function behaviourBadge(profile, horizon = null) {
    const tfs = BADGE_TIMEFRAMES[horizon] ?? BADGE_TIMEFRAMES.swing
    const present = tfs.filter(tf => profile?.timeframes?.[tf])
    if (!present.length) return null
    const holds = []
    for (const tf of present) {
        const t = profile.timeframes[tf]
        const keys = [
            ...Object.entries(t.indicators ?? {}).filter(([, s]) => s?.verdict === 'respects').map(([k]) => k),
            ...(t.false_breaks?.after_sweep?.verdict === 'respects' ? ['sweeps'] : []),
            ...(t.order_blocks?.verdict === 'respects' ? ['order_blocks'] : []),
        ]
        for (const k of keys) holds.push({ key: k, tf, label: `${BADGE_WORDS[k] ?? k} (${TF[tf].toLowerCase()})` })
    }
    const words = [...new Set(holds.map(h => BADGE_WORDS[h.key] ?? h.key))]
    const on = present.map(tf => TF[tf].toLowerCase()).join(' and ')
    if (words.length) {
        return {
            badge: `${words[0]}${words.length > 1 ? ` +${words.length - 1}` : ''}`, kind: 'holds',
            holds: holds.map(h => h.label),
            tip: `Measured on the ${on} bars, it holds at: ${holds.map(h => h.label).join(', ')}. Click for the read.`,
        }
    }
    // Nothing holds: what it DOES do, on the timeframe the horizon trades on first.
    const lead = present[0], t = profile.timeframes[lead], fb = t.false_breaks
    const where = TF[lead].toLowerCase()
    if (Number.isFinite(fb?.false_rate) && fb?.breaks > 0) {
        const depth = fb.sweep_depth_atr?.median != null ? `, sweeping ~${fb.sweep_depth_atr.median} ATR under the low` : ''
        const atr = t.atr_pct != null ? ` ${TF[lead].charAt(0)}${TF[lead].slice(1).toLowerCase()} ATR ${t.atr_pct}%.` : ''
        return {
            badge: `fakes ${_pct(fb.false_rate)}`, kind: 'trait', holds: [],
            tip: `Nothing technical holds on the ${on} bars. What it does: ${_pct(fb.false_rate)} of its ${fb.breaks} breaks of a ${where} swing low closed back above within ${PROFILE.sweepBack} bars${depth}.${atr} Click for the read.`,
        }
    }
    return {
        badge: 'nothing', kind: 'nothing', holds: [],
        tip: `Measured on the ${on} bars, nothing technical holds — no line or pattern to lean on. Click for the read.`,
    }
}

/** What HOLDS across the timeframes, labelled — the one list formatProfile and profileBrief both say. Missing parts skip. Pure. */
export function holdsOf(timeframes) {
    return Object.entries(timeframes ?? {}).flatMap(([tf, t]) => (t ? [
        ...Object.entries(t.indicators ?? {}).filter(([, s]) => s?.verdict === 'respects').map(([k]) => `${LABEL[k] ?? k} (${TF[tf].toLowerCase()})`),
        ...(t.false_breaks?.after_sweep?.verdict === 'respects' ? [`sweeps of lows (${TF[tf].toLowerCase()})`] : []),
        ...(t.order_blocks?.verdict === 'respects' ? [`order blocks (${TF[tf].toLowerCase()})`] : []),
    ] : []))
}

/** The whole profile → the tool's text. Pure. */
export function formatProfile(p) {
    const holds = holdsOf(p.timeframes)
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
    const holds = holdsOf(tfs)
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
