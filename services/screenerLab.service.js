// THE SCREENER LAB — candidate screener rules tested one by one on the same past sessions, the same way (Roy,
// 2026-10-24: "think of more criteria and we test one by one; the Argus replay only after we have a screener with an
// edge"). The Hotlist's own rules, replayed, matched SPY and the pool once each session counted once
// (hotlistBacktest — the run-up path +0.32% a week per session against SPY's +0.23%); this is where a replacement has to
// prove itself first.
//
// ONE YARDSTICK FOR EVERY IDEA. A hypothesis is a SIGNAL on a name's daily bars (and the earnings calendar's reports):
// on session i, from what was known by the close of i−1 (or i's open, for a rule that reads the open), it says buy at
// i's OPEN. It is held `hold` sessions — out at the close of the last — or until its own exit. Each trade's return is
// measured AGAINST SPY over the same sessions (open to close), less a round-trip cost by the name's dollar volume
// (COST_BY_ADV). The verdict counts each SESSION once (hotlistBacktest distribution: the names of a day move together),
// with its 95% range, and splits the span in two halves — an edge that lives in one half is a regime, not an edge.
// Every idea is set against the BASELINE: every name in the universe, every session, the same way.
//
// Pure: the data (screenerLab.data) comes in; no IO here.

import { groupStats, beatSurprise } from './hotlistBacktest.service.js'

/** Round-trip cost, in %, by the name's 20-day average dollar volume — the spread and slippage a fill gives away. */
export const COST_BY_ADV = Object.freeze([[100e6, 0.05], [20e6, 0.1], [5e6, 0.25], [0, 0.5]])
export const costFor = (adv) => (COST_BY_ADV.find(([min]) => adv >= min) ?? COST_BY_ADV.at(-1))[1]

/** The least a name must trade a day to be tested at all (and price ≥ MIN_PRICE). */
export const MIN_ADV = 5e6
export const MIN_PRICE = 5

const _r = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
const _mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)

/**
 * A name's indicators, by bar index — each one known at the CLOSE of that bar. Pure.
 * → `{ date, sma5, sma200, ret5, rsi2, high252, adv20 }` arrays (null until there is enough history).
 */
export function indicators(rows, dateOf) {
    const n = rows.length
    const close = rows.map(b => b.close)
    // Rolling sums, not a slice per bar: ~1,200 names × ~560 bars × a 200-bar window adds up.
    const rolling = (xs, k) => {
        const out = new Array(n).fill(null)
        let sum = 0
        for (let i = 0; i < n; i++) { sum += xs[i]; if (i >= k) sum -= xs[i - k]; if (i + 1 >= k) out[i] = sum / k }
        return out
    }
    const sma = (k) => rolling(close, k)
    const ret5 = close.map((c, i) => (i >= 5 && close[i - 5] > 0 ? (c / close[i - 5] - 1) * 100 : null))
    // RSI(2), Wilder-smoothed.
    const rsi2 = new Array(n).fill(null)
    let up = null, dn = null
    for (let i = 1; i < n; i++) {
        const ch = close[i] - close[i - 1], u = Math.max(0, ch), d = Math.max(0, -ch)
        if (i < 2) { up = u; dn = d; continue }
        up = (up * 1 + u) / 2; dn = (dn * 1 + d) / 2
        rsi2[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn)
    }
    const high252 = close.map((_, i) => (i >= 251 ? Math.max(...rows.slice(i - 251, i + 1).map(b => b.high)) : null))
    const adv20 = rolling(rows.map(b => b.close * (b.volume || 0)), 20)
    // The 20-day band (the swing ideas): its mean and standard deviation of closes.
    const sma20 = sma(20)
    const sq = rolling(close.map(c => c * c), 20)
    const sd20 = sma20.map((m, i) => (m == null ? null : Math.sqrt(Math.max(0, sq[i] - m * m))))
    // The slower cycles (2026-10-25): the 50-day and the 60-session range of closes.
    const span = (k, pick) => close.map((_, i) => (i + 1 >= k ? pick(close.slice(i - k + 1, i + 1)) : null))
    const hi60 = span(60, xs => Math.max(...xs)), lo60 = span(60, xs => Math.min(...xs))
    // The calendar weeks and months (the false break, 2026-10-25): each bar's period's first bar, and the LOW of the
    // period before it.
    const monday = (d) => { const t = new Date(`${d}T12:00:00Z`); return new Date(t - ((t.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10) }
    const periods = (keyOf) => {
        const first = new Array(n).fill(0), lowPrev = new Array(n).fill(null)
        let start = 0, prevLow = null, curLow = Infinity
        for (let i = 0; i < n; i++) {
            if (i > 0 && dateOf && keyOf(dateOf[i]) !== keyOf(dateOf[i - 1])) { prevLow = curLow; curLow = Infinity; start = i }
            first[i] = start; lowPrev[i] = prevLow
            curLow = Math.min(curLow, rows[i].low)
        }
        return [first, lowPrev]
    }
    const [wkStart, wkLowPrev] = periods(monday), [moStart, moLowPrev] = periods(d => d.slice(0, 7))
    return { date: dateOf, sma5: sma(5), sma20, sd20, sma50: sma(50), sma200: sma(200), ret5, rsi2, high252, adv20, hi60, lo60, wkStart, wkLowPrev, moStart, moLowPrev }
}

/**
 * THE HYPOTHESES — one at a time (Roy, 2026-10-24). Each: `{ id, label, hold, signal(ctx) → tag | null, exit?, extras? }`.
 * `ctx = { rows, i, ind, reports, name, data }`, `reports` the name's reports by date, `name` its prepared entry (sector,
 * insiders), `data` the whole set (sectorDay); `extras` the data it needs beyond bars and the calendar (screenerLab.data). A signal reads only bars ≤ i−1 (and
 * rows[i].open when it says so); a non-null tag is the trade's sub-group (e.g. the surprise bucket), `true` for none.
 */
export const HYPOTHESES = Object.freeze({
    // #1 — the drift after an earnings beat, bought on the second session after the report (the replay's day_two),
    // widened: every beat, by the size of the surprise, and whether revenue beat too.
    beat_day2: {
        label: 'drift after an EPS beat, bought on day two', hold: 5,
        signal: ({ i, ind, reports }) => {
            if (i < 2) return null
            const b = beatSurprise(reports.get(ind.date[i - 2]))
            if (!b) return null
            const size = b.surprise == null ? 'unknown' : b.surprise < 0.10 ? '5-10%' : b.surprise < 0.25 ? '10-25%' : '25%+'
            return `${size}${b.revenueMissed ? ' · revenue missed' : ''}`
        },
    },
    // #2 — a beat the market AGREED with: up 3%+ over the two sessions from the report (the calendar has no before/after-
    // the-bell time, so the reaction may be on either), and the second closed green — held, not faded.
    beat_held: {
        label: 'EPS beat, up 3%+ over two sessions and held, bought on day two', hold: 5,
        signal: ({ rows, i, ind, reports }) => {
            if (i < 4) return null
            const b = beatSurprise(reports.get(ind.date[i - 2]))
            if (!b || b.revenueMissed) return null
            const move = (rows[i - 1].close / rows[i - 3].close - 1) * 100
            if (!(move >= 3) || rows[i - 1].close < rows[i - 1].open) return null
            return move < 8 ? 'up 3-8%' : 'up 8%+'
        },
    },
    // #3 — the one-week reversal: a name in a long uptrend (over its 200-day) that fell 8–25% in five sessions with no
    // report among them — a dip, not news.
    reversal_1w: {
        label: 'down 8-25% in a week, above the 200-day, no report', hold: 5,
        signal: ({ rows, i, ind, reports }) => {
            const r5 = ind.ret5[i - 1], ma = ind.sma200[i - 1]
            if (r5 == null || ma == null || !(r5 <= -8 && r5 >= -25) || !(rows[i - 1].close > ma)) return null
            for (let k = Math.max(0, i - 6); k < i; k++) if (reports.has(ind.date[k])) return null
            return r5 > -12 ? 'down 8-12%' : 'down 12-25%'
        },
    },
    // #4 — oversold in an uptrend (the 2-day RSI under 5, over the 200-day), out on the first close over the 5-day
    // average or after five sessions.
    rsi2_uptrend: {
        label: '2-day RSI under 5 above the 200-day, out over the 5-day average', hold: 5,
        signal: ({ rows, i, ind }) => {
            const r = ind.rsi2[i - 1], ma = ind.sma200[i - 1]
            return r != null && ma != null && r < 5 && rows[i - 1].close > ma ? true : null
        },
        exit: ({ rows, k, ind }) => ind.sma5[k] != null && rows[k].close > ind.sma5[k],
    },
    // #5 — a gap down that HELD: 4%+ under the close before, no report on either day, and it closed in the top half of
    // its range — sellers met buyers.
    gapdown_held: {
        label: 'gapped down 4%+ with no report, closed in the top half', hold: 5, extras: ['history'],
        signal: ({ rows, i, ind, reports }) => {
            if (i < 2) return null
            const d = rows[i - 1], gap = (d.open / rows[i - 2].close - 1) * 100
            if (!(gap <= -4) || reports.has(ind.date[i - 1]) || reports.has(ind.date[i - 2])) return null
            return d.high > d.low && (d.close - d.low) / (d.high - d.low) >= 0.5 ? true : null
        },
    },
    // EACH STOCK'S OWN SWING (Roy, 2026-10-25: "each stock swing"): a close 2 standard deviations under its 20-day
    // average, out on the first close back at the average or after ten sessions — tagged by the stock's own character
    // over the past year (swingCharacter): a SWINGER (its 5-session moves reverse) is the bet; trenders and neutrals are
    // the control.
    swing_low: {
        label: 'a close 2 sd under the 20-day average, out back at it — by the stock’s own swing character', hold: 10,
        signal: ({ rows, i, ind }) => {
            const m = ind.sma20[i - 1], sd = ind.sd20[i - 1]
            if (m == null || !(sd > 0) || !(rows[i - 1].close < m - 2 * sd)) return null
            // Once per dip: not if the close before was already under the band.
            const m0 = ind.sma20[i - 2], sd0 = ind.sd20[i - 2]
            if (m0 != null && rows[i - 2].close < m0 - 2 * sd0) return null
            return swingCharacter(rows, i - 1)
        },
        exit: ({ rows, k, ind }) => ind.sma20[k] != null && rows[k].close >= ind.sma20[k],
    },
    // THE SLOWER CYCLES (Roy, 2026-10-25: "run the slower cycles") — declared before the run.
    // A weeks-long RANGE: a name going sideways (its 50-day within 5% of where it was 60 sessions ago) in a 60-session
    // range 15%+ wide, closing in the range's bottom tenth — bought, out at a close back at the range's middle or after
    // 20 sessions. Tagged by how many full swings (bottom fifth → top fifth) it made over the past year (rangeSwings):
    // the names with a rhythm are the bet.
    range_low: {
        label: 'sideways in a 15%+ 60-session range, at its bottom tenth, out at the middle — by past swings', hold: 20,
        signal: ({ rows, i, ind }) => {
            if (i < 62) return null
            const pos = (j) => {
                const hi = ind.hi60[j], lo = ind.lo60[j]
                return hi == null || !(hi > lo) ? null : (rows[j].close - lo) / (hi - lo)
            }
            const hi = ind.hi60[i - 1], lo = ind.lo60[i - 1], m = ind.sma50[i - 1], m0 = ind.sma50[i - 61]
            if (hi == null || !(lo > 0) || !(hi / lo - 1 >= 0.15) || m == null || !(m0 > 0) || !(Math.abs(m / m0 - 1) < 0.05)) return null
            const p = pos(i - 1), p0 = pos(i - 2)
            // Once per visit: not if the close before was already in the bottom tenth.
            if (p == null || !(p <= 0.1) || (p0 != null && p0 <= 0.1)) return null
            return rangeSwings(rows, ind, i - 1)
        },
        exit: ({ rows, i, k, ind }) => rows[k].close >= (ind.hi60[i - 1] + ind.lo60[i - 1]) / 2,
    },
    // A PULLBACK in an uptrend: over the 200-day with the 50-day over it, ran 8%+ above the 50-day in the month before,
    // now the first close back at or under the 50-day — bought, held 20. Tagged by the market regime (spyRegimes).
    pullback_50: {
        label: 'uptrend pullback to the 50-day after an 8%+ run over it, held 20 — by market regime', hold: 20, regime: true,
        signal: ({ rows, i, ind }) => {
            if (i < 22) return null
            const c = rows[i - 1].close, m = ind.sma50[i - 1], m200 = ind.sma200[i - 1]
            if (m == null || m200 == null || !(c > m200) || !(m > m200) || !(c <= m)) return null
            if (ind.sma50[i - 2] == null || !(rows[i - 2].close > ind.sma50[i - 2])) return null
            let ran = false
            for (let k = i - 21; k < i - 1; k++) if (ind.sma50[k] != null && rows[k].close >= ind.sma50[k] * 1.08) { ran = true; break }
            return ran ? true : null
        },
    },
    // A NAME'S OWN SEASON: on a month's first session, how often the name beat SPY in that calendar month over the
    // years before (7+ of them, up to 10; month-end closes, extras `months`) — bought, out at the month's last close.
    // The tags ARE the test: the names that beat in this month most years against those that rarely did.
    season_month: {
        label: 'a name’s own calendar month — by how often it beat SPY in that month before', hold: 23, extras: ['months'],
        signal: ({ i, ind, name, data }) => {
            const d = ind.date[i]
            if (i < 1 || d.slice(0, 7) === ind.date[i - 1].slice(0, 7)) return null
            const rate = seasonRate(name.months, data.spyMonths, d)
            if (rate == null) return null
            return rate >= 0.8 ? 'beat 80%+ of years' : rate >= 0.6 ? 'beat 60-80%' : rate > 0.4 ? 'beat 40-60%' : 'beat 40% or less'
        },
        exit: ({ k, ind }) => ind.date[k + 1] != null && ind.date[k + 1].slice(0, 7) !== ind.date[k].slice(0, 7),
    },
    // THE FALSE BREAK OF LAST WEEK'S LOW (Roy, 2026-10-25: "prev week low false break") — a session whose low trades
    // under the previous calendar week's low and closes back over it, the first break of the week: bought at the next
    // open. Held 5; held 10; held 10 out on a close under the break day's low (the stop a trader would set); by regime.
    // Tagged by the trend and the break's depth.
    falsebreak_5: falseBreak(5),
    falsebreak_10: falseBreak(10),
    falsebreak_stop: falseBreak(10, { stop: true }),
    falsebreak_regime: { ...falseBreak(5), label: 'false break of last week’s low, held 5 — by market regime', regime: true },
    // ON THE MOVERS ONLY (Roy, 2026-10-25, option 2): the same break where the name is in play — a 20-day volatility of
    // 8%+ or a 5%+ move against SPY over the five sessions to it — tagged by the trend × the kind of mover.
    falsebreak_movers_5: falseBreak(5, { movers: true }),
    falsebreak_movers_10: falseBreak(10, { movers: true }),
    // LAST MONTH'S LOW (Roy, 2026-10-25: "check also prev month low false break") — the same, on the previous calendar
    // month's low and the month's first break; held 5, 10 and 20.
    falsebreak_month_5: falseBreak(5, { period: 'month' }),
    falsebreak_month_10: falseBreak(10, { period: 'month' }),
    falsebreak_month_20: falseBreak(20, { period: 'month' }),
    // WYCKOFF'S SPRING (Roy, 2026-10-25: "wyckoff, build it") — accumulation: a real trading range (springAt), a break
    // under its support that closes back inside within three sessions; bought at the next open, out at the range's top
    // (Wyckoff's first target) or after 20 sessions — and with a stop on a close under the spring's low. Tagged by
    // whether a decline came before the range × the volume on the break (a light-volume spring is the textbook one).
    wyckoff_spring: wyckoff({ stop: false }),
    wyckoff_spring_stop: wyckoff({ stop: true }),
    // SHORT INTEREST AND SHORT VOLUME (Roy, 2026-10-25: "go with short interest and short volume" — FINRA, extras
    // `shortInterest` / `shortVolume`). Declared before the run:
    // - the LEVEL: on the first session a report is safe to know (siKnownOn), every name, by days to cover; held 10 —
    //   about the time to the next report;
    // - the CHANGE since the report before, the same way;
    // - a SHORT-VOLUME SPIKE: on each week's first session, the short share of the last five sessions against the
    //   name's own 60 before; held 5;
    // - the RUN-UP (the live rule: 5 sessions before, last three beat, SPY over its 200-day) by days to cover, and by
    //   the short-volume spike — does shorting help or hurt it?
    si_level: { label: 'short interest, the session it is published — by days to cover', hold: 10, extras: ['shortInterest'],
        signal: ({ i, ind, name }) => { const r = siKnownOn(name, ind, i); return r ? dtcBucket(r.dtc) : null } },
    si_change: { label: 'short interest, the session it is published — by its change since the report before', hold: 10, extras: ['shortInterest'],
        signal: ({ i, ind, name }) => {
            const r = siKnownOn(name, ind, i)
            if (!r || !Number.isFinite(r.change)) return null
            return r.change >= 25 ? 'up 25%+' : r.change >= 5 ? 'up 5-25%' : r.change > -5 ? 'flat (±5%)' : r.change > -25 ? 'down 5-25%' : 'down 25%+'
        } },
    sv_spike: { label: 'short-volume share of the last week against the name’s own, on the week’s first session', hold: 5, extras: ['shortVolume'],
        signal: ({ i, ind, name }) => (ind.wkStart[i] === i ? svBucket(name, ind, i) : null) },
    runup_si: runupLive('si'),
    runup_sv: runupLive('sv'),
    // DARK POOLS (Roy, 2026-10-25: "go with dark pool" — FINRA's weekly ATS volume, extras `darkPool`). Declared before
    // the run: on the session after a week's figure is PUBLISHED (two to four weeks late), the ATS share of that week's
    // volume against the name's own last eight known weeks (dpShares) × whether price rose or fell that week — a jump
    // while price fell or held is the "quiet accumulation" story; held 10. The SUSTAINED version: three published weeks
    // running, each share over the one before and over the name's own average. And the live run-up by the latest jump.
    dp_jump: { label: 'dark-pool share of a week, the session it is published — its jump × the week’s price', hold: 10, extras: ['darkPool'],
        signal: ({ i, ind, name }) => {
            const w = dpPublishedOn(name, ind, i)
            if (!w || w.jump == null) return null
            return `${dpJumpBucket(w.jump)} · price ${w.ret >= 0 ? 'up' : 'down'}`
        } },
    dp_rising: { label: 'dark-pool share rising three published weeks running, over the name’s own — by the price over them', hold: 10, extras: ['darkPool'],
        signal: ({ i, ind, name }) => {
            const w = dpPublishedOn(name, ind, i)
            if (!w) return null
            const xs = dpShares(name, ind).filter(x => x.published <= ind.date[i - 1]).slice(-3)
            if (xs.length < 3 || xs.at(-1).week !== w.week || !xs.every(x => x.jump != null && x.jump > 0) || !(xs[1].share > xs[0].share && xs[2].share > xs[1].share)) return null
            return `price ${xs.reduce((p, x) => p * (1 + x.ret / 100), 1) >= 1 ? 'up' : 'down'} over the three weeks`
        } },
    runup_dp: runupLive('dp'),
    // THE MARKET REGIME (Roy, 2026-10-25: "market regime") — the two leads, tagged by the market at entry (regimeOf):
    // SPY over / under its 200-day · calm / stormy (its 20-day volatility under / over its past year's median).
    runup_regime: { ...runup(7, { tag: 'streak' }), label: 'run-up, bought 7 sessions before the report — by market regime', regime: true },
    gapdown_regime: { ...gapdown('gap'), label: 'gapped down 4%+ with no report, closed in the top half — by market regime', regime: true },
    // #5's VARIANTS (2026-10-25, Roy: "go for the two leaders only") — declared before the three-year run, one dimension
    // each, as tags of the same trades: the gap's size, where it closed, the trend, the gap day's volume.
    gapdown_by_gap: gapdown('gap'),
    gapdown_by_close: gapdown('close'),
    gapdown_by_trend: gapdown('trend'),
    gapdown_by_volume: gapdown('volume'),
    // #7 — the FIRST close at a 52-week high after three months without one (the 52-week-high effect), held 10 and 20.
    ...Object.fromEntries([10, 20].map(hold => [`first_52w_high_${hold}`, {
        label: `first close at a 52-week high in 3+ months, held ${hold}`, hold,
        signal: ({ rows, i, ind }) => {
            if (i < 66) return null
            const prior = ind.high252[i - 2]
            if (prior == null || !(rows[i - 1].close > prior)) return null
            // No close above the year's high in the 63 sessions before: the high was set more than three months ago.
            for (let k = i - 64; k < i - 1; k++) if (ind.high252[k - 1] != null && rows[k].close > ind.high252[k - 1]) return null
            return true
        },
    }])),
    // #11 — the overreaction to a SMALL miss: EPS under the estimate by at most 10%, the stock down 10%+ from the close
    // before the report — bought on day three.
    miss_overreaction: {
        label: 'small EPS miss, down 10%+, bought on day three', hold: 5,
        signal: ({ rows, i, ind, reports }) => {
            if (i < 5) return null
            const rep = reports.get(ind.date[i - 3])
            const a = Number(rep?.epsActual), e = Number(rep?.epsEstimated)
            if (rep?.epsActual == null || rep?.epsEstimated == null || !Number.isFinite(a) || !Number.isFinite(e) || !(a < e)) return null
            if (e !== 0 && (e - a) / Math.abs(e) > 0.10) return null
            const fall = (rows[i - 1].close / rows[i - 4].close - 1) * 100
            return fall <= -10 ? true : null
        },
    },
    // #6 — the run-up into a report, by the name's BEAT STREAK: bought seven sessions before the report, out at the close
    // before it. Tagged by how many of its last three reports beat — the tags are their own control. Needs the earnings
    // history (extras `history`): the calendar alone has a year, one or two reports back.
    runup_streak: runup(7, { tag: 'streak' }),
    // #6's STRESS TESTS (2026-10-24, after it cleared zero): the entry 3 / 5 / 10 sessions out; held THROUGH the report
    // (is getting out before it the edge?); and by trend and strength (above/below the 200-day, RS vs SPY over 20
    // sessions) — does the live week gate's "base + RS" help or hurt?
    runup_3: runup(3, { tag: 'streak' }),
    runup_5: runup(5, { tag: 'streak' }),
    runup_10: runup(10, { tag: 'streak' }),
    runup_7_through: runup(7, { tag: 'streak', through: true }),
    runup_7_trend: runup(7, { tag: 'trend' }),
    // #8 — down while its sector is up: the name's five-session return in the bottom tenth of its sector's, and under 0,
    // while the sector's median rose; no report in the week.
    sector_laggard: {
        label: 'bottom tenth of a rising sector over a week, no report', hold: 5,
        signal: ({ i, ind, reports, name, data }) => {
            const sec = data.sectorDay.get(ind.date[i - 1])?.get(name.sector)
            const r5 = ind.ret5[i - 1]
            if (!sec || r5 == null || !(sec.median > 0) || !(r5 < 0) || !(r5 <= sec.p10)) return null
            for (let k = Math.max(0, i - 6); k < i; k++) if (reports.has(ind.date[k])) return null
            return sec.median > 2 ? 'sector up 2%+' : 'sector up 0-2%'
        },
    },
    // #10 — insiders BUYING with their own money (open-market purchases, Form 4 code P): two or more insiders within
    // 14 days, $50k+ in all — bought the session after the filing that made the cluster. Held 5 and 20 (the effect is
    // slow). Needs extras `insiders`.
    ...Object.fromEntries([5, 20].map(hold => [`insider_cluster_${hold}`, {
        label: `2+ insiders buying within 14 days, $50k+, held ${hold}`, hold, extras: ['insiders'],
        signal: ({ i, ind, name }) => clusterOn(name.insiders, ind.date[i - 1], ind.date[i - 2] ?? null),
    }])),
    // NEW RULES FOR THE ROTATION — test M (Roy, 2026-10-27: "build the new rules and rerun the rotation"), declared in
    // screener-lab.md §31 before the run, graded on the S&P 500 as it was.
    // THE REPORT'S REACTION, held 20: the move from the close before the report to the close of the session after it
    // (either side of the bell), against SPY — a 5%+ pop on an EPS beat (the drift), or a 5%+ drop (the recovery).
    report_popped: reportReaction('popped'),
    report_sold: reportReaction('sold'),
    // THE INDEX ITSELF (`name.indexAdded` / `name.indexRemoved`, the effective dates — announced days before, so known):
    // bought at the open of the first session the change is in effect, held 20 — the forced buying or selling is done.
    index_added: indexChange('indexAdded'),
    index_removed: indexChange('indexRemoved'),
    // BIG MONEY OUT — a session down 6%+ against SPY on 3×+ its 20-session average volume, with no report on it or the
    // session before: bought at the next open, held 10. Tagged by where it closed in its range.
    capitulation: {
        label: 'down 6%+ vs SPY on 3x volume, no report, held 10 — by the close in its range', hold: 10,
        signal: ({ rows, i, ind, reports, data }) => {
            if (i < 22) return null
            const d = rows[i - 1], s1 = data.spyByDay.get(ind.date[i - 1]), s0 = data.spyByDay.get(ind.date[i - 2])
            if (!(s0?.close > 0) || !(s1?.close > 0) || !(rows[i - 2].close > 0)) return null
            const rel = (d.close / rows[i - 2].close - s1.close / s0.close) * 100
            if (!(rel <= -6) || reports.has(ind.date[i - 1]) || reports.has(ind.date[i - 2])) return null
            let v = 0
            for (let k = i - 21; k < i - 1; k++) v += rows[k].volume || 0
            if (!(v > 0) || !((d.volume || 0) >= 3 * (v / 20))) return null
            return d.high > d.low && (d.close - d.low) / (d.high - d.low) >= 0.5 ? 'closed top half' : 'closed bottom half'
        },
    },
})

/** The report's reaction, held 20 — `side` 'popped' (5%+ over SPY on an EPS beat) or 'sold' (5%+ under SPY). Tagged by its size. */
function reportReaction(side) {
    return {
        label: `the report’s reaction ${side === 'popped' ? 'up 5%+ vs SPY on a beat' : 'down 5%+ vs SPY'}, bought day two, held 20`, hold: 20,
        signal: ({ rows, i, ind, reports, data }) => {
            if (i < 4) return null
            const rep = reports.get(ind.date[i - 2])
            if (!rep) return null
            const s0 = data.spyByDay.get(ind.date[i - 3]), s1 = data.spyByDay.get(ind.date[i - 1])
            if (!(s0?.close > 0) || !(s1?.close > 0) || !(rows[i - 3].close > 0)) return null
            const rel = (rows[i - 1].close / rows[i - 3].close - s1.close / s0.close) * 100
            if (side === 'popped') {
                const a = Number(rep.epsActual), e = Number(rep.epsEstimated)
                if (rep.epsActual == null || rep.epsEstimated == null || !Number.isFinite(a) || !Number.isFinite(e) || !(a > e) || !(rel >= 5)) return null
                return rel < 10 ? 'up 5-10%' : 'up 10%+'
            }
            return rel <= -10 ? 'down 10%+' : rel <= -5 ? 'down 5-10%' : null
        },
    }
}

/** An index change in effect — bought at the open of the first session on or after an effective date in `name[key]`, held 20. */
function indexChange(key) {
    return {
        label: `S&P 500 ${key === 'indexAdded' ? 'addition' : 'removal'}, bought the first session in effect, held 20`, hold: 20,
        signal: ({ i, ind, name }) => (name[key]?.some(d => ind.date[i] >= d && ind.date[i - 1] < d) ? true : null),
    }
}

/**
 * A RUN-UP hypothesis: bought `n` sessions before the name's next report (one entry per report), out at the close before
 * it — or, `through`, at the close of the report's session after (the reaction held). `tag`: 'streak' (how many of the
 * last three reports beat) or 'trend' (over/under the 200-day · RS vs SPY over 20 sessions, + / −).
 */
function runup(n, { tag = 'streak', through = false } = {}) {
    return {
        label: `run-up into a report, bought ${n} sessions before it${through ? ', held through it' : ''}, by ${tag}`,
        hold: n + (through ? 2 : 0), extras: ['history'],
        signal: ({ rows, i, ind, reports, name, data }) => {
            const next = nextReport(name, reports, ind.date[i - 1])
            if (!next || ind.date[i + n - 1] == null || !(ind.date[i + n - 1] < next) || !(ind.date[i + n] >= next)) return null
            if (tag === 'trend') {
                const ma = ind.sma200[i - 1], c = rows[i - 1].close
                const s20 = i >= 21 ? data.spyByDay.get(ind.date[i - 1]) : null, s0 = i >= 21 ? data.spyByDay.get(ind.date[i - 21]) : null
                const rs = s20 && s0 && rows[i - 21]?.close > 0 ? (c / rows[i - 21].close - s20.close / s0.close) * 100 : null
                return `${ma == null ? '200d ?' : c > ma ? 'over 200d' : 'under 200d'} · RS ${rs == null ? '?' : rs > 0 ? '+' : '−'}`
            }
            const last3 = name.reportDates.filter(d => d < ind.date[i - 1]).slice(-3).map(d => reports.get(d))
                .filter(r => r?.epsActual != null && r?.epsEstimated != null && Number.isFinite(Number(r.epsActual)) && Number.isFinite(Number(r.epsEstimated)))
            if (last3.length < 3) return 'unknown streak'
            const beats = last3.filter(r => Number(r.epsActual) > Number(r.epsEstimated)).length
            return beats === 3 ? '3 of 3 beat' : beats === 2 ? '2 of 3 beat' : '0-1 of 3 beat'
        },
        // Out at the close before the report — or, held through, the close of the session after it.
        exit: ({ i, k, ind, name }) => {
            const next = nextReport(name, name.reports, ind.date[i - 1])
            if (next == null) return false
            return through ? ind.date[k - 1] != null && ind.date[k - 1] >= next : ind.date[k + 1] != null && ind.date[k + 1] >= next
        },
    }
}

/**
 * A FALSE BREAK of the previous week's low (`period: 'month'` — the previous calendar month's), held `hold` — `stop`: out on the first close under the break day's low.
 * Tagged `over 200d · break 0-2%` (the trend · how far under last week's low the session traded) — or, `movers`, only on
 * a name in play (a 20-day volatility of 8%+, or 5%+ against SPY over the five sessions to the break), `over 200d · big
 * week down` (the trend · the kind of mover: big week down / up, else volatile).
 */
function falseBreak(hold, { stop = false, movers = false, period = 'week' } = {}) {
    const [startOf, lowOf] = period === 'month' ? ['moStart', 'moLowPrev'] : ['wkStart', 'wkLowPrev']
    return {
        label: `false break of last ${period}’s low${movers ? ' on a mover' : ''}, bought the next open, held ${hold}${stop ? ', out on a close under the break day’s low' : ''}`, hold,
        signal: ({ rows, i, ind, data }) => {
            const j = i - 1, p = ind[lowOf][j]
            if (j < 1 || p == null || !(rows[j].low < p) || !(rows[j].close > p)) return null
            // The first break of the week: no session before it this week traded under the level.
            for (let k = ind[startOf][j]; k < j; k++) if (rows[k].low < p) return null
            const depth = (1 - rows[j].low / p) * 100
            const trend = ind.sma200[j] == null ? '200d ?' : rows[j].close > ind.sma200[j] ? 'over 200d' : 'under 200d'
            if (movers) {
                const vol = ind.sd20[j] != null && ind.sma20[j] > 0 ? (ind.sd20[j] / ind.sma20[j]) * 100 : null
                const s0 = data?.spyByDay.get(ind.date[j - 5]), s1 = data?.spyByDay.get(ind.date[j])
                const rs5 = ind.ret5[j] != null && s0 && s1 ? ind.ret5[j] - (s1.close / s0.close - 1) * 100 : null
                const kind = rs5 != null && rs5 <= -5 ? 'big week down' : rs5 != null && rs5 >= 5 ? 'big week up' : vol >= 8 ? 'volatile' : null
                return kind ? `${trend} · ${kind}` : null
            }
            return `${trend} · break ${depth < 2 ? '0-2%' : '2%+'}`
        },
        ...(stop ? { exit: ({ rows, i, k }) => rows[k].close < rows[i - 1].low } : {}),
    }
}

/**
 * The short-interest report that became safe to know by the evening before session `i` and not by the evening before
 * that — its first session (`name.si`, oldest first, each with `known`). Null on any other session. Pure.
 */
export function siKnownOn(name, ind, i) {
    if (i < 2 || !name?.si?.length) return null
    const d1 = ind.date[i - 1], d0 = ind.date[i - 2]
    for (let k = name.si.length - 1; k >= 0; k--) {
        const r = name.si[k]
        if (r.known <= d0) return null
        if (r.known <= d1) return r
    }
    return null
}

/** The latest short-interest report known by `day` (`name.si`), or null. Pure. */
export function siAsOf(name, day) {
    for (let k = (name?.si?.length ?? 0) - 1; k >= 0; k--) if (name.si[k].known <= day) return name.si[k]
    return null
}

const dtcBucket = (dtc) => (!Number.isFinite(dtc) ? 'dtc ?' : dtc < 1 ? 'under 1 day' : dtc < 3 ? '1-3 days' : dtc < 7 ? '3-7 days' : '7+ days')

/**
 * The short-volume spike as of the evening before session `i`: the mean short share (%) of the five sessions to it,
 * against the 60 before those (`name.sv`, Map(day → %)) → 'spike +10pts' / '+5-10pts' / 'normal' / 'drop 5pts+', or null
 * short of 40 of the 60 and 4 of the 5. Pure.
 */
export function svBucket(name, ind, i) {
    if (i < 66 || !name?.sv?.size) return null
    const at = (a, b) => { const xs = []; for (let k = a; k < b; k++) { const v = name.sv.get(ind.date[k]); if (v != null) xs.push(v) } return xs }
    const recent = at(i - 5, i), base = at(i - 65, i - 5)
    if (recent.length < 4 || base.length < 40) return null
    const d = _mean(recent) - _mean(base)
    return d >= 10 ? 'spike +10pts' : d >= 5 ? '+5-10pts' : d > -5 ? 'normal' : 'drop 5pts+'
}

/**
 * A name's dark-pool weeks with their SHARE (`name.dp` — the ATS shares over the week's own volume from its bars, %),
 * the week's price move (its last close over the close before it, %), and the JUMP — the share less the mean of the
 * eight weeks published before it (null short of four). Oldest first; computed once per name. Pure.
 */
export function dpShares(name, ind) {
    if (name._dp) return name._dp
    const at = name._at ??= new Map(ind.date.map((d, k) => [d, k]))
    const rows = name.rows
    const out = []
    for (const w of name.dp ?? []) {
        const t = Date.parse(`${w.week}T12:00:00Z`)
        let vol = 0, first = null, last = null
        for (let k = 0; k < 5; k++) {
            const j = at.get(new Date(t + k * 86_400_000).toISOString().slice(0, 10))
            if (j == null) continue
            vol += rows[j].volume || 0
            first ??= j; last = j
        }
        if (!(vol > 0) || first == null || first < 1) continue
        out.push({ week: w.week, published: w.published, share: Math.min(100, (w.shares / vol) * 100), ret: (rows[last].close / rows[first - 1].close - 1) * 100 })
    }
    for (const [k, x] of out.entries()) {
        const prior = out.slice(0, k).filter(p => p.published < x.published).slice(-8)
        x.jump = prior.length >= 4 ? x.share - _mean(prior.map(p => p.share)) : null
    }
    return (name._dp = out)
}

/** The dark-pool week PUBLISHED by the evening before session `i` and not by the evening before that (the latest such), or null. Pure. */
export function dpPublishedOn(name, ind, i) {
    if (i < 2 || !name?.dp?.length) return null
    const d1 = ind.date[i - 1], d0 = ind.date[i - 2]
    const xs = dpShares(name, ind).filter(x => x.published > d0 && x.published <= d1)
    return xs.at(-1) ?? null
}

const dpJumpBucket = (j) => (j >= 5 ? 'jump +5pts+' : j >= 2 ? '+2-5pts' : j > -2 ? 'normal' : 'drop 2pts+')

/** The LIVE run-up rule (5 sessions before, last three beat, SPY over its 200-day), tagged by `by`: 'si' (days to cover), 'sv' (the spike) or 'dp' (the latest dark-pool jump). */
function runupLive(by) {
    const base = runup(5, { tag: 'streak' })
    return {
        ...base, label: `the live run-up rule — by ${{ si: 'days to cover', sv: 'the short-volume spike', dp: 'the latest dark-pool jump' }[by]}`, extras: ['history', { si: 'shortInterest', sv: 'shortVolume', dp: 'darkPool' }[by]],
        signal: (ctx) => {
            if (base.signal(ctx) !== '3 of 3 beat') return null
            const { i, ind, name, data } = ctx
            if (!(data.regimes?.get(ind.date[i - 1]) ?? '').startsWith('SPY over')) return null
            if (by === 'si') { const r = siAsOf(name, ind.date[i - 1]); return r ? dtcBucket(r.dtc) : 'no report' }
            if (by === 'dp') { const w = dpShares(name, ind).filter(x => x.published <= ind.date[i - 1]).at(-1); return w?.jump != null ? dpJumpBucket(w.jump) : 'dp ?' }
            return svBucket(name, ind, i) ?? 'sv ?'
        },
    }
}

/** Wyckoff's range: this many sessions before the break. */
export const WYCKOFF_RANGE = 40

/**
 * A Wyckoff SPRING confirmed at bar `c` (its close back over support) → `{ b, support, resistance, springLow, volRatio,
 * decline }`, or null. The range is the WYCKOFF_RANGE sessions before the break `b`: 10–40% from its lowest low
 * (support) to its highest high (resistance); support touched twice (lows within 3% of it); the last close of the range
 * within 10% of its first (sideways). `b` is the first session under support (the one before it was not), within three
 * sessions of `c`; every close from `b` to the one before `c` under support, `c`'s over it; the spring's low no more than
 * 10% under support. `volRatio` the break's volume against the range's average; `decline` the 60 sessions before the
 * range fell 10% or more. Pure.
 */
export function springAt(rows, c) {
    for (let b = c; b >= Math.max(WYCKOFF_RANGE + 61, c - 2); b--) {
        const w0 = b - WYCKOFF_RANGE
        let support = Infinity, resistance = -Infinity, vol = 0
        for (let k = w0; k < b; k++) { support = Math.min(support, rows[k].low); resistance = Math.max(resistance, rows[k].high); vol += rows[k].volume || 0 }
        if (!(rows[b].low < support) || rows[b - 1].low < support) continue
        let back = true
        for (let k = b; k < c; k++) if (rows[k].close > support) back = false
        if (!back || !(rows[c].close > support)) continue
        const width = resistance / support - 1
        if (!(width >= 0.10 && width <= 0.40) || !(Math.abs(rows[b - 1].close / rows[w0].close - 1) < 0.10)) return null
        let touches = 0
        for (let k = w0; k < b; k++) if (rows[k].low <= support * 1.03) touches++
        if (touches < 2) return null
        let springLow = Infinity
        for (let k = b; k <= c; k++) springLow = Math.min(springLow, rows[k].low)
        if (springLow < support * 0.9) return null
        const avg = vol / WYCKOFF_RANGE
        return { b, support, resistance, springLow, volRatio: avg > 0 ? (rows[b].volume || 0) / avg : null, decline: rows[w0].close / rows[w0 - 60].close - 1 <= -0.10 }
    }
    return null
}

/** A Wyckoff spring hypothesis (springAt), out at the range's top or after 20 — `stop`: or on a close under the spring's low. */
function wyckoff({ stop }) {
    // The spring each entry rode on, kept for the exit: rows → Map(entry index → the spring).
    const springs = new WeakMap()
    return {
        label: `Wyckoff spring — back over a range’s support, out at its top or after 20${stop ? ', stop under the spring’s low' : ''}`, hold: 20,
        signal: ({ rows, i }) => {
            const sp = i >= 1 ? springAt(rows, i - 1) : null
            if (!sp) return null
            if (!springs.has(rows)) springs.set(rows, new Map())
            springs.get(rows).set(i, sp)
            const v = sp.volRatio == null ? 'volume ?' : sp.volRatio < 1 ? 'light volume' : sp.volRatio < 1.5 ? 'normal volume' : 'heavy volume'
            return `${sp.decline ? 'after a decline' : 'no decline'} · ${v}`
        },
        exit: ({ rows, i, k }) => {
            const sp = springs.get(rows)?.get(i)
            if (!sp) return false
            return rows[k].close >= sp.resistance || (stop && rows[k].close < sp.springLow)
        },
    }
}

/**
 * #5 with one dimension as its tags: `gap` (4–8% / 8%+), `close` (top half / top quarter of the gap day's range),
 * `trend` (over / under the 200-day), `volume` (the gap day under / over twice its 20-day average shares).
 */
function gapdown(dim) {
    return {
        // The history: over more than a year, "no report" needs the reports the calendar does not reach.
        label: `gapped down 4%+ with no report, closed in the top half — by ${dim}`, hold: 5, extras: ['history'],
        signal: ({ rows, i, ind, reports }) => {
            if (i < 22) return null
            const d = rows[i - 1], gap = (d.open / rows[i - 2].close - 1) * 100
            if (!(gap <= -4) || reports.has(ind.date[i - 1]) || reports.has(ind.date[i - 2]) || !(d.high > d.low)) return null
            const pos = (d.close - d.low) / (d.high - d.low)
            if (pos < 0.5) return null
            if (dim === 'gap') return gap > -8 ? 'gap 4-8%' : 'gap 8%+'
            if (dim === 'close') return pos >= 0.75 ? 'top quarter' : 'top half, not quarter'
            if (dim === 'trend') return ind.sma200[i - 2] == null ? '200d ?' : rows[i - 2].close > ind.sma200[i - 2] ? 'over 200d' : 'under 200d'
            const avg = rows.slice(i - 21, i - 1).reduce((s, b) => s + (b.volume || 0), 0) / 20
            return avg > 0 && d.volume >= 2 * avg ? 'volume 2x+' : 'volume under 2x'
        },
    }
}

/**
 * A stock's swing character at bar `j`, from its last 250 sessions: the correlation of each non-overlapping 5-session
 * return with the next. Under −0.1 → 'swinger' (moves reverse), over +0.1 → 'trender', else 'neutral'; 'unknown' short
 * of history. Pure.
 */
export function swingCharacter(rows, j) {
    if (j < 250) return 'unknown'
    const r = []
    for (let k = j - 250; k + 5 <= j; k += 5) r.push(rows[k + 5].close / rows[k].close - 1)
    const a = r.slice(0, -1), b = r.slice(1)
    const ma = _mean(a), mb = _mean(b)
    let num = 0, da = 0, db = 0
    for (let k = 0; k < a.length; k++) { num += (a[k] - ma) * (b[k] - mb); da += (a[k] - ma) ** 2; db += (b[k] - mb) ** 2 }
    const c = da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0
    return c < -0.1 ? 'swinger' : c > 0.1 ? 'trender' : 'neutral'
}

/**
 * A name's range rhythm at bar `j`: the full swings — a close in the bottom fifth of its 60-session range, then one in
 * the top fifth — over its last 250 sessions → '0-1 swings' / '2-3 swings' / '4+ swings', 'unknown' short of history. Pure.
 */
export function rangeSwings(rows, ind, j) {
    if (j < 310) return 'unknown'
    let swings = 0, low = false
    for (let k = j - 250; k <= j; k++) {
        const hi = ind.hi60[k], lo = ind.lo60[k]
        if (hi == null || !(hi > lo)) continue
        const p = (rows[k].close - lo) / (hi - lo)
        if (p <= 0.2) low = true
        else if (p >= 0.8 && low) { swings++; low = false }
    }
    return swings <= 1 ? '0-1 swings' : swings <= 3 ? '2-3 swings' : '4+ swings'
}

/**
 * How often a name beat SPY in the calendar month of `day` over the years before it: `months` / `spyMonths`
 * Map('YYYY-MM' → month-end close). Each of the up-to-10 years before with both months' returns counts; under 7 → null.
 * → the share of those years it beat in. Pure.
 */
export function seasonRate(months, spyMonths, day) {
    if (!months?.size || !spyMonths?.size) return null
    const y = Number(day.slice(0, 4)), mo = day.slice(5, 7)
    const prevOf = (yy, m) => (m === '01' ? `${yy - 1}-12` : `${yy}-${String(Number(m) - 1).padStart(2, '0')}`)
    let n = 0, beat = 0
    for (let yy = y - 10; yy < y; yy++) {
        const cur = `${yy}-${mo}`, prev = prevOf(yy, mo)
        const a0 = months.get(prev), a1 = months.get(cur), s0 = spyMonths.get(prev), s1 = spyMonths.get(cur)
        if (!(a0 > 0 && a1 > 0 && s0 > 0 && s1 > 0)) continue
        n++
        if (a1 / a0 > s1 / s0) beat++
    }
    return n >= 7 ? beat / n : null
}

/**
 * The market's regime per session, from SPY's daily bars (ascending, `[{ day, close }]`) → `Map(day → tag)`: over / under
 * its 200-day average · calm / stormy — its 20-day volatility of daily returns under / over the median of the past 250
 * sessions' values. Known at that day's close. Pure.
 */
export function spyRegimes(spy) {
    const out = new Map()
    const close = spy.map(b => b.close)
    const vol = close.map((_, i) => {
        if (i < 20) return null
        const r = []
        for (let k = i - 19; k <= i; k++) r.push(Math.log(close[k] / close[k - 1]))
        const m = _mean(r)
        return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / 19)
    })
    for (let i = 0; i < spy.length; i++) {
        if (i < 270) continue
        const ma = _mean(close.slice(i - 199, i + 1))
        const past = vol.slice(i - 249, i + 1).filter(v => v != null).sort((a, b) => a - b)
        const med = past[Math.floor(past.length / 2)]
        out.set(spy[i].day, `${close[i] > ma ? 'SPY over 200d' : 'SPY under 200d'} · ${vol[i] <= med ? 'calm' : 'stormy'}`)
    }
    return out
}

/** The name's first report after `day` (its dates sorted once, kept on the name). */
function nextReport(name, reports, day) {
    const dates = name.reportDates ??= [...reports.keys()].sort()
    return dates.find(d => d > day) ?? null
}

const _daysBefore = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)

/**
 * Insider purchases filed after `prev` and by `day` that complete a CLUSTER — 2+ distinct buyers in the 14 days to `day`,
 * $50k+ in all — and did not already complete it by `prev` → '2 buyers' / '3+ buyers', or null. Pure.
 */
export function clusterOn(buys, day, prev) {
    if (!buys?.length || !day) return null
    const inWindow = (end) => buys.filter(b => b.filed <= end && b.filed > _daysBefore(end, 14))
    const qualifies = (xs) => new Set(xs.map(b => b.who)).size >= 2 && xs.reduce((s, b) => s + b.usd, 0) >= 50_000
    const now = inWindow(day)
    if (!qualifies(now) || !now.some(b => b.filed > (prev ?? ''))) return null
    if (prev && qualifies(inWindow(prev))) return null
    return new Set(now.map(b => b.who)).size >= 3 ? '3+ buyers' : '2 buyers'
}

/**
 * One trade: bought at session i's open, out at the close `hold` sessions on (or at `exit`'s), against SPY over the
 * same sessions, less the cost. → `{ day, exit_day, ret, spy, excess, net }` (%), or null when the window is not
 * complete or a bar is missing. Pure.
 */
export function trade({ rows, i, ind, name = null, hold, exit = null, spyByDay }) {
    const entry = rows[i]?.open
    if (!(entry > 0)) return null
    let j = i + hold - 1
    if (exit) for (let k = i; k < Math.min(rows.length, i + hold); k++) if (exit({ rows, i, k, ind, name })) { j = k; break }
    if (j >= rows.length) return null
    const day = ind.date[i], exitDay = ind.date[j]
    const s0 = spyByDay.get(day), s1 = spyByDay.get(exitDay)
    if (!(s0?.open > 0) || !(s1?.close > 0)) return null
    const ret = (rows[j].close / entry - 1) * 100, spy = (s1.close / s0.open - 1) * 100
    const cost = costFor(ind.adv20[i - 1] ?? 0)
    return { day, exit_day: exitDay, ret, spy, excess: ret - spy, net: ret - spy - cost }
}

/** Is the name testable on session i — price and dollar volume as of the evening before? Pure. */
export const testable = (rows, i, ind) => i >= 1 && rows[i - 1].close >= MIN_PRICE && (ind.adv20[i - 1] ?? 0) >= MIN_ADV

/**
 * Run one hypothesis (or the BASELINE, `h` null: every testable name, every session) over `data` → the trades, each
 * `{ day, symbol, tag, ret, spy, excess, net }`. `days` the sessions to enter on. Pure.
 */
export function runHypothesis(h, data, { days }) {
    const want = new Set(days)
    const out = []
    for (const [symbol, s] of data.names) {
        for (let i = 1; i < s.rows.length; i++) {
            if (!want.has(s.ind.date[i]) || !testable(s.rows, i, s.ind)) continue
            let tag = h ? h.signal({ rows: s.rows, i, ind: s.ind, reports: s.reports, name: s, data }) : true
            // A regime hypothesis keeps its signal and tags each trade by the market the evening before (spyRegimes).
            if (h?.regime && tag != null && tag !== false) tag = data.regimes?.get(s.ind.date[i - 1]) ?? 'regime ?'
            if (tag == null || tag === false) continue
            const t = trade({ rows: s.rows, i, ind: s.ind, name: s, hold: h?.hold ?? 5, exit: h?.exit ?? null, spyByDay: data.spyByDay })
            if (t) out.push({ symbol, tag: tag === true ? null : tag, ...t })
        }
    }
    return out
}

/**
 * What a name looked like at the close of bar `j` (the evening before a week) — the traits the WINNERS study compares
 * (Roy, 2026-10-25: "focus on the up moves and see what they share"). `i0`/`i1` the week's first and last bars, for the
 * report that falls INSIDE it (known in advance — companies announce the date). → `{ trait: value }`. Pure.
 */
export function traitsAt({ rows, ind, reports, name, data }, j, i0, i1) {
    const c = rows[j].close
    // The bucket of `v`: the first cut it is under, or the last label.
    const b = (v, cuts, labels) => {
        if (v == null) return '?'
        const k = cuts.findIndex(x => v < x)
        return labels[k === -1 ? cuts.length : k]
    }
    let reportIn = 'none'
    for (let k = i0; k <= i1; k++) if (reports.has(ind.date[k])) reportIn = 'in the week'
    if (reportIn === 'none') for (let k = Math.max(0, j - 4); k <= j; k++) if (reports.has(ind.date[k])) reportIn = 'the week before'
    const hi = ind.hi60[j], lo = ind.lo60[j]
    const pos = hi != null && hi > lo ? (c - lo) / (hi - lo) : null
    const vol5 = rows.slice(Math.max(0, j - 4), j + 1).reduce((s, x) => s + (x.volume || 0), 0) / 5
    const vol20 = j >= 20 ? rows.slice(j - 19, j + 1).reduce((s, x) => s + (x.volume || 0), 0) / 20 : null
    const ret20 = j >= 20 && rows[j - 20].close > 0 ? (c / rows[j - 20].close - 1) * 100 : null
    return {
        report: reportIn,
        'last week': b(ind.ret5[j], [-5, 0, 5], ['down 5%+', 'down 0-5%', 'up 0-5%', 'up 5%+']),
        'last month': b(ret20, [-10, 0, 10], ['down 10%+', 'down 0-10%', 'up 0-10%', 'up 10%+']),
        '200-day': ind.sma200[j] == null ? '?' : c > ind.sma200[j] ? 'over' : 'under',
        '60-day range': b(pos, [1 / 3, 2 / 3, 0.95], ['bottom third', 'middle third', 'top third', 'at the top']),
        '52-week high': ind.high252[j] == null ? '?' : c >= ind.high252[j] * 0.97 ? 'within 3%' : c >= ind.high252[j] * 0.8 ? '3-20% under' : '20%+ under',
        'volume last week': vol20 ? b(vol5 / vol20, [0.8, 1.25, 2], ['quiet', 'normal', 'rising', '2x+']) : '?',
        volatility: ind.sd20[j] != null && ind.sma20[j] > 0 ? b((ind.sd20[j] / ind.sma20[j]) * 100, [2, 4, 8], ['under 2%', '2-4%', '4-8%', '8%+']) : '?',
        'dollar volume': b(ind.adv20[j], [20e6, 100e6, 500e6], ['$5-20M', '$20-100M', '$100-500M', '$500M+']),
        price: b(c, [10, 30, 100], ['$5-10', '$10-30', '$30-100', '$100+']),
        sector: name.sector ?? '?',
        market: data.regimes?.get(ind.date[j]) ?? '?',
    }
}

/**
 * The last `weeks` complete weeks of `days` (sessions, ascending) — grouped by the Monday of their week; complete is 5
 * sessions, or a holiday week's 4 → `[[day, …], …]`, oldest first. Pure.
 */
export function labWeeks(days, weeks) {
    const byWeek = new Map()
    for (const d of days) {
        const t = new Date(`${d}T12:00:00Z`), mon = new Date(t - ((t.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10)
        if (!byWeek.has(mon)) byWeek.set(mon, [])
        byWeek.get(mon).push(d)
    }
    return [...byWeek.values()].filter(ds => ds.length >= 4).slice(-weeks)
}

/**
 * THE WINNERS STUDY: over the last `weeks` complete weeks, each week's biggest up moves — bought at the week's first open,
 * out at its last close, against SPY (trade, the same yardstick less the cost) — the top `top` by net, those at least
 * `min`% over SPY (`side: 'down'`, the mirror: the biggest losers, `min`% under). Each is set against EVERY testable name that week on the traits the evening before (traitsAt): a
 * trait the winners carry no more often than everyone is not what they share. → `{ weeks: [{ start, end, spy, winners:
 * [{ symbol, net, ret, best_day, best_day_report, traits }] }], lift: { trait: { value: { winners, all, lift } } } }`.
 * Pure.
 */
export function winnersStudy(data, { weeks = 24, top = 20, min = 10, side = 'up' } = {}) {
    const span = labWeeks(data.spyDays, weeks)
    const counts = {}   // trait → value → { w, a }
    const out = []
    let nW = 0, nA = 0
    for (const ds of span) {
        const all = []
        for (const [symbol, s] of data.names) {
            const i0 = s.ind.date.indexOf(ds[0]), i1 = s.ind.date.indexOf(ds.at(-1))
            if (i0 < 1 || i1 < i0 || !testable(s.rows, i0, s.ind)) continue
            const t = trade({ rows: s.rows, i: i0, ind: s.ind, hold: i1 - i0 + 1, spyByDay: data.spyByDay })
            if (!t) continue
            all.push({ symbol, s, i0, i1, t, traits: traitsAt({ rows: s.rows, ind: s.ind, reports: s.reports, name: s, data }, i0 - 1, i0, i1) })
        }
        // `side: 'down'` — the mirror, the week's biggest LOSERS: a trait both sides carry predicts a big move, not its direction.
        const sign = side === 'down' ? -1 : 1
        const winners = all.filter(x => sign * x.t.net >= min).sort((a, b) => sign * (b.t.net - a.t.net)).slice(0, top)
        const wset = new Set(winners.map(w => w.symbol))
        for (const x of all) for (const [k, v] of Object.entries(x.traits)) {
            const c = ((counts[k] ??= {})[v] ??= { w: 0, a: 0 })
            c.a++
            if (wset.has(x.symbol)) c.w++
        }
        nW += winners.length; nA += all.length
        const s0 = data.spyByDay.get(ds[0]), s1 = data.spyByDay.get(ds.at(-1))
        out.push({ start: ds[0], end: ds.at(-1), names: all.length, spy: _r((s1.close / s0.open - 1) * 100),
            winners: winners.map(({ symbol, s, i0, i1, t, traits }) => {
                // The week's biggest single session (close to close) — and whether a report fell on it or the day before (after the bell).
                let best = i0, move = -Infinity
                for (let k = i0; k <= i1; k++) { const m = (s.rows[k].close / s.rows[k - 1].close - 1) * 100; if (m > move) { move = m; best = k } }
                return { symbol, net: _r(t.net), ret: _r(t.ret), best_day: s.ind.date[best], best_day_move: _r(move),
                    best_day_report: s.reports.has(s.ind.date[best]) || s.reports.has(s.ind.date[best - 1]), traits }
            }) })
    }
    const lift = {}
    for (const [k, vals] of Object.entries(counts)) {
        lift[k] = Object.fromEntries(Object.entries(vals).sort((a, b) => b[1].a - a[1].a).map(([v, c]) => {
            const w = nW ? c.w / nW : 0, a = nA ? c.a / nA : 0
            return [v, { winners: _r(w * 100, 1), all: _r(a * 100, 1), lift: a ? _r(w / a) : null, n: c.w }]
        }))
    }
    return { weeks: out, winners: nW, name_weeks: nA, lift }
}

/**
 * The 95% range over NON-OVERLAPPING BLOCKS of `block` sessions (2026-10-25): a trade held five to ten sessions shares most
 * of its window with the next day's, so the per-session range treats neighbours as independent and comes out too narrow.
 * The sessions (each its mean) are cut into consecutive blocks of `block`; the range is the blocks' mean ± 1.96 standard
 * errors across blocks. `days` the span's sessions, in order. → `{ blocks, mean, ci95 }`, or null under three blocks. Pure.
 */
export function blockRange(trades, days, block) {
    const byDay = new Map()
    for (const t of trades) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day).push(t.net) }
    const means = []
    for (let k = 0; k < days.length; k += Math.max(1, block)) {
        const xs = days.slice(k, k + block).filter(d => byDay.has(d)).map(d => _mean(byDay.get(d)))
        if (xs.length) means.push(_mean(xs))
    }
    if (means.length < 3) return null
    const m = _mean(means), sd = Math.sqrt(means.reduce((s, x) => s + (x - m) ** 2, 0) / (means.length - 1))
    const se = sd / Math.sqrt(means.length)
    return { blocks: means.length, mean: _r(m), ci95: [_r(m - 1.96 * se), _r(m + 1.96 * se)] }
}

/** A group of trades → its verdict on the NET excess (groupStats: per name and per session, the 95% range), plus the raw return's and SPY's means. Pure. */
export function verdict(trades) {
    const g = groupStats(trades.map(t => ({ day: t.day, outcome: { ret_pct: _r(t.net, 4), reached: null, mfe_pct: null } })))
    return {
        n: g.n, sessions: g.dist?.sessions ?? 0, up_rate: g.up_rate,
        net_mean: g.ret_mean, net_session_mean: g.dist?.session_mean ?? null, ci95: g.dist?.ci95 ?? null,
        net_median: g.ret_median, sd: g.dist?.sd ?? null, pcts: g.dist?.pcts ?? null,
        ret_mean: _r(_mean(trades.map(t => t.ret))), spy_mean: _r(_mean(trades.map(t => t.spy))),
    }
}

/**
 * The verdict on a hypothesis's trades: all (with the block range over `hold`), by tag, and the span in two — its halves,
 * or, with `splitAt` (a date), before it and from it: the HELD-OUT test (2026-10-25: a variant is chosen on the years
 * before, and must hold on the year it never saw). Each tag is split the same way. Pure.
 */
export function report(trades, days, { hold = 5, splitAt = null } = {}) {
    const mid = splitAt ?? days[Math.floor(days.length / 2)]
    const tags = [...new Set(trades.map(t => t.tag).filter(Boolean))].sort()
    return {
        all: { ...verdict(trades), blocks: blockRange(trades, days, hold) },
        halves: { first: verdict(trades.filter(t => t.day < mid)), second: verdict(trades.filter(t => t.day >= mid)) },
        ...(tags.length ? { by_tag: Object.fromEntries(tags.map(k => {
            const xs = trades.filter(t => t.tag === k)
            return [k, { ...verdict(xs), first: verdict(xs.filter(t => t.day < mid)), second: verdict(xs.filter(t => t.day >= mid)) }]
        })) } : {}),
    }
}
