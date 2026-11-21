import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCALES, VERSION, scaleProfile, levelsAt } from '../../services/stockProfile.engine.js'
import { profileBrief, scaleLines, levelsBrief, rowLines, recordLine, bottomLine, riskLine } from '../../services/stockProfile.format.js'
import { makeStockProfileHandlers, LEVELS_FOR_DESCRIPTION } from '../../services/tools/stockProfile.tools.js'
import { isToolError } from '../../services/toolResult.util.js'

// Proteus v2 in words (services/stockProfile.format.js) and the trader's levels tool (services/tools/stockProfile.tools.js).

const DAY = 86_400
function walk(n, { drift = 0.0003, vol = 0.012, seed = 7, step = DAY } = {}) {
    let s = seed, p = 100
    const t0 = Date.parse('2016-01-04T21:00:00Z') / 1000, out = []
    for (let i = 0; i < n; i++) {
        s = (s * 1664525 + 1013904223) >>> 0
        p *= Math.exp(drift + (s / 2 ** 32 - 0.5) * vol * 3.4)
        out.push({ timestamp: t0 + i * step, open: p, high: p * 1.004, low: p * 0.996, close: p, volume: 1e6 })
    }
    return out
}
const SWING = scaleProfile(walk(2500), SCALES.swing)
const LONG = scaleProfile(walk(2500, { seed: 3 }), SCALES.long)   // daily bars since v2
const ENTRY = { symbol: 'KO', version: VERSION, scales: { swing: SWING, long: LONG }, built: { swing: '2026-11-20T21:00:00.000Z' } }

test('the brief: a description, every asked scale titled and dated, the counts in brackets', () => {
    const b = profileBrief(ENTRY)
    assert.match(b, /^How KO moves, measured from its own candles in its own σ — a description of how it moved, not a rule that beats holding\./)
    assert.match(b, /\nSWING \(daily bars, a month\), as of \d{4}-\d\d-\d\d, close /)
    assert.match(b, /\nLONG TERM \(daily bars, a quarter\), as of \d{4}-\d\d-\d\d, close /)
    assert.doesNotMatch(b, /DAY TRADE/, 'a scale not in the entry is skipped')
    assert.match(b, /\n {2}- long: stop \d+\.\dσ/, 'the sides are sub-lines')
    assert.match(b, /\[\d+ entries\]/)
    assert.match(b, /trend or revert: (REVERTS|PERSISTS|neither)/)
    assert.equal(profileBrief(null), 'not available')
    assert.doesNotMatch(profileBrief(ENTRY, { scales: ['swing'] }), /LONG TERM/)
})

// Reward first, as "3:1" means everywhere else (Roy, 2026-11-21: NVDA's "1:0.97" read as risking 0.97 to make 1).
test('reward : risk reads reward first — target ÷ stop, then ":1" — in the brief and on the row', () => {
    const lv = { ...SWING.levels.long, enough: true, stop_sig: 2, target_sig: 1.5, rr: 0.75, stop_pct: 0.09, target_pct: 0.0675 }
    const p = { ...SWING, levels: { long: lv, short: lv } }
    const lines = scaleLines(p, 'swing').join('\n')
    assert.match(lines, /reward : risk 0\.75:1;/)
    assert.doesNotMatch(lines, /reward : risk 1:/)
    const row = rowLines({ ...ENTRY, scales: { swing: p } }, 'swing').lines.find(l => l[0] === 'Levels')[1]
    assert.match(row, /\(0\.8:1\)/)
})

// ── the bottom line (Roy, 2026-11-21: "if a user reads this — what's the bottom line?") ──
// A hand-made scale: every reading neutral unless a test sets it. σ 10% a month.
const rec = (o = {}) => ({ enough: true, n: 500, win: 0.7, never: 0, median_bars: 35, per_bar: 0.002, hold_per_bar: 0.001, ...o })
const lvl = (o = {}) => ({ enough: true, stop_sig: 1.5, target_sig: 1.5, rr: 1, stop_pct: 0.15, target_pct: 0.15, record: rec(o.record), ...o, ...(o.record ? { record: rec(o.record) } : {}) })
const ep = (o = {}) => ({ enough: true, n: 16, next_median: 0.2, up: 0.88, ...o })
function scale({ regime = 'mixed', persist = 'neither', angle = -0.1, now = 0, below = ep(), above = ep({ next_median: 0.05 }), any = 0.1, long = lvl(), short = lvl() } = {}) {
    return {
        enough: true, per: 'month', sigma: 0.1, last: 1_763_000_000, close: 100,
        trend: { angle_per: angle, r2: 0.5, persistence: { enough: true, n: 38, corr: 0.3, label: persist } },
        stretch: { now, below, above, any_next_median: any },
        regime: { label: regime, rank: 0.8 },
        levels: { long, short },
    }
}

test('bottom line: a persisting trend leans its way; the trade is on that side', () => {
    const up = bottomLine(scale({ regime: 'up trend', persist: 'persists', angle: 0.08 }), 'swing')
    assert.equal(up.kind, 'up')
    assert.match(up.text, /^Leans up: Rising \(\+8\.0% a month\), and its steep moves tend to carry on\. As a long trade: 1\.0:1, the target first in 70%, ~35 sessions\.$/)
    assert.doesNotMatch(up.text, /holding/, 'no "against holding": it does not carry (lab-proteus-fit.mjs)')
    const down = bottomLine(scale({ regime: 'down trend', persist: 'persists' }), 'swing')
    assert.equal(down.kind, 'down')
    assert.match(down.text, /As a short trade:/)
})

test('bottom line: trend and stretch disagreeing is "Mixed", both named — never a side picked (NVDA swing, 2026-11-21)', () => {
    const b = bottomLine(scale({ regime: 'down trend', persist: 'persists', now: -3.5 }), 'swing')
    assert.equal(b.kind, 'mixed')
    assert.match(b.text, /^Mixed: Falling \(-10\.0% a month\), and its steep moves tend to carry on — but it is 3\.5 below its line, and after that the next 3 months had a median of \+20\.0% against \+10\.0% usually, up in 88% \[16\]\./)
    assert.match(b.text, /As a long trade:/, 'no lean → the long side')
})

test('bottom line: reverting cools off, it leans no way (KO long term was read as "leans down")', () => {
    const b = bottomLine(scale({ regime: 'up trend', persist: 'reverts', angle: 0.1 }), 'swing')
    assert.equal(b.kind, 'none')
    assert.match(b.text, /^No clear lean: Rising \(\+10\.0% a month\), but its steep moves tend to cool off\./)
})

test('bottom line: a stretch leans only when what followed went that way AND beat its usual by ¼σ', () => {
    // TSLA swing: below its line, then +5.2% against +11.4% usually — a weaker rise, not "down".
    assert.equal(bottomLine(scale({ now: -3.1, below: ep({ next_median: 0.052 }), any: 0.114 }), 'swing').kind, 'none')
    assert.equal(bottomLine(scale({ now: -3, below: ep({ next_median: 0.12 }), any: 0.1 }), 'swing').kind, 'none', 'within ¼σ of usual')
    assert.equal(bottomLine(scale({ now: -3, below: ep({ next_median: 0.2 }), any: 0.1 }), 'swing').kind, 'up')
    assert.equal(bottomLine(scale({ now: 2.5, above: ep({ next_median: -0.06 }), any: 0.02 }), 'swing').kind, 'down')
    assert.equal(bottomLine(scale({ now: 1.9, below: ep({ next_median: 0.5 }) }), 'swing').kind, 'none', 'under 2 from its line is no stretch')
    const few = bottomLine(scale({ now: -3, below: { enough: false, n: 4 } }), 'swing')
    assert.equal(few.kind, 'none')
    assert.match(few.text, /too few times before to say what followed \(4\)/)
})

test('bottom line: the trade — never against holding, levels that never finish, no levels; nothing measured → null', () => {
    assert.doesNotMatch(bottomLine(scale({ long: lvl({ record: { per_bar: 0.001, hold_per_bar: 0.002 } }) }), 'swing').text, /holding/)
    assert.match(bottomLine(scale({ long: lvl({ record: { never: 0.78 } }) }), 'day').text,
        /As a long trade: its natural levels \(1\.0:1\) mostly never finished \(78%\) — too wide for this scale\.$/)
    assert.match(bottomLine(scale({ long: { enough: false, noise_n: 3 } }), 'swing').text, /As a long trade: too few swings to know its noise\.$/)
    assert.equal(bottomLine(scale(), 'swing').text.startsWith('No clear lean. As a long trade:'), true)
    assert.equal(bottomLine({ enough: false }, 'swing'), null)
    assert.equal(bottomLine(null, 'swing'), null)
})

// The risk (lab-proteus-fit.mjs): on the swing scale 1.75σ for every name; elsewhere the name's own measured noise.
test('the risk: a normal pullback in % — the side\'s stop (v2: the horizon\'s constant × σ); short says a bounce', () => {
    const p = scale({ long: lvl({ stop_sig: 1.73 }), short: lvl({ stop_sig: 1.73 }) })
    assert.equal(riskLine(p, 'swing'), 'A normal pullback here is ~17% (1.73σ, σ 10.0% a month) — a stop tighter than that is usually shaken out; size the trade so ~17% is a loss you accept.')
    assert.match(riskLine({ ...scale({ long: lvl({ stop_sig: 0.94 }) }), per: 'quarter' }, 'long'), /~9% \(0\.94σ, σ 10\.0% a quarter\)/)
    assert.match(riskLine(p, 'swing', 'short'), /^A normal bounce against a short here is ~17%/)
    assert.equal(riskLine(scale({ long: { enough: false } }), 'day'), null, 'no levels → nothing')
    assert.equal(riskLine({ enough: false }, 'swing'), null)
    assert.equal(bottomLine(p, 'swing').risk, riskLine(p, 'swing'))
    assert.equal(bottomLine(scale({ regime: 'down trend', persist: 'persists' }), 'swing').risk, riskLine(scale(), 'swing', 'short'), "the lean's side")
})

test('the brief leads each scale with its bottom line, then its risk', () => {
    assert.match(profileBrief(ENTRY), /- BOTTOM LINE — [^\n]*\n- RISK — A normal pullback here is ~/)
    assert.match(profileBrief(ENTRY), /SWING \(daily bars, a month\)[^\n]*:\n- BOTTOM LINE — (Leans up|Leans down|Mixed|No clear lean)/)
})

test('too few: a short history and a thin record say so, never a number', () => {
    const short = scaleProfile(walk(80), SCALES.swing)
    assert.match(scaleLines(short, 'swing')[0], /too few to say \(80\) — not enough history on this scale/)
    assert.match(recordLine({ n: 4, enough: false }, { hist: 'x', bar: 'sessions' }), /too few to say \(4\)/)
    const noLevels = { ...SWING, levels: { long: { enough: false, noise_n: 3 }, short: { enough: false, noise_n: 2 } } }
    assert.ok(scaleLines(noLevels, 'swing').some(l => /long: too few to say \(3\) — its noise is not known/.test(l)))
})

test('the row: bottom lines and a headline for the scale; a missing or short scale gives a reason', () => {
    const r = rowLines(ENTRY, 'swing')
    assert.ok(r.headline.text.includes('σ'))
    assert.deepEqual(r.lines.map(l => l[0]).slice(0, 3), ['Bottom line', 'Risk', 'Moves'], 'the bottom line first, then the risk')
    assert.equal(r.lines[0][1], r.bottom.text)
    assert.equal(rowLines(ENTRY, 'day').reason, 'unavailable')
    assert.equal(rowLines({ scales: { swing: scaleProfile(walk(80), SCALES.swing) } }, 'swing').reason, 'too_short')
})

test('levels in words: the ratio, the prices, the stop at the noise, the nearest record named when not the one asked', () => {
    const l = { symbol: 'KO', enough: true, ...levelsAt(SWING, 2.2) }
    const t = levelsBrief(l)
    assert.match(t, /^KO long, reward : risk 2\.2:1 on the swing scale/)
    assert.match(t, /- stop [\d.]+ \([\d.]+%, [\d.]+σ\) — a normal pullback/)
    assert.match(t, /- target [\d.]+ .* 2\.2 × the stop/)
    assert.match(t, /the record \(at 2:1, the nearest kept\)/)
    assert.doesNotMatch(levelsBrief({ symbol: 'KO', enough: true, ...levelsAt(SWING, 3) }), /nearest kept/)
    assert.match(levelsBrief({ symbol: 'KO', scale: 'long term', enough: false, reason: 'too_few_swings' }), /too few swings to know its noise/)
    assert.match(levelsBrief({ symbol: 'KO', scale: 'swing', enough: false, reason: 'too_short' }), /not enough history/)
})

// v2: what the ratio costs on this horizon — the hold, and the target that fits its time beside the one asked.
test('levels in words: the hold within the horizon, and the target that fits it beside a far one', () => {
    const t = levelsBrief({ symbol: 'KO', enough: true, ...levelsAt(SWING, 3) })
    assert.match(t, /held up to 63 sessions, .* not finished within 63 sessions/)
    assert.match(t, /- the target that fits this horizon's time: ~[\d.]+% \(0\.8σ, 0\.5:1\)/)
    assert.match(t, /the ratio is the trader's choice, not this name's\.$/)
    // Asking for about the natural ratio says nothing extra.
    assert.doesNotMatch(levelsBrief({ symbol: 'KO', enough: true, ...levelsAt(SWING, 0.5) }), /fits this horizon/)
    assert.doesNotMatch(t, /holding/, 'no "against holding" anywhere (lab-proteus-fit.mjs)')
})

test('the tool: a ticker and a positive ratio are required; the answer is the levels in words', async () => {
    const asked = []
    const h = makeStockProfileHandlers({ levels: async (sym, r, o) => { asked.push([sym, r, o]); return { symbol: sym, enough: true, ...levelsAt(SWING, r, o.side) } } })
    assert.match(await h.get_levels_for({ ratio: 3 }), /A ticker is required/)
    assert.match(await h.get_levels_for({ ticker: 'KO', ratio: 0 }), /positive number/)
    assert.match(await h.get_levels_for({ ticker: 'KO', ratio: 'x' }), /positive number/)
    const t = await h.get_levels_for({ ticker: ' ko ', ratio: 3, horizon: 'swing', side: 'short' })
    assert.deepEqual(asked, [['KO', 3, { horizon: 'swing', side: 'short' }]])
    assert.match(t, /^KO short, reward : risk 3:1/)
    const boom = makeStockProfileHandlers({ levels: async () => { throw new Error('fmp down') } })
    const err = await boom.get_levels_for({ ticker: 'KO', ratio: 2 })
    assert.equal(isToolError(err), true, 'flagged as an error tool result')
    assert.match(err.message, /Could not measure the levels just now: fmp down/)
    assert.match(LEVELS_FOR_DESCRIPTION, /not an edge/)
})
