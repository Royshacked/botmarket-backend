import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _formatCoverage, _parseCoverageRequest } from '../../services/agents/portfolio.agent.service.js'

// Atlas P4d — get_coverage read (Analyst→Atlas pull): render coverage for construction (pure).

test('formats each covered name with rating, our PT, the gap vs Street, status, thesis', () => {
    const out = _formatCoverage([
        { symbol: 'NVDA', rating: 'buy', price_target: { value: 200 }, gap: { our_pt: 200, consensus_pt: 180, pct: 11.1 }, status: 'active', thesis: 'AI data-center compounder' },
        { symbol: 'MSFT', rating: 'hold', price_target: { value: 420 }, gap: { our_pt: 420, consensus_pt: 428, pct: -1.9 }, status: 'active', thesis: 'fairly valued' },
    ])
    assert.match(out, /NVDA \[buy\] our PT 200 \(\+11\.1% vs Street 180\) · active — AI data-center compounder/)
    assert.match(out, /MSFT \[hold\] our PT 420 \(-1\.9% vs Street 428\)/)
})

test('empty coverage → a clear "nothing researched" read', () => {
    assert.match(_formatCoverage([]), /No house coverage yet/)
    assert.match(_formatCoverage(null), /No house coverage yet/)
})

test('missing fields degrade gracefully (no PT / no gap / no thesis / unrated)', () => {
    const out = _formatCoverage([{ symbol: 'ABC' }])
    assert.match(out, /- ABC \[unrated\] · active/)   // no PT block, no thesis, default status
    assert.doesNotMatch(out, /our PT/)
})

// ── grouped by sleeve ─────────────────────────────────────────────────────────
// Atlas builds sector sleeves, and read as a flat list it had to guess which sleeve each researched
// name belonged to — from the ticker. The Analyst records the sector; group on it.
test('names are grouped under the sector the Analyst researched them for', () => {
    const out = _formatCoverage([
        { symbol: 'NVDA', rating: 'buy',  sector: 'Technology' },
        { symbol: 'XOM',  rating: 'buy',  sector: 'Energy' },
        { symbol: 'MSFT', rating: 'hold', sector: 'Technology' },
    ])
    const tech = out.indexOf('Technology:')
    const nrgy = out.indexOf('Energy:')
    assert.ok(tech > -1 && nrgy > -1, 'both sector headings present')
    assert.ok(tech < out.indexOf('NVDA') && out.indexOf('NVDA') < nrgy, 'NVDA sits under Technology')
    assert.ok(nrgy < out.indexOf('XOM'), 'XOM sits under Energy')
    // MSFT joins the existing Technology block rather than opening a second one
    assert.equal(out.match(/^Technology:$/gm).length, 1)
    assert.ok(out.indexOf('MSFT') < nrgy)
})

test('a sector-less name gets its own bucket, always last', () => {
    const out = _formatCoverage([
        { symbol: 'ABC' },                              // no sector
        { symbol: 'XOM', sector: 'Energy' },
    ])
    assert.match(out, /Unclassified \(no sector recorded/)
    assert.ok(out.indexOf('Energy:') < out.indexOf('Unclassified'), 'the unclassified bucket comes last')
})

test('a sleeve with nothing researched is not fillable from another sector', () => {
    // The heading rule is what stops Atlas placing a tech name into the energy sleeve because the
    // list happened to be flat. It has to be stated, not implied by the layout.
    const out = _formatCoverage([{ symbol: 'NVDA', sector: 'Technology' }])
    assert.match(out, /no heading here has nothing researched behind it yet/)
})

test('a long thesis is truncated', () => {
    const long = 'x'.repeat(300)
    const out = _formatCoverage([{ symbol: 'ABC', rating: 'buy', thesis: long }])
    assert.ok(out.includes('…'))
    // Measure the NAME's line, not the whole read — the header is fixed prose and grows with the
    // instructions; only the per-name thesis is what truncation is protecting the context from.
    const row = out.split('\n').find(l => l.startsWith('- ABC'))
    assert.ok(row.length < 200, `thesis row not truncated: ${row.length} chars`)
})

// ── the gap Atlas could not see ─────────────────────────────────────────────
test('names the sectors coverage has NOTHING in — an absence is not on the page', () => {
    // The reported behaviour: Atlas built entirely from existing coverage and never screened. Using
    // coverage first is correct; NOT screening is correct only if every targeted sleeve had a name
    // behind it. The empty case already ended in a hard instruction, but the PARTIAL case had none —
    // so a book covered in two sectors read as "you have what you need".
    const out = _formatCoverage([{ symbol: 'NVDA', sector: 'Technology', rating: 'buy', status: 'active' }])
    assert.match(out, /NO COVERAGE AT ALL IN:/)
    assert.match(out, /Healthcare/)
    assert.match(out, /Utilities/)
    assert.match(out, /emit a <coverage_request>/)
    // A covered sector must not be reported as a gap.
    assert.doesNotMatch(out.split('NO COVERAGE AT ALL IN:')[1], /Technology/)
    // The failure worth naming outright: bending the architecture to fit what happens to be researched.
    assert.match(out, /shrink the sleeve to fit what happens to be covered/)
})

// ── schools display ───────────────────────────────────────────────────────────
test('schools are shown on the per-name line when tagged', () => {
    const out = _formatCoverage([
        { symbol: 'NVDA', rating: 'buy', schools: ['quality-value', 'growth-durability'], status: 'active' },
        { symbol: 'XOM',  rating: 'buy', schools: [], status: 'active' },
        { symbol: 'JNJ',  rating: 'hold', status: 'active' },   // no schools field
    ])
    assert.match(out, /NVDA.*schools: quality-value, growth-durability/)
    assert.doesNotMatch(out, /XOM.*schools/)        // empty array → no schools label
    assert.doesNotMatch(out, /JNJ.*schools/)        // undefined → no schools label
})

// ── <coverage_request> parsing ────────────────────────────────────────────────
test('parseCoverageRequest: parses symbol and optional reason', () => {
    const raw = `I cannot find AAPL in coverage.\n<coverage_request>{"symbol": "AAPL", "reason": "user wants to add this"}</coverage_request>`
    const r = _parseCoverageRequest(raw)
    assert.equal(r.symbol, 'AAPL')
    assert.equal(r.reason, 'user wants to add this')
})

test('parseCoverageRequest: uppercases symbol', () => {
    const r = _parseCoverageRequest('<coverage_request>{"symbol": "msft"}</coverage_request>')
    assert.equal(r?.symbol, 'MSFT')
})

test('parseCoverageRequest: missing symbol → null', () => {
    assert.equal(_parseCoverageRequest('<coverage_request>{"reason": "no symbol"}</coverage_request>'), null)
    assert.equal(_parseCoverageRequest('<coverage_request>{}</coverage_request>'), null)
})

test('parseCoverageRequest: no block → null; malformed JSON → null', () => {
    assert.equal(_parseCoverageRequest('no coverage request here'), null)
    assert.equal(_parseCoverageRequest(null), null)
    assert.equal(_parseCoverageRequest('<coverage_request>{ bad json )</coverage_request>'), null)
})

test('every sector covered → no gap line at all', async () => {
    const { SECTORS } = await import('../../services/entity/vocabulary.js')
    const out = _formatCoverage(SECTORS.map((s, i) => ({ symbol: `T${i}`, sector: s, rating: 'buy', status: 'active' })))
    assert.doesNotMatch(out, /NO COVERAGE AT ALL IN/)
})

test('with NOTHING covered the hard stop still wins — it must not soften into a gap list', () => {
    const out = _formatCoverage([])
    assert.match(out, /No house coverage yet/)
    assert.doesNotMatch(out, /NO COVERAGE AT ALL IN/)
})
