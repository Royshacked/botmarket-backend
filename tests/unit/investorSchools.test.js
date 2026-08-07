// The investor schools — two axes (selection: which names qualify · allocation: how risk is spread).
// Node's built-in harness:  node --test tests/unit/investorSchools.test.js
//
// What these guard is mostly SILENCE. A school that fails to reach the ranking changes the prose and
// nothing else — a costume, indistinguishable from a working feature in any transcript. So the tests
// that matter are the ones asserting a lens actually MOVES the number, and that a book written before
// schools existed still ranks exactly as it did.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
    ALLOCATION_SCHOOLS, SELECTION_SCHOOLS, ALLOCATION_RULES, SELECTION_RULES, SELECTION_WEIGHTS,
    normalizeAllocation, normalizeSelection, selectionWeights, incoherentCombo, buildSchoolSection,
} from '../../services/investorSchools.js'
import { _cleanScore, _normalizeScan } from '../../services/agents/scanner.agent.service.js'
import { _parseScreenRequest } from '../../services/agents/portfolio.agent.service.js'

// ── the vocabulary ────────────────────────────────────────────────────────────

test('unknown or absent school → null, never a silent default', () => {
    // A mandate written before schools existed must not acquire a stance by accident.
    assert.equal(normalizeSelection(undefined), null)
    assert.equal(normalizeSelection('buffett'), null)     // a person is not a method
    assert.equal(normalizeAllocation('risk parity'), null) // near-miss spelling is still unknown
    assert.equal(normalizeSelection('quality-value'), 'quality-value')
    assert.equal(normalizeAllocation('risk-balanced'), 'risk-balanced')
})

test('every school has a rule and a review question', () => {
    // The review question is what a school actually buys — a value with no way to re-read the book
    // against it is decoration.
    for (const k of SELECTION_SCHOOLS)  assert.ok(SELECTION_RULES[k]?.rule && SELECTION_RULES[k]?.review, `selection ${k}`)
    for (const k of ALLOCATION_SCHOOLS) assert.ok(ALLOCATION_RULES[k]?.rule && ALLOCATION_RULES[k]?.review, `allocation ${k}`)
})

// ── the weights (the mechanical half) ─────────────────────────────────────────

test('every weight set sums to 1', () => {
    for (const [name, w] of Object.entries(SELECTION_WEIGHTS)) {
        const sum = Object.values(w).reduce((a, b) => a + b, 0)
        assert.ok(Math.abs(sum - 1) < 1e-9, `${name} sums to ${sum}`)
    }
})

test('each selection school leads with its own axis', () => {
    const top = lens => Object.entries(selectionWeights(lens)).sort((a, b) => b[1] - a[1])[0][0]
    assert.equal(top('growth-durability'), 'growth')
    assert.equal(top('income'), 'balance_sheet')          // payout coverage is the bar, not the yield
    // quality-value leads on quality AND valuation together — both halves are required.
    const qv = selectionWeights('quality-value')
    assert.equal(qv.quality, qv.valuation)
    assert.ok(qv.quality > qv.growth)
})

test('no lens, an unknown lens, and passive all fall back to the neutral blend', () => {
    // passive never screens, so if one arrives here something upstream is wrong — land neutrally
    // rather than inventing a ranking for a school that has no stock-picking view.
    for (const lens of [null, undefined, 'nonsense', 'passive']) {
        assert.deepEqual(selectionWeights(lens), SELECTION_WEIGHTS.default, `lens=${lens}`)
    }
})

// ── the lens reaches the ranking ──────────────────────────────────────────────

test('the same scores rank differently under different schools', () => {
    // THE test: a cheap, low-growth compounder vs an expensive fast grower. If the school didn't
    // reach the composite these two totals would be identical under both lenses.
    const compounder = { quality: 90, valuation: 85, growth: 30, balance_sheet: 90 }
    const grower     = { quality: 70, valuation: 30, growth: 95, balance_sheet: 60 }

    const qv = t => _cleanScore(t, 'long term', 'investing', 'quality-value').total
    const gd = t => _cleanScore(t, 'long term', 'investing', 'growth-durability').total

    assert.ok(qv(compounder) > qv(grower), 'quality-value must prefer the cheap compounder')
    assert.ok(gd(grower) > gd(compounder), 'growth-durability must prefer the grower')
})

test('a list with no lens scores exactly as it did before schools existed', () => {
    // The pre-schools blend, byte-identical: quality .30 / valuation .30 / growth .25 / bs .15.
    const s = _cleanScore({ quality: 88, valuation: 62, growth: 80, balance_sheet: 90 }, 'long term', 'investing')
    assert.equal(s.total, Math.round(88 * 0.30 + 62 * 0.30 + 80 * 0.25 + 90 * 0.15))
})

test('_normalizeScan carries the lens onto the list, and only for investing', () => {
    const scan = {
        thesis: 'core growth sleeve', direction: 'long', style: 'long term', lens: 'income',
        candidates: [{ ticker: 'ABC', direction: 'long', thesis: 't', analysis: 'a',
            score: { quality: 70, valuation: 60, growth: 50, balance_sheet: 80 } }],
    }
    assert.equal(_normalizeScan(scan, null, null, 'investing').lens, 'income')
    // A trading list has no selection school — the concept belongs to the book, not the trade.
    assert.equal(_normalizeScan({ ...scan, lens: 'income' }, null, null, 'trading').lens, null)
    // A hallucinated school lands as "no lens", never as a word nothing downstream understands.
    assert.equal(_normalizeScan({ ...scan, lens: 'dalio' }, null, null, 'investing').lens, null)
})

test('the screen_request carries the selection school across the hop, validated', () => {
    const req = raw => _parseScreenRequest(`<screen_request>${JSON.stringify(raw)}</screen_request>`)
    assert.equal(req({ sector: 'Technology', lens: 'quality-value' }).lens, 'quality-value')
    assert.equal(req({ sector: 'Technology', lens: 'conviction-weighted' }).lens, null)  // wrong axis
    assert.equal(req({ sector: 'Technology' }).lens, null)
})

// ── incoherent pairs ──────────────────────────────────────────────────────────

test('pairs that fight themselves are named, not silently built', () => {
    assert.match(incoherentCombo('risk-balanced', 'quality-value'), /refuses to say which name is best/)
    assert.ok(incoherentCombo('conviction-weighted', 'passive'))
    assert.equal(incoherentCombo('conviction-weighted', 'quality-value'), null)   // Buffett — coherent
    assert.equal(incoherentCombo('risk-balanced', 'passive'), null)               // All Weather — coherent
    assert.equal(incoherentCombo('risk-balanced', null), null)                    // half-set: nothing to clash
})

// ── the injected block ────────────────────────────────────────────────────────

test('with nothing chosen the block is the MENU Atlas picks from', () => {
    const s = buildSchoolSection(null)
    for (const k of [...SELECTION_SCHOOLS, ...ALLOCATION_SCHOOLS]) assert.ok(s.includes(k), `menu missing ${k}`)
    assert.match(s, /state which you chose and WHY/)
})

test('with both chosen the block is the RULE, not the menu', () => {
    const s = buildSchoolSection({ selection: 'income', allocation: 'risk-balanced' })
    assert.match(s, /SELECTION = `income`/)
    assert.match(s, /ALLOCATION = `risk-balanced`/)
    assert.match(s, /is the payout still covered\?/)          // the review question travels with it
    assert.ok(!s.includes('growth-durability'), 'a chosen axis must not still offer the menu')
})

test('a half-set mandate gets the rule for one axis and the menu for the other', () => {
    const s = buildSchoolSection({ selection: 'quality-value' })
    assert.match(s, /SELECTION = `quality-value`/)
    assert.match(s, /ALLOCATION \(how risk is spread\) is not set yet/)
})

test('the block always restates the trap: regime moves the weights, not the school', () => {
    for (const m of [null, { selection: 'income', allocation: 'risk-balanced' }]) {
        assert.match(buildSchoolSection(m), /never to the current market state/)
    }
})

test('an incoherent pair is flagged inside the block Atlas actually reads', () => {
    assert.match(buildSchoolSection({ selection: 'quality-value', allocation: 'risk-balanced' }), /FIGHT EACH OTHER/)
})

// ── the review must not retro-fit a school ────────────────────────────────────
// A book built before schools existed is reviewed against the thesis it actually has. Offering the
// menu mid-review would have Atlas adopt a stance the book was never built under — the same
// frozen-thesis break as switching schools on a regime signal, arriving by a quieter door.
test('review mode: no school set → no block at all, nothing to adopt', () => {
    assert.equal(buildSchoolSection(null, { menu: false }), null)
    assert.equal(buildSchoolSection({ objective: 'growth' }, { menu: false }), null)
})

test('review mode: a school that IS set still governs the re-read', () => {
    const s = buildSchoolSection({ selection: 'quality-value' }, { menu: false })
    assert.match(s, /has the moat eroded\?/)
    assert.ok(!s.includes('is not set yet'), 'review must never offer the menu')
})

// ── an edit turn must not silently re-rank ────────────────────────────────────
test('an edit that forgets the lens inherits it from the list being edited', () => {
    const prior = { thesis: 's', lens: 'income', candidates: [
        { ticker: 'KEEP', direction: 'long', thesis: 't', analysis: 'a', grounding: 'sourced',
            score: { quality: 70, valuation: 60, growth: 50, balance_sheet: 80 } },
    ] }
    const edited = { thesis: 's', direction: 'long', style: 'long term', candidates: [{ ticker: 'KEEP', keep: true }] }
    assert.equal(_normalizeScan(edited, prior, null, 'investing').lens, 'income')
})

// ── the industry hop ──────────────────────────────────────────────────────────
// A sector is a coarse pond — semis, software and IT services are different businesses. Argus
// narrowing it is screening mechanics and its job; Atlas naming one is a JUDGMENT, and judgment has
// to cross as a field. Buried in free-text constraints it is a hint Argus may or may not honour.
test('an industry view crosses the hop as its own field', () => {
    const req = raw => _parseScreenRequest(`<screen_request>${JSON.stringify(raw)}</screen_request>`)
    assert.equal(req({ sector: 'Technology', industry: 'Semiconductors' }).industry, 'Semiconductors')
})

test('no industry named → null, and Argus narrows the sector itself', () => {
    const req = raw => _parseScreenRequest(`<screen_request>${JSON.stringify(raw)}</screen_request>`)
    assert.equal(req({ sector: 'Technology' }).industry, null)
    assert.equal(req({ sector: 'Technology', industry: '   ' }).industry, null)
})
