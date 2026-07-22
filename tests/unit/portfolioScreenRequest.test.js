import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _parseScreenRequest } from '../../services/portfolio.agent.service.js'

// Atlas P4c — the <screen_request> mandate hand-off to Argus's investing desk (pure).

test('parses a full mandate block', () => {
    const raw = `Routing the core sleeve to Argus.\n<screen_request>{ "sector": "Technology", "cap_band": "large", "style": "quality-compounder", "constraints": "net cash, ROIC > 15%", "note": "core-growth sleeve" }</screen_request>`
    assert.deepEqual(_parseScreenRequest(raw), {
        sector: 'Technology', style: 'quality-compounder', cap_band: 'large', constraints: 'net cash, ROIC > 15%', note: 'core-growth sleeve',
    })
})

test('needs at least a sector OR a style (else null)', () => {
    assert.equal(_parseScreenRequest('<screen_request>{ "cap_band": "large" }</screen_request>'), null)
    // style-only is enough
    assert.deepEqual(_parseScreenRequest('<screen_request>{ "style": "dividend" }</screen_request>'),
        { sector: null, style: 'dividend', cap_band: null, constraints: null, note: null })
    // sector-only is enough
    assert.equal(_parseScreenRequest('<screen_request>{ "sector": "Energy" }</screen_request>').sector, 'Energy')
})

test('no block → null; malformed JSON → null', () => {
    assert.equal(_parseScreenRequest('Just constructing, no routing.'), null)
    assert.equal(_parseScreenRequest(null), null)
    assert.equal(_parseScreenRequest('<screen_request>{ not json )</screen_request>'), null)
})
