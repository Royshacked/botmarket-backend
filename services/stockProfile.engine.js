// PROTEUS v2 — HOW A STOCK MOVES, MEASURED IN ITS OWN σ (docs/design/proteus-v2.md, Roy 2026-11-21). The pure half: bars
// in, the profile out. Three SCALES (§2b) — a day trade (15-minute bars, the session), a swing (daily bars, a month), long
// term (weekly bars, a quarter) — each read with the same eight measures (§2): σ, the swing scale, the noise, the natural
// levels, their implied reward : risk with its record, trend or revert, the stretch from the line, the regime now. And
// `levelsFor` (§3): where the stop and the target go for a reward : risk the user asks for.
//
// A DESCRIPTION, never a rule that beats holding: the labs (proteus.md §10.12–10.21) found no dependable signal edge and
// that a name's past-best levels do not beat holding forward; what held is how a name moves. Every record line carries
// its count; under MIN_N it says too few.
//
// Bars: `{ timestamp (s), open, high, low, close, volume? }`, oldest first. No IO here.

export const VERSION = 2
export const MIN_N = 10
/** Swings are fewer than trades or windows (a year holds ~2 on the long scale): 8 is enough to read their size. */
export const MIN_LEGS = 8
/** The reward : risk ratios whose record is kept with the profile (levelsAt answers the nearest). */
export const RATIOS = Object.freeze([0.5, 1, 1.5, 2, 2.5, 3, 4, 5])

/**
 * The scales (§2b) — the day on 15-minute bars (26 a session; ~3 months of them, built from the 5-minute). `unit` — the bars a σ spans (√unit × the per-bar σ); `look` — the bars the per-bar σ is read over;
 * `history` — the bars the swings and the levels' record are read over (the "now" window); `line` — the regression /
 * regime window; `cap` — the bars a trade may last at most (the day scale: its session's close instead).
 *
 * SINCE VERSION 2 (2026-11-21, Roy: "fit the period to the horizon"; labs lab-proteus-fit / -horizon / -target /
 * -rolling.mjs, 102 large caps, five years picked, five checked) — every scale but the day reads the DAILY bars, its σ
 * the last 60 daily returns × √H for its horizon H (a week 5, a month 21, a quarter 63), its trades capped at 3 × H:
 *   - `stop` — the normal pullback is a CONSTANT × that σ, the same for every name (a name's own difference was noise:
 *     correlation −0.08 / 0.11 / 0.05 between the halves, and the constant fitted the second half better);
 *   - `target` — what ~70% of entries reached within 3 × H before that stop: the runs between swing turns last ~2 × H,
 *     so sized on them the target belonged to the next timeframe up (36–47% unfinished). From the entry, it finishes in
 *     ~H, ~2 in 3 first. The result per trade (~+0.1R) was the same whatever the target — placement is no edge.
 *   - No horizon and no ratio is "this name's": a name's best did not carry, over five years or one month.
 * The measured swings and pullbacks stay, as the description of how it moves. The day scale keeps its measured levels
 * until its own lab (its levels mostly never finish in a session).
 */
export const SCALES = Object.freeze({
    day: Object.freeze({ label: 'day trade', per: 'session', unit: 26, look: 260, history: 63 * 26, legs: 63 * 26, line: 130, cap: null, session: true, rev: 0.5, stop: null, target: null }),
    short: Object.freeze({ label: 'short term swing', per: 'week', unit: 5, look: 60, history: 756, legs: Infinity, line: 10, cap: 15, session: false, rev: 1, stop: 2.08, target: 0.69 }),
    swing: Object.freeze({ label: 'swing', per: 'month', unit: 21, look: 60, history: 756, legs: Infinity, line: 63, cap: 63, session: false, rev: 1, stop: 1.73, target: 0.81 }),
    long: Object.freeze({ label: 'long term', per: 'quarter', unit: 63, look: 60, history: 756, legs: Infinity, line: 126, cap: 189, session: false, rev: 0.5, stop: 0.94, target: 0.70 }),
})

/** The horizons the app speaks in → the scale they are read on (§2b). */
export const SCALE_OF = Object.freeze({ intraday: 'day', day: 'day', 'day trade': 'day', 'short term swing': 'short', short: 'short', swing: 'swing', 'long term': 'long', long: 'long' })
export const scaleOf = (h) => SCALE_OF[String(h ?? '').trim().toLowerCase()] ?? (SCALES[h] ? h : 'swing')
/** A day trade is flat by the close: the horizons `intraday` and `day` (agentUtils: the fault line is overnight). */
export const DAY_TRADE_HORIZONS = Object.freeze(['intraday', 'day'])
export const isDayTrade = (horizon) => DAY_TRADE_HORIZONS.includes(String(horizon ?? '').toLowerCase())


const fin = Number.isFinite
const q = (xs, p) => { const v = xs.filter(fin).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null }
const r3 = (x) => (fin(x) ? Math.round(x * 1000) / 1000 : null)
const etDay = (ts) => new Date((ts - 5 * 3600) * 1000).toISOString().slice(0, 10)   // the session's date (ET, close enough for 09:30–16:00)

/** The session each bar belongs to, and the last bar of its session (the day scale). */
export function sessionsOf(bars) {
    const day = bars.map(b => etDay(b.timestamp)), last = new Array(bars.length).fill(null)
    for (let i = bars.length - 1, cur = null; i >= 0; i--) { if (i === bars.length - 1 || day[i] !== day[i + 1]) cur = i; last[i] = cur }
    return { day, last }
}

/** The σ known at each bar: the σ of the last `look` per-bar returns × √unit. Intraday: the overnight return left out. */
export function sigmaSeries(bars, cfg, sess = null) {
    const rets = bars.map((b, i) => (i && (!cfg.session || sess.day[i] === sess.day[i - 1]) ? b.close / bars[i - 1].close - 1 : null))
    const out = new Array(bars.length).fill(null), win = []
    for (let i = 0; i < bars.length; i++) {
        if (rets[i] != null) { win.push(rets[i]); if (win.length > cfg.look) win.shift() }
        if (win.length === cfg.look) { const m = win.reduce((s, x) => s + x, 0) / win.length; out[i] = Math.sqrt(win.reduce((s, x) => s + (x - m) ** 2, 0) / (win.length - 1)) * Math.sqrt(cfg.unit) }
    }
    return out
}

/**
 * The swings: a zigzag on the closes that turns on a `rev` × σ reversal (σ at the turning bar) — legs `{ up, size, sig, bars }`,
 * size in % and `sig` the σ it is measured in. With `sess` (the day scale) the zigzag starts over each session: a day
 * trade's swings are the session's own.
 */
export function swingLegs(bars, sig, from = 0, rev = 1, sess = null) {
    const legs = []
    let dir = 0, ext = -1, start = -1
    for (let i = from; i < bars.length; i++) {
        const s = sig[i], c = bars[i].close
        if (!fin(s)) continue
        if (sess && ext >= 0 && sess.day[i] !== sess.day[i - 1]) { ext = -1; dir = 0 }
        if (ext < 0) { ext = start = i; continue }
        if (dir >= 0 && c >= bars[ext].close) { ext = i; if (dir === 0 && c > bars[start].close) dir = 1 }
        if (dir <= 0 && c <= bars[ext].close) { ext = i; if (dir === 0 && c < bars[start].close) dir = -1 }
        const turn = dir > 0 ? c <= bars[ext].close * (1 - rev * s) : dir < 0 ? c >= bars[ext].close * (1 + rev * s) : false
        if (turn) {
            if (fin(sig[ext]) && sig[ext] > 0) legs.push({ up: dir > 0, size: Math.abs(bars[ext].close / bars[start].close - 1), sig: sig[ext], bars: ext - start, end: bars[ext].close, day: sess ? sess.day[ext] : null })
            start = ext; ext = i; dir = -dir
        }
    }
    return legs
}

/**
 * THE DAY SCALE'S SWINGS (§2b): one reading per session — a zigzag rarely completes run, pullback, run inside one session.
 * In the session's σ known at its first bar: `run` the biggest rise from a low to a later high, `fall` the biggest drop
 * from a high to a later low; `pull` the deepest dip from a running high that the session later EXCEEDED (a long's noise)
 * and `rally` the highest bounce from a running low later undercut (a short's). Sessions without such a dip give none.
 */
export function sessionMoves(bars, sig, sess, from = 0) {
    const out = []
    let i = from
    while (i < bars.length) {
        const end = sess.last[i], s = sig[i]
        if (fin(s) && s > 0 && end > i) {
            let lo = Infinity, hi = -Infinity, run = 0, fall = 0, runHi = -Infinity, runLo = Infinity, dip = 0, bounce = 0
            const pulls = [], rallies = []
            for (let j = i; j <= end; j++) {
                const b = bars[j]
                if (j > i) { run = Math.max(run, b.high / lo - 1); fall = Math.max(fall, 1 - b.low / hi) }
                lo = Math.min(lo, b.low); hi = Math.max(hi, b.high)
                if (b.high > runHi) { if (dip > 0 && runHi > -Infinity) pulls.push(dip); runHi = b.high; dip = 0 } else dip = Math.max(dip, 1 - b.low / runHi)
                if (b.low < runLo) { if (bounce > 0 && runLo < Infinity) rallies.push(bounce); runLo = b.low; bounce = 0 } else bounce = Math.max(bounce, b.high / runLo - 1)
            }
            out.push({ sig: s, run, fall, pull: pulls.length ? Math.max(...pulls) : null, rally: rallies.length ? Math.max(...rallies) : null, day: sess.day[i] })
        }
        i = end + 1
    }
    return out
}

/**
 * THE NOISE (§2, measure 3): the counter-moves inside a move that then CONTINUED — for a long, the pullbacks after which
 * the next run made a new high; for a short, the rallies after which the next fall made a new low. A counter-leg that
 * ended the move (no new extreme after it) is a turn, not noise. On the day scale, only inside one session.
 */
export function counterLegs(legs, short = false) {
    const out = []
    for (let k = 1; k + 1 < legs.length; k++) {
        const prev = legs[k - 1], cur = legs[k], next = legs[k + 1]
        if (cur.up !== short || prev.up === short || next.up === short) continue
        if (prev.day !== cur.day || cur.day !== next.day) continue
        if (short ? next.end < prev.end : next.end > prev.end) out.push(cur)
    }
    return out
}

/**
 * One trade from bar i's close: the stop and the target in σ units of the σ known at i; held until one is hit or `end`
 * (a bar reaching both = the stop). Short mirrored. → `{ how: 'target'|'stop'|'open', ret, bars }` or null.
 */
export function bracketTrade(bars, i, end, stopPct, tgtPct, short = false) {
    if (end == null || end <= i) return null
    const c = bars[i].close
    const stop = short ? c * (1 + stopPct) : c * (1 - stopPct), tgt = short ? c * (1 - tgtPct) : c * (1 + tgtPct)
    for (let j = i + 1; j <= end; j++) {
        const hitStop = short ? bars[j].high >= stop : bars[j].low <= stop
        const hitTgt = short ? bars[j].low <= tgt : bars[j].high >= tgt
        if (hitStop) return { how: 'stop', ret: -stopPct, bars: j - i }
        if (hitTgt) return { how: 'target', ret: tgtPct, bars: j - i }
    }
    const r = bars[end].close / c - 1
    return { how: 'open', ret: short ? -r : r, bars: end - i }
}

/**
 * The record of a (stop σ, target σ) pair over the history window: an entry at every bar; the levels from the σ known
 * there. Win rate, never resolved, the median bars, the return per bar held, and holding's over the same entries.
 */
export function pairRecord(bars, sig, cfg, sess, stopSig, tgtSig, { short = false, from = 0 } = {}) {
    let n = 0, wins = 0, open = 0, sumRet = 0, sumBars = 0, holdRet = 0, holdBars = 0
    const held = []
    for (let i = from; i < bars.length - 1; i++) {
        const s = sig[i]
        if (!fin(s) || s <= 0) continue
        const end = cfg.session ? sess.last[i] : Math.min(bars.length - 1, i + cfg.cap)
        if (end === i || (!cfg.session && i + cfg.cap >= bars.length)) continue
        const t = bracketTrade(bars, i, end, stopSig * s, tgtSig * s, short)
        if (!t) continue
        n++; if (t.how === 'target') wins++; if (t.how === 'open') open++
        sumRet += t.ret; sumBars += t.bars; held.push(t.bars)
        const hr = bars[end].close / bars[i].close - 1
        holdRet += short ? -hr : hr; holdBars += end - i
    }
    if (n < MIN_N) return { n, enough: false }
    return {
        n, enough: true, win: r3(wins / n), never: r3(open / n), median_bars: q(held, 0.5),
        per_bar: sumBars ? sumRet / sumBars : null, hold_per_bar: holdBars ? holdRet / holdBars : null,
    }
}

/** The least-squares line of the log closes over the `w` bars ending at i → its slope (per bar), R² and the stretch (residual σ). */
export function lineAt(bars, i, w) {
    if (i < w - 1) return null
    let sx = 0, sy = 0, sxx = 0, sxy = 0
    for (let k = 0; k < w; k++) { const y = Math.log(bars[i - w + 1 + k].close); sx += k; sy += y; sxx += k * k; sxy += k * y }
    const b = (w * sxy - sx * sy) / (w * sxx - sx * sx), a = (sy - b * sx) / w, my = sy / w
    let ssr = 0, sst = 0
    for (let k = 0; k < w; k++) { const y = Math.log(bars[i - w + 1 + k].close), e = y - (a + b * k); ssr += e * e; sst += (y - my) ** 2 }
    const rs = Math.sqrt(ssr / Math.max(1, w - 2))
    return { slope: b, r2: sst ? 1 - ssr / sst : 0, stretch: rs ? (Math.log(bars[i].close) - (a + b * (w - 1))) / rs : 0 }
}

const corr = (xs, ys) => {
    const n = xs.length
    if (n < 3) return null
    const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n
    let nu = 0, vx = 0, vy = 0
    for (let k = 0; k < n; k++) { nu += (xs[k] - mx) * (ys[k] - my); vx += (xs[k] - mx) ** 2; vy += (ys[k] - my) ** 2 }
    return vx && vy ? nu / Math.sqrt(vx * vy) : null
}

/** The efficiency ratio over `w` bars ending at i: the net move / the path (1 a clean trend, 0 noise), signed. */
export function efficiency(bars, i, w) {
    if (i < w) return null
    let path = 0
    for (let k = i - w + 1; k <= i; k++) path += Math.abs(bars[k].close - bars[k - 1].close)
    return path ? (bars[i].close - bars[i - w].close) / path : 0
}

/** One scale's profile (§2). → null with `reason` when there are too few bars. */
export function scaleProfile(bars, cfg) {
    const minBars = cfg.look + cfg.line + MIN_N
    if (!Array.isArray(bars) || bars.length < minBars) return { enough: false, reason: 'too_short', bars: bars?.length ?? 0 }
    const n = bars.length
    const sess = cfg.session ? sessionsOf(bars) : null
    const sig = sigmaSeries(bars, cfg, sess)
    const now = n - 1
    const from = Math.max(0, n - cfg.history)
    // 1. σ, and the ATR(14) in % for the charts.
    let tr = 0
    for (let i = Math.max(1, n - 14); i < n; i++) tr += Math.max(bars[i].high, bars[i - 1].close) - Math.min(bars[i].low, bars[i - 1].close)
    const atrPct = tr / Math.min(14, n - 1) / bars[now].close
    // 2. The swing scale over the history window.
    // The swings over `legs` bars (all the history on the daily and weekly: in σ units they scale with today's σ, and a
    // decade holds ~20 of them, three years ~6); the record over `history` (the now window).
    const legs = cfg.session ? [] : swingLegs(bars, sig, Math.max(0, n - cfg.legs), cfg.rev, sess)
    const days = cfg.session ? sessionMoves(bars, sig, sess, Math.max(0, n - cfg.legs)) : null
    const leg = (ls) => (ls.length < MIN_LEGS ? { n: ls.length, enough: false } : {
        n: ls.length, enough: true,
        sig: { median: r3(q(ls.map(l => l.size / l.sig), 0.5)), q1: r3(q(ls.map(l => l.size / l.sig), 0.25)), q3: r3(q(ls.map(l => l.size / l.sig), 0.75)) },
        pct: { median: r3(q(ls.map(l => l.size), 0.5)) }, bars: q(ls.map(l => l.bars), 0.5),
    })
    // Day: a session's run / fall as the legs (size in %, sig its σ, bars unknown → null).
    const asLegs = (k, up) => days.map(d => ({ up, size: d[k], sig: d.sig, bars: null }))
    const runs = leg(cfg.session ? asLegs('run', true) : legs.filter(l => l.up)), pulls = leg(cfg.session ? asLegs('fall', false) : legs.filter(l => !l.up))
    // 3–5. The noise, the natural levels, their reward : risk and record — per side. A long's noise is the pullbacks and
    // its room the runs; a short's the mirror (the rallies against it, the falls it rides). With the record of every
    // ratio in RATIOS on the side's noise stop — what `levelsAt` answers from, no bars needed later.
    const sizes = (up) => (cfg.session ? days.map(d => (up ? d.run : d.fall) / d.sig) : legs.filter(l => l.up === up).map(l => l.size / l.sig))
    const noise = (short) => (cfg.session ? days.filter(d => d[short ? 'rally' : 'pull'] != null).map(d => d[short ? 'rally' : 'pull'] / d.sig) : counterLegs(legs, short).map(l => l.size / l.sig))
    const side = (short) => {
        const against = noise(short), withIt = sizes(!short), fixed = cfg.stop != null
        // Constant levels (v2) need only σ; the day scale's measured ones need enough swings.
        if (!fixed && (against.length < MIN_LEGS || withIt.length < MIN_LEGS)) return { enough: false, noise_n: against.length, moves_n: withIt.length }
        if (!fin(sig[now]) || sig[now] <= 0) return { enough: false, noise_n: against.length, moves_n: withIt.length }
        const stopSig = fixed ? cfg.stop : r3(q(against, 0.75)), tgtSig = fixed ? cfg.target : r3(q(withIt, 0.3)), s = sig[now]
        const ratios = {}
        for (const R of RATIOS) ratios[R] = pairRecord(bars, sig, cfg, sess, stopSig, r3(R * stopSig), { short, from })
        return {
            enough: true, noise_n: against.length, moves_n: withIt.length, stop_sig: stopSig, target_sig: tgtSig, rr: r3(tgtSig / stopSig), stop_pct: r3(stopSig * s), target_pct: r3(tgtSig * s),
            basis: fixed ? 'constant' : 'measured',
            typical_sig: r3(q(withIt, 0.5)), record: pairRecord(bars, sig, cfg, sess, stopSig, tgtSig, { short, from }), ratios,
        }
    }
    const levels = { long: side(false), short: side(true) }
    // 6. Trend or revert: the line's angle and R² now; over all the bars, separate windows — the angle vs the next return.
    const lnow = lineAt(bars, now, cfg.line)
    const xs = [], ys = []
    for (let i = cfg.line - 1; i + cfg.line < n; i += cfg.line) { const l = lineAt(bars, i, cfg.line); xs.push(l.slope); ys.push(bars[i + cfg.line].close / bars[i].close - 1) }
    const c = xs.length >= MIN_N ? corr(xs, ys) : null
    const trend = {
        angle_per: r3(Math.exp(lnow.slope * cfg.unit) - 1), r2: r3(lnow.r2),
        persistence: { n: xs.length, enough: c != null, corr: r3(c), label: c == null ? null : c <= -0.15 ? 'reverts' : c >= 0.15 ? 'persists' : 'neither' },
    }
    // 7. The stretch from the line: now, and after stretches of 2+ below / above (episodes, a new one after `line` bars).
    const episodes = (test) => {
        const out = []
        let last = -Infinity
        for (let i = cfg.line - 1; i + cfg.line < n; i++) { const l = lineAt(bars, i, cfg.line); if (test(l.stretch)) { if (i - last > cfg.line) out.push(bars[i + cfg.line].close / bars[i].close - 1); last = i } }
        return out.length < MIN_N ? { n: out.length, enough: false } : { n: out.length, enough: true, next_median: r3(q(out, 0.5)), up: r3(out.filter(x => x > 0).length / out.length) }
    }
    const any = []
    for (let i = cfg.line - 1; i + cfg.line < n; i += cfg.line) any.push(bars[i + cfg.line].close / bars[i].close - 1)
    const stretch = { now: r3(lnow.stretch), below: episodes(z => z <= -2), above: episodes(z => z >= 2), any_next_median: r3(q(any, 0.5)) }
    // 8. The regime now: the efficiency ratio's place among all earlier bars'.
    const ers = []
    for (let i = cfg.line; i < n; i++) { const e = efficiency(bars, i, cfg.line); if (e != null) ers.push(Math.abs(e)) }
    const erNow = efficiency(bars, now, cfg.line)
    const rank = ers.length ? ers.filter(x => x < Math.abs(erNow)).length / ers.length : null
    const regime = { er: r3(erNow), rank: r3(rank), label: rank == null ? null : rank < 1 / 3 ? 'range' : rank > 2 / 3 ? (erNow > 0 ? 'up trend' : 'down trend') : 'mixed' }
    return {
        enough: true, scale: cfg.label, per: cfg.per, cap: cfg.cap, bars: n, history_from: bars[from].timestamp, last: bars[now].timestamp, close: bars[now].close,
        sigma: r3(sig[now]), atr_pct: r3(atrPct), swings: { runs, pullbacks: pulls }, levels, trend, stretch, regime,
    }
}

/**
 * LEVELS FOR A REQUESTED REWARD : RISK (§3), from a stored scale profile: the stop where the side's noise says, the target
 * `ratio` × the stop; in σ, in % and in prices from the profile's last close; with the record of the nearest ratio in
 * RATIOS (said, when it is not the one asked). Proteus does not refuse a ratio — it says what it costs on this stock.
 * → null when the scale has too few swings to know its noise.
 */
export function levelsAt(prof, ratio, side = 'long') {
    const lv = prof?.enough ? prof.levels?.[side === 'short' ? 'short' : 'long'] : null
    if (!lv?.enough || !(ratio > 0)) return null
    const short = side === 'short', c = prof.close, s = prof.sigma
    const nearest = RATIOS.reduce((a, b) => (Math.abs(b - ratio) < Math.abs(a - ratio) ? b : a))
    const tgtSig = r3(ratio * lv.stop_sig), stopPct = lv.stop_sig * s, tgtPct = tgtSig * s
    return {
        scale: prof.scale, side: short ? 'short' : 'long', ratio, close: c, as_of: prof.last, sigma: s, per: prof.per,
        stop: { sig: lv.stop_sig, pct: r3(stopPct), price: r3(short ? c * (1 + stopPct) : c * (1 - stopPct)) },
        target: { sig: tgtSig, pct: r3(tgtPct), price: r3(short ? c * (1 - tgtPct) : c * (1 + tgtPct)) },
        typical_move_sig: lv.typical_sig, record_ratio: nearest, record: lv.ratios?.[nearest] ?? null,
        // The target that fits this horizon's time (v2) — what a bigger ratio is weighed against.
        natural: { target_sig: lv.target_sig, target_pct: lv.target_pct, rr: lv.rr, record: lv.record ?? null },
        cap: prof.cap ?? null,
    }
}

/** Daily bars → weekly (Monday-first weeks, each stamped at its first bar; a week is done from its Saturday — the week
 *  still in progress at `nowSec` is left out). Pure. */
export function weeklyOf(daily, nowSec = null) {
    const monday = (ts) => { const d = Math.floor(ts / 86400), wd = (new Date(d * 86400000).getUTCDay() + 6) % 7; return (d - wd) * 86400 }
    const out = []
    let cur = null, key = null
    for (const b of daily) {
        const k = monday(b.timestamp)
        if (k !== key) {
            if (cur) out.push(cur)
            key = k
            cur = { timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }
        } else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume ?? 0 }
    }
    if (cur && (nowSec == null || nowSec >= key + 5 * 86400)) out.push(cur)
    return out
}
