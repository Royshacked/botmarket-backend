import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bandConviction, multipleStretch, _plausibilityFlags } from '../../api/analyst/coverage.service.js'

// The plausibility flags — the checks that RECORD rather than refuse. `ratingCoherence` (see
// coverageCoherence.test.js) catches a rating that contradicts its own target, which is never right in
// any thesis. These two catch a JUDGMENT that may well be correct, so they stamp `flags[]` and let the
// research through.
//
// The case that produced them: TSLA, initiated 2026-08-08 with a $210 target. Every field was
// individually well-formed and the coherence gate passed it (sell, target below spot). What nothing
// compared: a $42 bear next to a $420 bull — a 10x valuation band, which is a way of saying "I don't
// know" — carrying `high` conviction at 0.78; and that $42 coming from a 30x trough multiple, below
// the lowest annual P/E the stock has ever printed (its own range is 31x–941x).

// TSLA's real annual P/E series, 2020–2025 (FMP `ratios`, the series the flag reads).
const TSLA_PE = [31, 53, 181, 188, 381, 941]

// ── band vs conviction ───────────────────────────────────────────────────────
test('a 10x band with high conviction is flagged (the TSLA case)', () => {
    const r = bandConviction({
        risk_reward: { bear: { value: 42 }, base: { value: 210 }, bull: { value: 420 } },
        conviction:  { level: 'high', score: 0.78 },
    })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'band_contradicts_conviction')
    assert.equal(r.spread, 10)
    assert.match(r.detail, /42–420/)
    assert.match(r.detail, /at most 4x/)
})

test('the ceiling widens as conviction drops — the same band is fine at low', () => {
    const band = { bear: { value: 42 }, base: { value: 210 }, bull: { value: 420 } }
    assert.equal(bandConviction({ risk_reward: band, conviction: { level: 'high' } }).ok,   false)
    assert.equal(bandConviction({ risk_reward: band, conviction: { level: 'medium' } }).ok, false)
    // A wide band with low conviction is not a contradiction — it is a correctly-labelled unknown.
    assert.equal(bandConviction({ risk_reward: band, conviction: { level: 'low' } }).ok,    true)
})

test('an ordinary equity band passes at every level', () => {
    const band = { bear: { value: 150 }, base: { value: 200 }, bull: { value: 240 } }   // 1.6x
    for (const level of ['high', 'medium', 'low'])
        assert.equal(bandConviction({ risk_reward: band, conviction: { level } }).ok, true)
})

test('the ceiling is inclusive — exactly 4x still passes at high', () => {
    assert.equal(bandConviction({
        risk_reward: { bear: { value: 50 }, bull: { value: 200 } },
        conviction:  { level: 'high' },
    }).ok, true)
    assert.equal(bandConviction({
        risk_reward: { bear: { value: 50 }, bull: { value: 201 } },
        conviction:  { level: 'high' },
    }).ok, false)
})

test('band vs conviction abstains when either side is missing or unusable', () => {
    const band = { bear: { value: 42 }, bull: { value: 420 } }
    assert.equal(bandConviction({ risk_reward: band, conviction: null }).ok, true)
    assert.equal(bandConviction({ risk_reward: band, conviction: { level: null, rationale: 'x' } }).ok, true)
    assert.equal(bandConviction({ risk_reward: null, conviction: { level: 'high' } }).ok, true)
    assert.equal(bandConviction({ risk_reward: { bear: { value: 42 } }, conviction: { level: 'high' } }).ok, true)
    // A non-positive leg would make the ratio meaningless (or infinite) rather than wide.
    assert.equal(bandConviction({ risk_reward: { bear: { value: 0 }, bull: { value: 420 } }, conviction: { level: 'high' } }).ok, true)
    assert.equal(bandConviction({ risk_reward: { bear: { value: -5 }, bull: { value: 420 } }, conviction: { level: 'high' } }).ok, true)
    assert.equal(bandConviction().ok, true)
})

// ── multiple vs the name's own history ───────────────────────────────────────
test('the TSLA bear leg is flagged: 30x is below anything the stock has printed', () => {
    const r = multipleStretch({ multiple: 30, history: TSLA_PE, leg: 'bear' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'multiple_outside_history')
    assert.equal(r.min, 31)
    assert.equal(r.max, 941)
    assert.match(r.detail, /bear leg/)
    assert.match(r.detail, /BELOW/)
})

test('the TSLA base leg is NOT flagged — 100x is unremarkable for this name', () => {
    // The point of firing only outside the observed range: 100x sits far under TSLA's 188x median,
    // but the stock traded at 31x and 53x in two of six years, so the assumption has a precedent.
    const r = multipleStretch({ multiple: 100, history: TSLA_PE, leg: 'base' })
    assert.equal(r.ok, true)
    assert.equal(r.pctile, 33)
})

test('a multiple above the whole range is flagged too (the mirror)', () => {
    const r = multipleStretch({ multiple: 45, history: [18, 19, 24, 26, 28, 34, 34, 37], leg: 'bull' })
    assert.equal(r.ok, false)
    assert.match(r.detail, /ABOVE/)
    assert.equal(r.pctile, 100)
})

test('the range edges themselves are inside it', () => {
    assert.equal(multipleStretch({ multiple: 31,  history: TSLA_PE }).ok, true)
    assert.equal(multipleStretch({ multiple: 941, history: TSLA_PE }).ok, true)
    assert.equal(multipleStretch({ multiple: 30.9, history: TSLA_PE }).ok, false)
})

test('multiple stretch abstains on a thin sample — a range needs observations', () => {
    // Ford's real series is 5 rows including a 930x near-zero-earnings year; four rows is not a range.
    assert.equal(multipleStretch({ multiple: 2, history: [5, 7, 8, 11] }).ok, true)
    assert.equal(multipleStretch({ multiple: 2, history: [5, 7, 8, 11, 930] }).ok, false)
    assert.equal(multipleStretch({ multiple: 2, history: [] }).ok, true)
    assert.equal(multipleStretch({ multiple: 2, history: null }).ok, true)
})

test('multiple stretch abstains on a missing or junk multiple', () => {
    assert.equal(multipleStretch({ multiple: null, history: TSLA_PE }).ok, true)
    assert.equal(multipleStretch({ multiple: 0,    history: TSLA_PE }).ok, true)
    assert.equal(multipleStretch({ multiple: -8,   history: TSLA_PE }).ok, true)
    assert.equal(multipleStretch().ok, true)
})

// ── assembling the flags over a whole doc ────────────────────────────────────
const io = history => ({ getMultipleHistory: async () => history })
// The real TSLA doc, cut down to what the flags read.
const TSLA_DOC = {
    symbol: 'TSLA',
    risk_reward: {
        bear: { value: 42,  multiple: 30,  forward_metric: 1.4 },
        base: { value: 210, multiple: 100, forward_metric: 2.1 },
        bull: { value: 420, multiple: 150, forward_metric: 2.8 },
    },
    conviction: { level: 'high', score: 0.78 },
}

test('the TSLA doc raises exactly two flags: the band, and the bear leg alone', async () => {
    const flags = await _plausibilityFlags(TSLA_DOC, io(TSLA_PE))
    assert.deepEqual(flags.map(f => [f.code, f.leg]), [
        ['band_contradicts_conviction', null],
        ['multiple_outside_history', 'bear'],
    ])
})

test('a wholesale offset is read as a metric mismatch and stays silent (the INTU/SHOP case)', async () => {
    // INTU: valued off ADJUSTED EPS at 11/22/30x against a GAAP P/E series of 39x–69x. Every leg lands
    // outside the range the same way, which is a units mismatch — not three bad assumptions.
    const intu = {
        symbol: 'INTU',
        risk_reward: {
            bear: { value: 242, multiple: 11, forward_metric: 22 },
            base: { value: 602, multiple: 22, forward_metric: 27.36 },
            bull: { value: 885, multiple: 30, forward_metric: 29.5 },
        },
        conviction: { level: 'medium' },
    }
    assert.deepEqual(await _plausibilityFlags(intu, io([39, 44, 51, 58, 62, 66, 69])), [])
})

test('legs missing in OPPOSITE directions still flag — that cannot be a units offset', async () => {
    const doc = {
        symbol: 'X',
        risk_reward: {
            bear: { value: 10,  multiple: 5,  forward_metric: 2 },
            bull: { value: 200, multiple: 100, forward_metric: 2 },
        },
        conviction: { level: 'low' },
    }
    const flags = await _plausibilityFlags(doc, io([20, 24, 28, 30, 34, 38]))
    assert.deepEqual(flags.map(f => f.leg), ['bear', 'bull'])
})

test('a lone judged leg outside the range still flags — there are no siblings to offset against', async () => {
    const doc = { symbol: 'X', risk_reward: { base: { value: 100, multiple: 5, forward_metric: 20 } } }
    const flags = await _plausibilityFlags(doc, io([20, 24, 28, 30, 34, 38]))
    assert.deepEqual(flags.map(f => f.leg), ['base'])
})

test('an EV-method thesis never reaches the history — and never pays for the fetch', async () => {
    // The EV→equity bridge means multiple x forward_metric misses the leg value, which is the
    // discriminator. A thrown fetch proves it was never called.
    let fetched = false
    const doc = {
        symbol: 'X',
        risk_reward: { base: { value: 300, multiple: 8, forward_metric: 50 } },   // 8 x 50 = 400 != 300
        conviction: { level: 'medium' },
    }
    const flags = await _plausibilityFlags(doc, { getMultipleHistory: async () => { fetched = true; return [1, 2, 3, 4, 5, 6] } })
    assert.deepEqual(flags, [])
    assert.equal(fetched, false)
})

test('a failing history fetch costs the flag, never the thesis', async () => {
    const flags = await _plausibilityFlags(TSLA_DOC, { getMultipleHistory: async () => { throw new Error('FMP 429') } })
    // The band flag is pure and survives; only the history-dependent one is lost.
    assert.deepEqual(flags.map(f => f.code), ['band_contradicts_conviction'])
})

test('a clean thesis raises nothing', async () => {
    const doc = {
        symbol: 'MSFT',
        risk_reward: {
            bear: { value: 396, multiple: 22, forward_metric: 18 },
            base: { value: 574, multiple: 28, forward_metric: 20.5 },
            bull: { value: 688, multiple: 32, forward_metric: 21.5 },
        },
        conviction: { level: 'medium' },
    }
    assert.deepEqual(await _plausibilityFlags(doc, io([21, 26, 27, 33, 35, 35, 36, 39])), [])
})

test('non-positive observations are dropped, and can drop the sample below the floor', () => {
    // A negative P/E (a loss year) is not a multiple the market "paid" — the provider filters these,
    // and so does this, so a series that arrives dirty cannot widen the range to meet the multiple.
    const r = multipleStretch({ multiple: 20, history: [-40, 0, 31, 53, 181, 188, 381, 941] })
    assert.equal(r.ok, false)
    assert.equal(r.min, 31)
    assert.equal(multipleStretch({ multiple: 20, history: [-40, 0, -1, 31, 53, 181] }).ok, true)  // 3 usable
})
