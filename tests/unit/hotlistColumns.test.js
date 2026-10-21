import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    overheadLevels, freeRange, gradeFor, failedGate, inPlay, relativeVolume, cell, CUTOFFS,
} from '../../services/hotlist.columns.js'

// The hotlist's columns (docs/design/daily-names.md §2, §5). The board grades by FREE RANGE — the
// room to the nearest overhead level, in × ATR — and shows no entry, stop, target or R:R (§5).

/** A liquid, volatile name: $100M a day, 4% ATR, its 20-day high 6 above a 100 close. */
const S = {
    symbol: 'ABC', close: 100, atr14: 4, atr_pct: 4, adv20_usd: 100e6, avg_vol20: 1_000_000,
    day_high: 101, high5: 103, high20: 106, high50: 110, high52w: 120, rs20: 3,
    nr7: true, inside_day: false, next_earnings: null,
}

// ─── Free range ───────────────────────────────────────────────────────────────

test('free range is to the NEAREST level above price, in % and × ATR', () => {
    assert.deepEqual(freeRange(100, [106, 103, 110], 4), { level: 103, pct: 3, atr_mult: 0.75, open_sky: false })
})

test('a level AT price is no room; nothing above is OPEN SKY, never an infinite range', () => {
    assert.equal(freeRange(103, [103, 110], 4).atr_mult, 0)
    assert.deepEqual(freeRange(130, [103, 110], 4), { level: null, pct: null, atr_mult: null, open_sky: true })
})

test('each column counts its own levels (§5): open the prior-day high, week the multi-week ones', () => {
    assert.deepEqual(overheadLevels('open', S), [101, 103, 106])
    assert.deepEqual(overheadLevels('week', S), [106, 110, 120])
    assert.deepEqual(overheadLevels('mid', S, { dayHigh: 102 }), [102, 101, 103, 106], 'today\'s own high comes first in session')
    assert.deepEqual(overheadLevels('mid', S, { dayHigh: 102, price: 99 }), [102, 101, 103, 106], 'a pullback under the high: still overhead')
})

test('breaking out: a price within 0.1 ATR of the session\'s high measures to the NEXT level (Roy, 2026-10-21)', () => {
    // ATR 4 → 0.4 points. At 104.7 under a 105 high, the high is the breakout, not a ceiling.
    assert.deepEqual(overheadLevels('eod', S, { dayHigh: 105, price: 104.7 }), [103, 106])
    const eod = cell('eod', S, { price: 104.7, prevClose: 100, dayHigh: 105, dayLow: 100.5, rvol: 1.5 })
    assert.equal(eod.range.level, 106, 'not the 105 it is pressing on')
    assert.equal(eod.grade, 'B', '1.3 points / 4 ATR = 0.33× → B on eod\'s [0.5, 0.25]')
    // 0.6 under the high is more than 0.1 ATR: the high is still in the way.
    assert.equal(cell('eod', S, { price: 104.4, prevClose: 100, dayHigh: 105, dayLow: 100.5, rvol: 1.5 }).range.level, 105)
    // Over every level: open sky is possible again in session.
    assert.equal(cell('tomorrow', { ...S, high50: 0 }, { price: 107.9, prevClose: 100, dayHigh: 108, dayLow: 100, rvol: 1.5 }).range.open_sky, true)
})

test('a missing value is missing, not 0 — the fallbacks still apply', () => {
    // prevClose null → falls back to the stats close (100), so the gap is +4%, not "no previous close".
    assert.equal(inPlay('open', S, { price: 104, prevClose: null, pmVolPct: 2 }).in, true)
    assert.equal(failedGate('open', S, { price: null }), null, 'no live price → the close is the price')
})

// ─── Grades ───────────────────────────────────────────────────────────────────

test('grades follow the §5.1 cut-offs per column', () => {
    const at = (m) => ({ atr_mult: m, open_sky: false })
    assert.equal(gradeFor('open', at(1.0)), 'A')
    assert.equal(gradeFor('open', at(0.6)), 'B')
    assert.equal(gradeFor('open', at(0.2)), 'C')
    assert.equal(gradeFor('eod', at(0.5)), 'A', 'less session left, a lower bar')
    assert.equal(gradeFor('week', at(2.4)), 'B')
    assert.deepEqual(CUTOFFS.mid, [0.75, 0.4])
    assert.equal(gradeFor('week', { open_sky: true }), 'A')
})

// ─── Gates ────────────────────────────────────────────────────────────────────

test('gates: price, dollar volume, ATR, and the spread where the book is known', () => {
    assert.equal(failedGate('open', S, { price: 100, spreadPct: 0.02 }), null)
    assert.equal(failedGate('open', { ...S, adv20_usd: 30e6 }), 'dollar_volume', 'a day column wants $50M')
    assert.equal(failedGate('week', { ...S, adv20_usd: 30e6 }), null, 'the week wants $20M')
    assert.equal(failedGate('open', { ...S, atr_pct: 2 }), 'atr')
    assert.equal(failedGate('open', S, { price: 4 }), 'price')
    assert.equal(failedGate('open', S, { spreadPct: 0.2 }), 'spread')
    assert.equal(failedGate('mid', S, { spreadPct: undefined }), null, 'no book in session — not a failure')
})

// ─── In play ──────────────────────────────────────────────────────────────────

test('open: a 3% gap on real pre-market volume, or a smaller gap on fresh material news', () => {
    assert.equal(inPlay('open', S, { price: 104, prevClose: 100, pmVolPct: 2 }).in, true)
    assert.equal(inPlay('open', S, { price: 104, prevClose: 100, pmVolPct: 0.2 }).in, false, 'a gap nobody traded')
    assert.equal(inPlay('open', S, { price: 102, prevClose: 100, pmVolPct: 0.2, catalyst: { material: true } }).in, true)
    assert.equal(inPlay('open', S, { price: 102, prevClose: 100, pmVolPct: 0.2, catalyst: { material: false } }).in, false)
})

test('mid and eod need volume running ahead of an ordinary day', () => {
    const live = { price: 104, prevClose: 100, open: 101, dayHigh: 105, dayLow: 100.5 }
    assert.equal(inPlay('mid', S, { ...live, rvol: 2 }).in, true)
    assert.equal(inPlay('mid', S, { ...live, rvol: 1.1 }).in, false)
    assert.equal(inPlay('eod', S, { ...live, rvol: 1.5 }).in, true, '104 sits in the top quarter of 100.5–105')
    assert.equal(inPlay('eod', S, { ...live, price: 101, rvol: 1.5 }).in, false)
})

test('tomorrow: closing at the highs — never into earnings tonight (§2.7)', () => {
    const live = { price: 104.8, prevClose: 100, dayHigh: 105, dayLow: 100, rvol: 1.5, today: '2026-10-21' }
    assert.equal(inPlay('tomorrow', S, live).in, true)
    assert.equal(inPlay('tomorrow', { ...S, next_earnings: '2026-10-21' }, live).in, false)
})

test('week: relative strength + a structure + a scheduled date or a lasting catalyst', () => {
    const ctx = { price: 100, today: '2026-10-21' }
    assert.equal(inPlay('week', { ...S, next_earnings: '2026-10-27' }, ctx).in, true, 'earnings in 6 days')
    assert.equal(inPlay('week', S, ctx).in, false, 'structure and RS, but nothing to make it move')
    assert.equal(inPlay('week', S, { ...ctx, catalyst: { material: true, type: 'drift', surprise: 'positive' } }).in, true)
    // Long only: a negative drift (Netflix's disappointing outlook, the first live run) is no reason to buy.
    assert.equal(inPlay('week', S, { ...ctx, catalyst: { material: true, type: 'drift', surprise: 'negative' } }).in, false)
    assert.equal(inPlay('week', S, { ...ctx, catalyst: { material: true, type: 'short' } }).in, false, 'a short-lived catalyst is a day trade')
    assert.equal(inPlay('week', { ...S, rs20: -1, next_earnings: '2026-10-27' }, ctx).in, false)
})

test('relative volume is paced by how much of the session has passed', () => {
    assert.equal(relativeVolume(500_000, 1_000_000, 0.25), 2, 'half a day\'s volume a quarter in')
    assert.equal(relativeVolume(500_000, 1_000_000, 0), null)
    assert.equal(relativeVolume(500_000, 0, 0.5), null)
})

// ─── The cell ─────────────────────────────────────────────────────────────────

test('cell: graded only when it passes the gate AND is in play; otherwise "—" with the reason', () => {
    const open = cell('open', S, { price: 104, prevClose: 100, pmVolPct: 2, spreadPct: 0.02 })
    // 101 and 103 are already behind a 104 price; the nearest level above is the 20-day high, 106:
    // 2 points on a 4-point ATR = 0.5× → B.
    assert.equal(open.grade, 'B')
    assert.equal(open.range.level, 106)
    assert.ok(open.why[0].startsWith('gap +4%'))

    const notInPlay = cell('open', S, { price: 100.5, prevClose: 100, pmVolPct: 2 })
    assert.deepEqual(notInPlay, { grade: null, gate: null, why: [], range: null })

    const gated = cell('open', { ...S, atr_pct: 1.5 }, { price: 104, prevClose: 100, pmVolPct: 2 })
    assert.equal(gated.gate, 'atr')
})
