// PROTEUS v2 IN WORDS (docs/design/proteus-v2.md §5) — the one place the profile becomes text, for every reader: Axl's
// company view, Mentor's context and his levels tool, the Hotlist row page's bottom lines. Pure.
//
// Always a DESCRIPTION of how the stock moved, with the counts behind each line — never a rule that beats holding.

// Every scale but the day reads the daily bars since v2 (stockProfile.engine SCALES), each its σ over its horizon.
const WORDS = Object.freeze({
    day: { title: 'DAY TRADE (15-minute bars, the session)', bar: 'bars of 15 minutes', line: '5 sessions', hist: 'the last 3 months', next: 'the next 5 sessions' },
    short: { title: 'SHORT TERM SWING (daily bars, a week)', bar: 'sessions', line: '2 weeks', hist: 'the last 3 years', next: 'the next 2 weeks' },
    swing: { title: 'SWING (daily bars, a month)', bar: 'sessions', line: '3 months', hist: 'the last 3 years', next: 'the next 3 months' },
    long: { title: 'LONG TERM (daily bars, a quarter)', bar: 'sessions', line: '6 months', hist: 'the last 3 years', next: 'the next 6 months' },
})

const pc = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—')
const spc = (x, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—')
const sg = (x) => (Number.isFinite(x) ? `${x.toFixed(1)}σ` : '—')
const date = (ts) => (Number.isFinite(ts) ? new Date(ts * 1000).toISOString().slice(0, 10) : null)
const px = (x) => (Number.isFinite(x) ? (x >= 100 ? x.toFixed(2) : x.toFixed(x >= 1 ? 2 : 4)) : '—')
const few = (n) => `too few to say (${n ?? 0})`

/**
 * A record line: how often the target came first, the median time, and how many did not finish within the horizon's
 * hold (`cap` bars; the day scale: the session's close). No "against holding" since the fit lab (lab-proteus-fit.mjs): a
 * name's trading-vs-holding did not carry from one five years to the next — on one name it is a coin flip.
 */
export function recordLine(rec, w, cap = null) {
    if (!rec?.enough) return few(rec?.n)
    const day = w === WORDS.day, within = day ? ' by the close' : cap ? ` within ${cap} ${w.bar}` : ''
    return `from every ${day ? '15-minute close' : 'close'} over ${w.hist}${!day && cap ? `, held up to ${cap} ${w.bar}` : ''}, the target came first in ${pc(rec.win, 0)}, ~${rec.median_bars ?? '—'} ${w.bar} to resolve, ${pc(rec.never, 0)} not finished${within} [${rec.n} entries]`
}

/** One side's natural levels. */
function sideLine(lv, side, w, cap) {
    if (!lv?.enough) return `${side}: ${few(lv?.noise_n)} — its noise is not known`
    return `${side}: stop ${sg(lv.stop_sig)} (~${pc(lv.stop_pct)}), target ${sg(lv.target_sig)} (~${pc(lv.target_pct)}) → reward : risk ${lv.rr?.toFixed(2)}:1; ${recordLine(lv.record, w, cap)}`
}

/** What the natural levels are, by their basis (v2: constants × σ over the horizon; the day scale: measured). */
const levelsHead = (lv) => (lv?.basis === 'constant'
    ? 'natural levels — the stop past a normal pullback (the same multiple of σ on every stock: its own past pullbacks did not carry), the target what ~70% of entries reached within the horizon:'
    : 'natural levels — the stop just past its normal counter-move, the target a run ~70% of runs reach:')

/** One scale in lines (no title). */
export function scaleLines(p, scale) {
    const w = WORDS[scale]
    if (!p?.enough) return [`${few(p?.bars)} — not enough history on this scale`]
    const { runs, pullbacks } = p.swings
    const out = []
    out.push(`σ (its usual move in a ${p.per}): ${pc(p.sigma)}; ATR(14) ${pc(p.atr_pct)} a bar`)
    out.push(runs.enough
        ? `swings: runs median ${sg(runs.sig.median)} (~${pc(runs.pct.median)}${runs.bars != null ? `, ~${runs.bars} ${w.bar}` : ''}), pullbacks median ${sg(pullbacks.sig?.median)} (~${pc(pullbacks.pct?.median)}${pullbacks.bars != null ? `, ~${pullbacks.bars} ${w.bar}` : ''}) [${runs.n} runs]`
        : `swings: ${few(runs.n)}`)
    out.push(levelsHead(p.levels.long))
    out.push(`- ${sideLine(p.levels.long, 'long', w, p.cap)}`)
    out.push(`- ${sideLine(p.levels.short, 'short', w, p.cap)}`)
    const t = p.trend.persistence
    out.push(t.enough
        ? `trend or revert: ${t.label === 'reverts' ? 'REVERTS — a steep line tends to be followed by the other way' : t.label === 'persists' ? 'PERSISTS — a steep line tends to carry on' : 'neither — the line\'s angle says little about what comes next'} (the angle over ${w.line} vs ${w.next}: correlation ${t.corr.toFixed(2)}) [${t.n} windows]; its line now ${spc(p.trend.angle_per)} a ${p.per}, R² ${p.trend.r2?.toFixed(2)}`
        : `trend or revert: ${few(t.n)}`)
    const st = p.stretch, ep = (e, name) => (e.enough ? `after ${name}: ${w.next} median ${spc(e.next_median)}, up in ${pc(e.up, 0)} [${e.n}]` : `after ${name}: ${few(e.n)}`)
    out.push(`stretch: now ${st.now >= 0 ? '+' : ''}${st.now?.toFixed(1)} from its line (in its usual distance from it); ${ep(st.below, '2+ below')}; ${ep(st.above, '2+ above')}; any ${w.line}: ${spc(st.any_next_median)}`)
    out.push(`regime now: ${p.regime.label ?? '—'} (how straight its last ${w.line} were, against its own history: ${pc(p.regime.rank, 0)})`)
    return out
}

// ── the bottom line (Roy, 2026-11-21: "if a user reads this — what's the bottom line?") ──────────────────────────────
// What the measures ADD UP TO for a reader, by fixed rules — never a model's wording, so it cannot say more than the
// numbers. Two readings can lean a way:
//   - the TREND: the regime is a trend AND steep moves on this stock persist (that way); reverting is said as a caution
//     ("tend to cool off") and leans no way;
//   - the STRETCH: it is 2+ from its line AND that side's record (enough episodes) was itself up / down AND beat / trailed
//     its usual stretch of time by at least a quarter of σ.
// Both one way → "leans up / down"; opposite → "mixed", naming both; one → that lean; none → "no clear lean". Then the
// trade: the natural reward : risk on the lean's side (long when none) and how often it worked; and the RISK, a line of
// its own (riskLine).
// A record whose levels mostly never finish (the day scale's 78% on NVDA) says the levels do not fit the scale.

const LEAN_GAP = 0.25 // of σ: a stretch record must beat (or trail) its usual stretch by this much to lean

/** The trend reading's lean: +1 / −1 / 0, and its words. */
function trendLean(p) {
    const t = p.trend?.persistence, r = p.regime?.label
    if (!t?.enough || !(r === 'up trend' || r === 'down trend') || t.label === 'neither') return { sign: 0, words: null }
    const dir = r === 'up trend' ? 1 : -1, angle = `${spc(p.trend.angle_per)} a ${p.per}`
    // Reverting is "cools off", not "turns": the measure is the angle against the NEXT return, which on a rising stock is
    // a slower rise far more often than a fall (KO's long term: rising, reverts — read as "leans down" it said short).
    return t.label === 'persists'
        ? { sign: dir, words: `${dir > 0 ? 'rising' : 'falling'} (${angle}), and its steep moves tend to carry on` }
        : { sign: 0, words: `${dir > 0 ? 'rising' : 'falling'} (${angle}), but its steep moves tend to cool off` }
}

/** The stretch reading's lean: +1 / −1 / 0, and its words. */
function stretchLean(p, w) {
    const st = p.stretch, now = st?.now
    if (!Number.isFinite(now) || Math.abs(now) < 2) return { sign: 0, words: null }
    const e = now < 0 ? st.below : st.above, where = `${Math.abs(now).toFixed(1)} ${now < 0 ? 'below' : 'above'} its line`
    if (!e?.enough || !Number.isFinite(e.next_median) || !Number.isFinite(st.any_next_median)) {
        return { sign: 0, words: `it is ${where}, too few times before to say what followed (${e?.n ?? 0})` }
    }
    // It leans only when what followed was itself up (or down) AND beat (or trailed) its usual by the gap: TSLA's
    // +5.2% after a stretch below, against +11.4% usually, is a weaker rise — never a reason to say "down".
    const gap = e.next_median - st.any_next_median, far = Math.abs(gap) >= LEAN_GAP * p.sigma
    const sign = far && Math.sign(gap) === Math.sign(e.next_median) ? Math.sign(gap) : 0
    const rec = `${w.next} had a median of ${spc(e.next_median)} against ${spc(st.any_next_median)} usually, up in ${pc(e.up, 0)} [${e.n}]`
    return { sign, words: `it is ${where}, and after that ${rec}` }
}

/**
 * The trade on the lean's side: its natural reward : risk and how often it worked. NOT "against holding": the fit lab
 * (scripts/lab-proteus-fit.mjs, 102 names, 2026-11-21) found a name's "trading beat holding" does not carry from one
 * five years to the next (25% again vs 33% for the ones that had not) — on one name it is a coin flip said as a fact.
 */
function tradeWords(p, side, w) {
    const lv = p.levels?.[side]
    if (!lv?.enough) return `As a ${side} trade: too few swings to know its noise.`
    const rec = lv.record, rr = `${lv.rr.toFixed(1)}:1`
    if (!rec?.enough) return `As a ${side} trade: ${rr} natural levels, too few entries to know how they did.`
    if (rec.never >= 0.5) return `As a ${side} trade: its natural levels (${rr}) mostly never finished (${pc(rec.never, 0)}) — too wide for this scale.`
    const late = rec.never >= 0.15 && p.cap ? `; ${pc(rec.never, 0)} did not finish within ${p.cap} ${w.bar}` : ''
    return `As a ${side} trade: ${rr}, the target first in ${pc(rec.win, 0)}, ~${rec.median_bars ?? '—'} ${w.bar}${late}.`
}

/**
 * THE RISK (Roy, 2026-11-21): how deep a normal pullback goes, so a stop tighter is shaken out and a size can be set —
 * the side's stop. Since v2 that is the horizon's CONSTANT × the stock's σ over it (2.08σ a week, 1.73σ a month, 0.94σ
 * a quarter — lab-proteus-horizon.mjs: the same on every name, its own difference noise, σ itself carries); the day
 * scale's is still its measured noise.
 */
export function riskLine(p, scale, side = 'long') {
    if (!p?.enough || !Number.isFinite(p.sigma)) return null
    const k = p.levels?.[side]?.enough ? p.levels[side].stop_sig : null
    if (!Number.isFinite(k)) return null
    const depth = pc(k * p.sigma, 0)
    return `A normal ${side === 'short' ? 'bounce against a short' : 'pullback'} here is ~${depth} (${k.toFixed(2)}σ, σ ${pc(p.sigma)} a ${p.per}) — a stop tighter than that is usually shaken out; size the trade so ~${depth} is a loss you accept.`
}

/**
 * One scale's bottom line → `{ kind: 'up'|'down'|'mixed'|'none', title, text }`, or null when the scale is not measured.
 */
export function bottomLine(p, scale) {
    if (!p?.enough) return null
    const w = WORDS[scale], tr = trendLean(p), sx = stretchLean(p, w)
    const said = [tr.words, sx.words].filter(Boolean)
    let kind, title
    if (tr.sign && sx.sign && tr.sign !== sx.sign) { kind = 'mixed'; title = 'Mixed' }
    else if (tr.sign || sx.sign) { kind = (tr.sign || sx.sign) > 0 ? 'up' : 'down'; title = kind === 'up' ? 'Leans up' : 'Leans down' }
    else { kind = 'none'; title = 'No clear lean' }
    const joined = said.join(kind === 'mixed' ? ' — but ' : '; ')
    const reading = joined ? `: ${joined.charAt(0).toUpperCase()}${joined.slice(1)}.` : '.'
    const side = kind === 'down' ? 'short' : 'long'
    const text = `${title}${reading} ${tradeWords(p, side, w)}`
    return { kind, title, text, risk: riskLine(p, scale, side) }
}

/**
 * The profile as text — Axl's and Mentor's. `scales` picks which (default all four), the one being traded first.
 */
export function profileBrief(entry, { scales = ['short', 'swing', 'long', 'day'] } = {}) {
    if (!entry?.scales) return 'not available'
    const out = [`How ${entry.symbol} moves, measured from its own candles in its own σ — a description of how it moved, not a rule that beats holding.`]
    for (const s of scales) {
        const p = entry.scales[s]
        if (!p) continue
        if (!WORDS[s]) continue   // a scale a later version dropped
        out.push(`${WORDS[s].title}${p.enough ? `, as of ${date(p.last)}, close ${px(p.close)}` : ''}:`)
        const bl = bottomLine(p, s)
        if (bl) out.push(`- BOTTOM LINE — ${bl.text}`)
        if (bl?.risk) out.push(`- RISK — ${bl.risk}`)
        for (const l of scaleLines(p, s)) out.push(l.startsWith('- ') ? `  ${l}` : `- ${l}`)
    }
    return out.join('\n')
}

/** Levels for a requested ratio, as text (Mentor's tool). */
export function levelsBrief(l) {
    if (!l?.enough) return `${l?.symbol ?? 'the name'} on the ${l?.scale ?? ''} scale: ${l?.reason === 'too_short' ? 'not enough history' : 'too few swings to know its noise'} — no levels from Proteus.`
    const w = WORDS[{ 'day trade': 'day', 'short term swing': 'short', swing: 'swing', 'long term': 'long' }[l.scale] ?? 'swing']
    const lines = [
        `${l.symbol} ${l.side}, reward : risk ${l.ratio}:1 on the ${l.scale} scale (close ${px(l.close)} on ${date(l.as_of)}; σ ${pc(l.sigma)} a ${l.per}):`,
        `- stop ${px(l.stop.price)} (${pc(l.stop.pct)}, ${sg(l.stop.sig)}) — a normal pullback; tighter is shaken out by its normal counter-moves`,
        `- target ${px(l.target.price)} (${pc(l.target.pct)}, ${sg(l.target.sig)}) — ${l.ratio} × the stop`,
        `- the record${l.record_ratio !== l.ratio ? ` (at ${l.record_ratio}:1, the nearest kept)` : ''}: ${recordLine(l.record, w, l.cap)}`,
    ]
    // WHAT THE RATIO COSTS ON THIS HORIZON (v2): the target that fits its time, beside the one asked — a far target wins
    // less often and runs past the horizon, and no ratio stayed a name's best (lab-proteus-fit / -rolling.mjs).
    const nat = l.natural
    if (nat && Number.isFinite(nat.target_pct) && Number.isFinite(nat.rr) && Math.abs(nat.rr - l.ratio) >= 0.25) {
        lines.push(`- the target that fits this horizon's time: ~${pc(nat.target_pct)} (${sg(nat.target_sig)}, ${nat.rr.toFixed(1)}:1)${nat.record?.enough ? ` — first in ${pc(nat.record.win, 0)}, ~${nat.record.median_bars ?? '—'} ${w.bar}` : ''}. A bigger ratio wins less often and more often runs past the horizon; tested on 100 names, no ratio stayed a name's best — the ratio is the trader's choice, not this name's.`)
    }
    return lines.join('\n')
}

/**
 * The Hotlist row page's bottom lines (§5): σ, the swing scale, the natural levels and their record, trend or revert —
 * short, for the scale of the row's horizon. → `{ headline, lines: [[label, text]] }`.
 */
export function rowLines(entry, scale) {
    const p = entry?.scales?.[scale]
    if (!p?.enough) return { headline: null, lines: [], reason: p ? 'too_short' : 'unavailable' }
    const w = WORDS[scale], lv = p.levels.long, t = p.trend.persistence, bottom = bottomLine(p, scale)
    const lines = [
        ['Bottom line', bottom.text],
        ...(bottom.risk ? [['Risk', bottom.risk]] : []),
        ['Moves', `σ ${pc(p.sigma)} a ${p.per}; runs ~${pc(p.swings.runs.pct?.median)}, pullbacks ~${pc(p.swings.pullbacks.pct?.median)}`],
    ]
    if (lv.enough) lines.push(['Levels', `stop ~${pc(lv.stop_pct)}, target ~${pc(lv.target_pct)} (${lv.rr.toFixed(1)}:1)${lv.record.enough ? ` — target first ${pc(lv.record.win, 0)}, ~${lv.record.median_bars} ${w.bar}` : ''}`])
    if (t.enough) lines.push(['Trend', `${t.label === 'reverts' ? 'reverts after steep moves' : t.label === 'persists' ? 'steep moves carry on' : 'no lean'}; now ${p.regime.label}`])
    const head = t.enough && t.label !== 'neither' ? `${t.label === 'reverts' ? 'Reverts' : 'Trends'} · σ ${pc(p.sigma)} a ${p.per}` : `σ ${pc(p.sigma)} a ${p.per}`
    return { headline: { kind: t.label ?? 'neither', text: head }, bottom, lines, as_of: date(p.last) }
}
