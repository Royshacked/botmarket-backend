import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _parseScreenRequests } from '../../services/agents/portfolio.agent.service.js'

// A turn routes EVERY sleeve it decided, so the plural is the real parser. These cases are about
// what ONE block parses to, so they take the first of the list rather than keeping a second
// exported name in step with it.
const _first = raw => _parseScreenRequests(raw)[0] ?? null

// Atlas P4c — the <screen_request> mandate hand-off to Argus's investing desk (pure).

test('parses a full mandate block', () => {
    const raw = `Routing the core sleeve to Argus.\n<screen_request>{ "sector": "Technology", "cap_band": "large", "style": "quality-compounder", "constraints": "net cash, ROIC > 15%", "note": "core-growth sleeve" }</screen_request>`
    assert.deepEqual(_first(raw), {
        sector: 'Technology', style: 'quality-compounder', cap_band: 'large', constraints: 'net cash, ROIC > 15%', note: 'core-growth sleeve',
        lens: null,       // this block predates the schools — no selection school stated, so none crosses
        industry: null,   // no industry view held → Argus narrows the sector itself
    })
})

test('needs at least a sector OR a style (else null)', () => {
    assert.equal(_first('<screen_request>{ "cap_band": "large" }</screen_request>'), null)
    // style-only is enough
    assert.deepEqual(_first('<screen_request>{ "style": "dividend" }</screen_request>'),
        { sector: null, style: 'dividend', cap_band: null, constraints: null, note: null, lens: null, industry: null })
    // sector-only is enough
    assert.equal(_first('<screen_request>{ "sector": "Energy" }</screen_request>').sector, 'Energy')
})

test('no block → null; malformed JSON → null', () => {
    assert.equal(_first('Just constructing, no routing.'), null)
    assert.equal(_first(null), null)
    assert.equal(_first('<screen_request>{ not json )</screen_request>'), null)
})

// ── every sleeve, one turn ────────────────────────────────────────────────────
// A book has three or four sleeves. parseEmitBlock took the FIRST block and dropped the rest with
// nothing logged, so Atlas could only ever route one — and the user walked the whole
// Argus → Analyst → Atlas loop again for every sector.
test('all sleeves emitted in one turn are parsed, in order', () => {
    const raw = `Routing three sleeves.
<screen_request>{ "sector": "Technology", "lens": "quality-value" }</screen_request>
<screen_request>{ "sector": "Health Care", "industry": "Biotechnology" }</screen_request>
<screen_request>{ "sector": "Energy", "style": "dividend" }</screen_request>`
    const out = _parseScreenRequests(raw)
    assert.deepEqual(out.map(r => r.sector), ['Technology', 'Health Care', 'Energy'])
    assert.equal(out[0].lens, 'quality-value')
    assert.equal(out[1].industry, 'Biotechnology')
})

test('one malformed sleeve does not discard the good ones beside it', () => {
    const raw = `<screen_request>{ "sector": "Technology" }</screen_request>
<screen_request>{ not json )</screen_request>
<screen_request>{ "sector": "Energy" }</screen_request>`
    assert.deepEqual(_parseScreenRequests(raw).map(r => r.sector), ['Technology', 'Energy'])
})

test('a sleeve with neither sector nor style is dropped, not passed on empty', () => {
    const raw = `<screen_request>{ "cap_band": "large" }</screen_request>
<screen_request>{ "sector": "Energy" }</screen_request>`
    assert.deepEqual(_parseScreenRequests(raw).map(r => r.sector), ['Energy'])
})

test('the singular parser still answers with the first, for callers that want one', () => {
    const raw = `<screen_request>{ "sector": "Technology" }</screen_request>
<screen_request>{ "sector": "Energy" }</screen_request>`
    assert.equal(_first(raw).sector, 'Technology')
    assert.equal(_first('nothing here'), null)
    assert.deepEqual(_parseScreenRequests('nothing here'), [])
})
