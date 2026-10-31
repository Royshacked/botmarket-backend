import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _formatCoverage, _cleanScreenRequest, makeCoverageHandler } from '../../services/agents/portfolio.agent.service.js'

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
    // and the empty pool is an instruction to source the sleeve, not to stop
    assert.match(_formatCoverage([]), /Emit a <screen_request> for this sleeve/)
})

test('missing fields degrade gracefully (no PT / no gap / no thesis / unrated)', () => {
    const out = _formatCoverage([{ symbol: 'ABC' }])
    assert.match(out, /- ABC \[unrated\] · active/)   // no PT block, no thesis, default status
    assert.doesNotMatch(out, /our PT/)
})

// ── grouped by sleeve — a sleeve is a GICS sub-industry (atlas-industry-sleeves.md, 2026-10-19) ──────
const SUBS = {
    NVDA: { sub_code: '45301020', sub_industry: 'Semiconductors', sector: 'Information Technology' },
    AVGO: { sub_code: '45301020', sub_industry: 'Semiconductors', sector: 'Information Technology' },
    XOM:  { sub_code: '10102010', sub_industry: 'Integrated Oil & Gas', sector: 'Energy' },
}
test('names are grouped under their GICS sub-industry, one heading each', () => {
    const out = _formatCoverage([
        { symbol: 'NVDA', rating: 'buy',  sector: 'Technology' },
        { symbol: 'XOM',  rating: 'buy',  sector: 'Energy' },
        { symbol: 'AVGO', rating: 'hold', sector: 'Technology' },
    ], { subs: SUBS })
    const semis = out.indexOf('Semiconductors (45301020) [Information Technology]:')
    const oil   = out.indexOf('Integrated Oil & Gas (10102010) [Energy]:')
    assert.ok(semis > -1 && oil > -1, 'both industry headings present')
    assert.ok(semis < out.indexOf('NVDA') && out.indexOf('NVDA') < oil, 'NVDA sits under Semiconductors')
    assert.ok(oil < out.indexOf('XOM'))
    assert.equal(out.match(/^Semiconductors \(45301020\)/gm).length, 1, 'AVGO joins the same heading')
    assert.ok(out.indexOf('AVGO') < oil)
})

test('a name the GICS table does not know sits under its sector, marked, after the industries; no sector at all is last', () => {
    const out = _formatCoverage([
        { symbol: 'ABC' },
        { symbol: 'ZZZ', sector: 'Energy' },
        { symbol: 'XOM', sector: 'Energy' },
    ], { subs: SUBS })
    assert.match(out, /Energy — industry not in the house's GICS table/)
    assert.match(out, /Unclassified \(no industry or sector recorded/)
    assert.ok(out.indexOf('Integrated Oil & Gas') < out.indexOf('Energy — industry not'), 'industries first')
    assert.ok(out.indexOf('Energy — industry not') < out.indexOf('Unclassified'), 'the unclassified bucket comes last')
})

test('an empty industry read names the sleeve to source, by its code', () => {
    const out = _formatCoverage([], { industry: { code: '45301020', name: 'Semiconductors' } })
    assert.match(out, /No house coverage yet in Semiconductors \(45301020\)/)
    assert.match(out, /"industry_code": "45301020"/)
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
test('a PARTIAL read still says what to do about a sleeve with no heading — an absence is not on the page', () => {
    // The reported behaviour: Atlas built entirely from existing coverage and never screened. The empty case ends in
    // a hard instruction; the partial one has to as well, or two covered industries read as "you have what you need".
    // (It listed the uncovered SECTORS until 2026-10-19; a sleeve is an industry now, and 163 of them are no list.)
    const out = _formatCoverage([{ symbol: 'NVDA', rating: 'buy', status: 'active' }], { subs: SUBS })
    assert.match(out, /no heading here has nothing researched behind it yet: emit a <screen_request> for it \(its industry_code \+ lens\)/)
    // No research queue for one name (2026-10-31): an uncovered ticker is said to be uncovered, Prometheus's to cover.
    assert.doesNotMatch(out, /<coverage_request>/)
    assert.match(out, /not covered — Prometheus covers names at his own desk/)
    // The failure worth naming outright: bending the architecture to fit what happens to be researched.
    assert.match(out, /shrink the sleeve to fit what happens to be covered/)
    assert.match(out, /neighbouring industry's names/)
})

// ── get_coverage by industry ─────────────────────────────────────────────────
test('get_coverage with `industry`: only that sub-industry\'s names, not narrowed by sector; unknown industry said', async () => {
    let asked = null
    const handler = makeCoverageHandler({
        coverage: async (q) => { asked = q; return [{ symbol: 'NVDA', rating: 'buy' }, { symbol: 'XOM', rating: 'buy' }, { symbol: 'AVGO', rating: 'hold' }] },
        subsOf:   async () => SUBS,
        readSub:  async (k) => (k === 'Semiconductors' || k === '45301020' ? { sub: { code: '45301020', name: 'Semiconductors' } } : null),
    })
    const out = await handler({ industry: 'Semiconductors', sector: 'Technology', school: 'quality-value' })
    assert.deepEqual(asked, { status: 'active', sector: null, school: 'quality-value' })
    assert.match(out, /NVDA/)
    assert.match(out, /AVGO/)
    assert.doesNotMatch(out, /XOM/)
    assert.match(await handler({ industry: 'Basket Weaving' }), /No GICS sub-industry "Basket Weaving"/)
    // Without an industry it reads as before, by sector — grouped by industry all the same.
    await handler({ sector: 'Energy' })
    assert.equal(asked.sector, 'Energy')
})

test('a GICS table that cannot be read still answers — by sector', async () => {
    const handler = makeCoverageHandler({ coverage: async () => [{ symbol: 'XOM', sector: 'Energy' }], subsOf: async () => { throw new Error('down') }, readSub: async () => null })
    assert.match(await handler({}), /Energy — industry not in the house's GICS table/)
})

// ── <screen_request> carries the sleeve's GICS code ──────────────────────────
test('a screen request with an 8-digit industry_code is enough on its own; anything else there is no code', () => {
    assert.equal(_cleanScreenRequest({ industry_code: '45301020', lens: 'quality-value' }).industry_code, '45301020')
    assert.equal(_cleanScreenRequest({ industry_code: 'Semiconductors', sector: 'Technology' }).industry_code, null)
    assert.equal(_cleanScreenRequest({ industry_code: 'nope' }), null)
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
