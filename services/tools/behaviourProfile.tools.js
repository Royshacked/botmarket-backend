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
    get_behaviour_profile: `The MEASURED behaviour profile of one stock — how its price has actually behaved, counted from its candles on 5-minute (~3 months), 1-hour (~1 year), daily (~10 years) and weekly (~10 years) bars, LONG SIDE: does it hold at the 20 EMA / 50 / 200 SMA / VWAP, what follows RSI under 30, a MACD cross up, a high-volume up bar; how often its breaks of a swing low are FALSE (closed back above within 3 bars), how deep those sweeps go in ATRs, how many bars until it picks a direction; whether bullish order blocks hold on a retest; whether its lows come in a regular PRICE CYCLE (against the same returns reshuffled — the next window is stated only when the cycle holds); WYCKOFF, measured: tight trading ranges found in code, whether a SPRING (a dip under the range low closed back inside) beats both an ordinary bar and an ordinary false break, whether a breakout above the range follows through (and how often it fails back inside — the upthrust share), whether a retest of the low on dried-up volume beats any retest, and the range it is in now; its ATR %, gap, dollar volume; and whether it fits a day trade / a swing. Every rate is against a BASELINE (the same line shifted, or the stock's own drift) and must still hold in the most recent third. Kept for a week, shared by everyone; the first ask for a name takes several seconds. \`ticker\`; \`fresh: true\` recomputes now (only when the user asks for it).`,
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

const _bars = (n, tf) => `${n} ${({ '5min': '5-minute bars', '1hour': 'hours', day: 'sessions', week: 'weeks' })[tf] ?? 'bars'}`

/** A cycle verdict in words, for the opened row. Pure. */
export function cycleWords(c, tf) {
    if (c.verdict === 'respects') {
        const w = c.window ? ` Next window ${c.window.from.slice(0, 10)} – ${c.window.to.slice(0, 10)}.` : ''
        return `Lows every ~${_bars(c.period_bars, tf)} (± ${c.spread_bars}) — more regular than its own moves reshuffled (${_pct(c.rate)} vs ${_pct(c.base)}, z ${c.z}; recent ${_pct(c.recent.rate)}).${w}`
    }
    if (c.verdict === 'faded') return `Its lows used to come in a cycle (${_pct(c.rate)} vs ${_pct(c.base)}), not lately — no window stated.`
    if (c.verdict === 'unconfirmed') return `A cycle in the older history (${_pct(c.rate)} vs ${_pct(c.base)}), too few recent lows to confirm — no window stated.`
    return `No regular cycle — its lows are no more evenly spaced than the same moves reshuffled (${_pct(c.rate)} vs ${_pct(c.base)}).`
}

/** A cycle verdict as the tool's line. Pure. */
export function cycleLine(c) {
    if (c.verdict === 'thin') return `Price cycle: too few lows to say (${c.n} intervals)`
    const head = `Price cycle (trough to trough, vs the same returns reshuffled): ${VERDICT[c.verdict] ?? c.verdict} — ${_pct(c.rate)} of intervals within ±35% of the mean vs ${_pct(c.base)} baseline (${c.n} in the older two-thirds, z ${c.z}; recent ${_pct(c.recent?.rate)}, ${c.recent?.n ?? 0})`
    return c.verdict === 'respects' && c.window
        ? `${head}; period ~${c.period_bars} bars (± ${c.spread_bars}), next window ${c.window.from.slice(0, 10)} → ${c.window.to.slice(0, 10)}`
        : head
}

/**
 * The false-break rate against chance, in words — the same bars in a shuffled order (falseBreakChance). A rate that does
 * not beat it is said to be chance's, so no reader takes it for a trait. `where`: 'row' (the opened Hotlist row), 'tool'
 * (the technical analyst's text), 'brief' (the trader's one line). Pure.
 */
export function chanceWords(fb, where = 'row') {
    const c = fb?.chance
    if (!c || c.base == null || c.verdict === 'thin') return ''
    const base = _pct(c.base)
    if (where === 'tool') return `; vs ${base} for its own bars in random order — ${({ more: 'MORE false than chance (holds)', less: 'LESS false than chance: its breaks follow through (holds)', faded: 'beat chance in the older history, not lately', chance: 'CHANCE: no trait of its own' })[c.verdict] ?? c.verdict} (z ${c.z})`
    if (where === 'brief') return c.verdict === 'chance' ? ` (chance: ${base})` : ` (vs ${base} by chance: ${c.verdict})`
    return ({
        chance: ` — about what its own moves in random order do (${base}): no trait of its own`,
        more: ` — more often than its moves in random order (${base}): breaks of its lows tend to reverse`,
        less: ` — less often than its moves in random order (${base}): breaks of its lows tend to follow through`,
        faded: ` — once apart from chance (${base}), not lately`,
    })[c.verdict] ?? ''
}

/** Wyckoff as the tool's lines — the measured part only; the phase (A–E) is a chart read. Pure. */
export function wyckoffLines(w) {
    if (!w.ranges) return ['  Wyckoff: no tight trading range in this history']
    const s = w.springs, v = s.vs_sweeps
    return [
        `  Wyckoff (${w.ranges} trading ranges of ${PROFILE.rangeBars}+ bars within ${PROFILE.rangeAtr} ATR)${w.current ? `; NOW in a range ${w.current.low}–${w.current.high} since ${w.current.since.slice(0, 10)}` : '; not in a range now'}`,
        `    ${testLine('Springs (a dip under the range low closed back inside, vs any bar)', s, 'springs')}${v?.base != null ? `; vs an ordinary false break ${_pct(v.base)} (${VERDICT[v.verdict] ?? v.verdict}${Number.isFinite(v.z) ? `, z ${v.z}` : ''}) — a spring HOLDS only when it beats both` : ''}`,
        `    ${testLine('Breakouts above the range (vs any bar)', w.breakouts, 'breakouts')}${w.breakouts.upthrust_rate != null ? `; ${_pct(w.breakouts.upthrust_rate)} closed back inside within ${PROFILE.sweepBack} bars (upthrusts — noise does 50–65% too: not a trait)` : ''}`,
        `    ${testLine(`Retests of the range low on volume under ${PROFILE.dryUp * 100}% of the range's average (vs all retests)`, w.dry_up, 'retests')}`,
    ]
}

/** Wyckoff in words, for the opened row — the range it is in now and each test's verdict. Null when nothing to say. Pure. */
export function wyckoffWords(w) {
    if (!w?.ranges) return null
    const parts = []
    if (w.current) parts.push(`In a range ${w.current.low}–${w.current.high} since ${w.current.since.slice(0, 10)}.`)
    const said = (name, s, extra = '') => {
        if (!s || s.verdict === 'thin') return
        if (s.verdict === 'respects') parts.push(`${name} hold: ${_pct(s.rate)} vs ${_pct(s.base)}${extra}.`)
        else if (s.verdict === 'no') parts.push(`${name}: no edge (${_pct(s.rate)} vs ${_pct(s.base)}${extra}).`)
        else parts.push(`${name}: ${VERDICT[s.verdict]} (${_pct(s.rate)} vs ${_pct(s.base)}).`)
    }
    const vs = w.springs?.vs_sweeps
    said('Springs', w.springs, vs?.base != null ? ` for any bar, ${_pct(vs.base)} for an ordinary false break` : '')
    // No upthrust share here: random walks fail back inside 50–66% of the time too — a bare share reads as a trait it is not.
    said('Range breakouts', w.breakouts)
    said('Dry-volume retests', w.dry_up)
    return parts.length ? parts.join(' ') : null
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
        `  Breaks of a swing low: ${fb.breaks}, ${_pct(fb.false_rate)} FALSE (closed back above within ${PROFILE.sweepBack} bars; recent ${_pct(fb.recent.false_rate)})${chanceWords(fb, 'tool')}` +
            `${fb.sweep_depth_atr?.median != null ? `; sweeps went ${fb.sweep_depth_atr.median} ATR under the low (80% within ${fb.sweep_depth_atr.p80})` : ''}` +
            `${fb.bars_to_direction != null ? `; a direction ~${fb.bars_to_direction} bars after the break` : ''}`,
        ...(fb.latest ? [`  ${latestLine(tf, fb.latest)}`] : []),
        `  ${testLine('After a sweep (from the reclaim)', fb.after_sweep, 'sweeps')}`,
        `  ${testLine(`Bullish order blocks (${t.order_blocks.blocks} found) on a retest`, t.order_blocks, 'retests')}`,
        ...(t.cycle ? [`  ${cycleLine(t.cycle)}`] : []),
        ...(t.wyckoff ? wyckoffLines(t.wyckoff) : []),
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
    macd_cross_up: 'MACD cross', volume_up_bar: 'volume', sweeps: 'sweeps lows', order_blocks: 'order blocks', cycle: 'price cycle',
    fakes: 'fakes its lows', follows: 'breaks follow through',
    springs: 'Wyckoff springs', range_breakouts: 'range breakouts', dry_up: 'dry-volume retests',
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
            ...(t.cycle?.verdict === 'respects' ? ['cycle'] : []),
            ...(t.wyckoff?.springs?.verdict === 'respects' ? ['springs'] : []),
            ...(t.wyckoff?.breakouts?.verdict === 'respects' ? ['range_breakouts'] : []),
            ...(t.wyckoff?.dry_up?.verdict === 'respects' ? ['dry_up'] : []),
            ...(t.false_breaks?.chance?.verdict === 'more' ? ['fakes'] : t.false_breaks?.chance?.verdict === 'less' ? ['follows'] : []),
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
    // Nothing holds: its DAILY ATR — the one number every name has that is its own (Roy, 2026-11-13: the false-break rate
    // was noise — random walks score 75–86% — and must never be a headline unless it beats chance, when it holds above).
    const day = profile.timeframes.day
    const lead = present[0], t = profile.timeframes[lead]
    const atrPct = day?.atr_pct ?? t.atr_pct
    if (Number.isFinite(atrPct)) {
        const per = day?.atr_pct != null ? '/day' : ` per ${TF[lead].toLowerCase()} bar`
        return {
            badge: `ATR ${atrPct}%${per}`, kind: 'trait', holds: [],
            tip: `Nothing technical holds on the ${on} bars. It moves ~${atrPct}% a ${day?.atr_pct != null ? 'day' : 'bar'}. Click for the read.`,
        }
    }
    return {
        badge: 'nothing', kind: 'nothing', holds: [],
        tip: `Measured on the ${on} bars, nothing technical holds — no line or pattern to lean on. Click for the read.`,
    }
}

/**
 * THE PROFILE IN AN OPENED HOTLIST ROW (proteus.md §8.1 decision 4, Roy 2026-11-13 — "shown when opening a row instead
 * of a badge"): the row's horizon, as a few labelled lines — what holds (or, when nothing does, what it does: its false
 * breaks and how deep they sweep), its latest example, ATR, and what it fits. Numbers only, from the measured profile;
 * the written read is the technical analyst's, one click away. → `{ headline: { text, kind }, lines: [[label, text]],
 * on }` or null when the horizon has no bars. Pure.
 */
export function rowProfile(profile, horizon = null) {
    const head = behaviourBadge(profile, horizon)
    if (!head) return null
    const tfs = (BADGE_TIMEFRAMES[horizon] ?? BADGE_TIMEFRAMES.swing).filter(tf => profile.timeframes[tf])
    const tfWord = (tf) => TF[tf].charAt(0) + TF[tf].slice(1).toLowerCase()
    const lines = [['What it obeys', head.kind === 'holds' ? head.holds.join(', ') : `Nothing technical holds on the ${tfs.map(tf => TF[tf].toLowerCase()).join(' and ')} bars.`]]
    for (const tf of tfs) {
        const fb = profile.timeframes[tf].false_breaks
        if (!fb?.breaks) continue
        lines.push([`${tfWord(tf)} breaks of a low`,
            `${_pct(fb.false_rate)} of ${fb.breaks} closed back above within ${PROFILE.sweepBack} bars${chanceWords(fb, 'row')}` +
            `${fb.sweep_depth_atr?.median != null ? `; sweeps ~${fb.sweep_depth_atr.median} ATR under the low (80% within ${fb.sweep_depth_atr.p80}) — the room a stop under a low needs` : ''}` +
            `${fb.bars_to_direction != null ? `; a direction ~${fb.bars_to_direction} bars after` : ''}.`])
    }
    for (const tf of tfs) {
        const c = profile.timeframes[tf].cycle
        if (c && c.verdict !== 'thin') lines.push([`${tfWord(tf)} cycle`, cycleWords(c, tf)])
    }
    for (const tf of tfs) {
        const w = wyckoffWords(profile.timeframes[tf].wyckoff)
        if (w) lines.push([`${tfWord(tf)} Wyckoff`, w])
    }
    const lead = profile.timeframes[tfs[0]].false_breaks?.latest
    if (lead) lines.push(['Latest example', latestLine(tfs[0], lead).replace(/^Latest false break \(the example to show\): /, '').replace(/ — chart it:.*$/, '.')])
    lines.push(['ATR', tfs.map(tf => `${tfWord(tf)} ${profile.timeframes[tf].atr_pct ?? '—'}%`).join(' · ') +
        (profile.timeframes.day?.gap_pct != null ? ` · typical gap ${profile.timeframes.day.gap_pct}%` : '')])
    const fit = profile.suitability
    if (fit) lines.push(['Fits', `Day trade ${fit.day_trade.fits ? 'yes' : 'no'} · swing ${fit.swing.fits ? 'yes' : 'no'} — ${fit.swing.fits ? fit.swing.why : fit.day_trade.why}.`])
    return { headline: { text: head.badge, kind: head.kind }, lines, on: tfs }
}

/** What HOLDS across the timeframes, labelled — the one list formatProfile and profileBrief both say. Missing parts skip. Pure. */
export function holdsOf(timeframes) {
    return Object.entries(timeframes ?? {}).flatMap(([tf, t]) => (t ? [
        ...Object.entries(t.indicators ?? {}).filter(([, s]) => s?.verdict === 'respects').map(([k]) => `${LABEL[k] ?? k} (${TF[tf].toLowerCase()})`),
        ...(t.false_breaks?.after_sweep?.verdict === 'respects' ? [`sweeps of lows (${TF[tf].toLowerCase()})`] : []),
        ...(t.order_blocks?.verdict === 'respects' ? [`order blocks (${TF[tf].toLowerCase()})`] : []),
        ...(t.cycle?.verdict === 'respects' ? [`a price cycle (${TF[tf].toLowerCase()})`] : []),
        ...(t.wyckoff?.springs?.verdict === 'respects' ? [`Wyckoff springs — dips under a range low closed back inside (${TF[tf].toLowerCase()})`] : []),
        ...(t.wyckoff?.breakouts?.verdict === 'respects' ? [`breakouts above a trading range (${TF[tf].toLowerCase()})`] : []),
        ...(t.wyckoff?.dry_up?.verdict === 'respects' ? [`retests of a range low on dried-up volume (${TF[tf].toLowerCase()})`] : []),
        ...(t.false_breaks?.chance?.verdict === 'more' ? [`breaks of its lows reverse more than chance (${TF[tf].toLowerCase()})`] : []),
        ...(t.false_breaks?.chance?.verdict === 'less' ? [`breaks of its lows follow through more than chance (${TF[tf].toLowerCase()})`] : []),
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
        fb?.breaks ? `breaks of a daily swing low are false ${_pct(fb.false_rate)}${chanceWords(fb, 'brief')}${fb.sweep_depth_atr?.median != null ? `, sweeps ~${fb.sweep_depth_atr.median} ATR deep (80% within ${fb.sweep_depth_atr.p80})` : ''}` : null,
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
