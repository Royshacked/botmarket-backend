// ECHO, STEP 6 — THE TRADE RULES' LEVELS, FOR MENTOR (docs/design/echo-pipeline.md; the simulator doc's Step 6).
//
// Roy, 2026-11-19: "the user clicks the name → it goes to Mentor with Echo's mentions → Mentor considers its levels but
// trades his regular setup". So this computes the levels the doc's CODED rules would set, from the name's own daily
// bars, and says them to Mentor as CONSIDERATIONS — the entry, the stop and the exit are still built his way, with the
// user. The doc's rules:
//   winners (underreacted, high score)   entry on strength — a break above the high since the event, no limits below
//       the price; stop 1.5–2× ATR below entry or below the event-day low; exit by a trailing stop (a close under the
//       21-day EMA, or an ATR trail), no fixed target; optional partial at 2R.
//   losers flagged as overreactions      entry only after the selloff stops making new lows — a close above the prior
//       5-day high; stop below the panic low; exit by the trail, or at the pre-event level.
//   all trades                           fixed-risk sizing; no new longs with SPY under its 200-day average; a cap per
//       event (its links can move together).
//
// The seed is a REFERENCE (the event and the name), read back here by the server — like a Hotlist or book hand-off.

import { fetchBars, unfinishedSession } from './echoReturns.service.js'
import { echoEventsService } from './echoEvents.service.js'
import { calcATRSeries, calcEMASeries, calcSMASeries } from '../monitoring/evaluators/structured.evaluator.js'

export const ATR_DAYS = 14
export const EMA_DAYS = 21
export const SMA_LONG = 200
const LOOKBACK_DAYS = 420     // calendar days: SPY's 200 sessions and the name's history since the event

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null)

// The house's indicators (monitoring/evaluators/structured.evaluator — the monitors' and Mentor's), not a copy of their
// own (CR 2026-11-19: "shared mechanism → one service").
const lastOf = (xs) => { for (let i = xs.length - 1; i >= 0; i--) if (Number.isFinite(xs[i])) return xs[i]; return null }

/** The ATR now, over sorted bars — the shared calcATRSeries. Pure. */
export function atr(rows, n = ATR_DAYS) {
    return rows.length < n + 1 ? null : lastOf(calcATRSeries(rows.map(b => ({ h: b.high, l: b.low, c: b.close })), n))
}

/** The EMA of the closes now — the shared calcEMASeries. Pure. */
export function ema(rows, n = EMA_DAYS) {
    return rows.length < n ? null : lastOf(calcEMASeries(rows.map(b => b.close), n))
}

/**
 * The doc's levels for one flagged name. `bars` and `spy` are {date: bar}; `day0` is the event's Day 0; `base` the last
 * close before it. Pure. → `{ rule, entry, stops, exit, partial, filter, notes }` or null when the bars are too few.
 */
export function levelsFrom({ bars, spy, day0, base, flag }) {
    const rows = Object.keys(bars).sort().map(d => ({ date: d, ...bars[d] }))
    const since = rows.filter(b => b.date >= day0)
    if (!since.length || rows.length < ATR_DAYS + 2) return null
    const a = atr(rows), e21 = ema(rows), last = rows.at(-1)
    const spyRows = Object.keys(spy).sort().map(d => spy[d])
    const sma200 = spyRows.length >= SMA_LONG ? lastOf(calcSMASeries(spyRows.map(b => b.close), SMA_LONG)) : null
    const spyLast = spyRows.at(-1)?.close ?? null
    const filter = sma200 == null ? { ok: null, why: 'SPY 200-day average not readable' }
        : { ok: spyLast >= sma200, why: `SPY ${r2(spyLast)} ${spyLast >= sma200 ? 'above' : 'BELOW'} its 200-day average ${r2(sma200)}${spyLast >= sma200 ? '' : ' — the doc takes no new longs'}` }
    const out = { atr: r2(a), ema21: r2(e21), last: r2(last.close), asOf: last.date, filter, cap: 'one position per event — its links can move together' }
    if (flag === 'overreacted_loser') {
        const panic = since.reduce((m, b) => (b.low < m.low ? b : m), since[0])
        const prior5 = rows.slice(-6, -1)
        const trigger = prior5.length ? Math.max(...prior5.map(b => b.high)) : null
        const newLowsStopped = panic.date !== last.date
        return { ...out, rule: 'overreacted loser',
            entry: { level: r2(trigger), how: `a close above the prior 5-day high (${r2(trigger)}), only once the selloff stops making new lows${newLowsStopped ? ` — the low so far is ${r2(panic.low)} on ${panic.date}` : ' — it made a new low today: not yet'}` },
            stops: [{ level: r2(panic.low), how: `below the panic low (${panic.date})` }],
            exit: { how: `a trailing stop, or at the pre-event level${bars[base]?.close ? ` (${r2(bars[base].close)}, the close before the event)` : ''}` },
            partial: null }
    }
    const high = since.reduce((m, b) => (b.high > m.high ? b : m), since[0])
    const eventLow = bars[day0]?.low ?? null
    const entry = high.high
    const stops = [
        a ? { level: r2(entry - 1.5 * a), how: '1.5× ATR below the entry' } : null,
        a ? { level: r2(entry - 2 * a), how: '2× ATR below the entry' } : null,
        Number.isFinite(eventLow) ? { level: r2(eventLow), how: `below the event-day low (${day0})` } : null,
    ].filter(Boolean)
    const risk = a ? 2 * a : null
    return { ...out, rule: 'underreacted winner',
        entry: { level: r2(entry), how: `on strength — a break above the high since the event (${r2(entry)}, ${high.date}); no limit orders below the price` },
        stops,
        exit: { how: `a trailing stop — a close under the 21-day EMA (${r2(e21)} now) or an ATR trail; no fixed take-profit` },
        partial: risk ? { level: r2(entry + 2 * risk), how: 'optional: a partial at 2R (on the 2× ATR stop)' } : null }
}

/** The levels in one paragraph, for Mentor. Pure. */
export function levelsWords(lv) {
    if (!lv) return null
    const parts = [
        `The simulator's ${lv.rule} rule would set — entry: ${lv.entry.how}`,
        `stop: ${lv.stops.map(s => `${s.level} (${s.how})`).join(' or ')}`,
        `exit: ${lv.exit.how}`,
        lv.partial ? `${lv.partial.how}: ${lv.partial.level}` : null,
        `ATR ${lv.atr}, last ${lv.last} (${lv.asOf})`,
        lv.filter.why, `size by fixed risk; ${lv.cap}`,
    ].filter(Boolean)
    return parts.join('; ')
}

const _deps = { bars: fetchBars, events: echoEventsService, now: () => new Date() }
export function _setDeps(d) { Object.assign(_deps, d) }

const FLAGS = new Set(['underreacted_winner', 'overreacted_loser'])
const FLAG_WORDS = { underreacted_winner: 'an UNDERREACTED WINNER', overreacted_loser: 'an OVERREACTED LOSER (a rebound candidate)', fully_priced: 'fully priced' }

/**
 * A Mentor seed's Echo reference → what the server says to Mentor: the event, the link, its score and flag, and the
 * rule's levels. `ref` = { event, ticker }; a user's own event only for them. → `{ horizon, echo_facts, thesis, caution }`
 * or null.
 */
export async function echoSeed(ref, userId = null) {
    const ev = await _deps.events.get(ref?.event, userId)
    if (!ev) return null
    const link = ev.map?.links?.find(l => l.ticker === ref.ticker)
    if (!link) return null
    const score = ev.scores?.links?.find(s => s.ticker === ref.ticker)
    const check = ev.check?.links?.find(c => c.ticker === ref.ticker)
    const top = score ? Object.entries(score.factors ?? {}).filter(([, f]) => f.score === 2).map(([k, f]) => `${k} 2 — ${f.why}`) : []
    let levels = null
    if (FLAGS.has(check?.flag) && ev.check?.day0) {
        const now = _deps.now()
        const to = now.toISOString().slice(0, 10)
        const from = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10)
        const open = unfinishedSession(now)
        const strip = (b) => Object.fromEntries(Object.entries(b ?? {}).filter(([d]) => d !== open))
        const [bars, spy] = await Promise.all([_deps.bars(ref.ticker, from, to).catch(() => null), _deps.bars('SPY', from, to).catch(() => null)])
        const base = ev.check.day0 && bars ? Object.keys(bars).sort().filter(d => d < ev.check.day0).at(-1) : null
        levels = bars && spy ? levelsFrom({ bars: strip(bars), spy: strip(spy), day0: ev.check.day0, base, flag: check.flag }) : null
    }
    const facts = [
        `the event (${ev.date}): ${ev.whatChanged} — ${ev.origin}, demand ${ev.effect}; durability ${String(ev.durability?.kind).replace(/_/g, ' ')}${ev.durability?.why ? ` (${ev.durability.why})` : ''}`,
        `the link: ${link.relation.replace('_', ' ')}, layer ${link.layer}, ${link.direction} — ${link.why}`,
        score ? `Echo's score ${score.total}/12${score.high ? ' (HIGH)' : ''}${top.length ? `; ${top.join('; ')}` : ''}` : null,
        check?.flag ? `the day-5 check: ${FLAG_WORDS[check.flag]} — ${check.why}` : null,
        levels ? levelsWords(levels) : null,
    ].filter(Boolean)
    return {
        horizon: 'swing',
        echo_facts: facts.join('. '),
        echo_levels: levels,
        thesis: `${ev.origin}'s event reaches ${ref.ticker} as its ${link.relation.replace('_', ' ')}: ${link.why}`,
        caution: 'Echo is unproven until its validation has the events: the flag is a lead, not a pick.',
    }
}

export const echoLevelsService = { echoSeed, levelsFrom, levelsWords }
