import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _parseAnalystResponse } from '../../services/analyst.agent.service.js'

// Analyst P3 — <coverage> extraction from the streamed research turn (pure).

test('parse: a valid <coverage> block → draft with uppercased symbol; reply strips block + phase', () => {
    const raw = `<phase>6</phase>\nHere's my pitch on Nvidia.\n<coverage>{ "symbol": "nvda", "rating": "buy", "thesis": "variant view" }</coverage>`
    const { reply, coverage } = _parseAnalystResponse(raw)
    assert.equal(coverage.symbol, 'NVDA')       // uppercased
    assert.equal(coverage.rating, 'buy')
    assert.equal(coverage.thesis, 'variant view')
    assert.match(reply, /Here's my pitch on Nvidia\./)
    assert.doesNotMatch(reply, /coverage|phase|variant view/)   // tags + block suppressed
})

test('parse: a NO-EDGE turn (no block) → coverage null, reply is the prose', () => {
    const raw = `<phase>5</phase>\nOn the work, my number lands in line with the Street — no edge here. Passing.`
    const { reply, coverage } = _parseAnalystResponse(raw)
    assert.equal(coverage, null)
    assert.match(reply, /no edge here\. Passing\./)
})

test('parse: malformed JSON → coverage null (does not throw)', () => {
    const { coverage } = _parseAnalystResponse('<coverage>{ not json )</coverage>')
    assert.equal(coverage, null)
})

test('parse: a block missing a symbol → null (a draft needs a name)', () => {
    assert.equal(_parseAnalystResponse('<coverage>{ "rating": "buy" }</coverage>').coverage, null)
    assert.equal(_parseAnalystResponse('<coverage>{ "symbol": "  " }</coverage>').coverage, null)
})

test('parse: an array payload → null (not a coverage object)', () => {
    assert.equal(_parseAnalystResponse('<coverage>[1,2,3]</coverage>').coverage, null)
})

test('parse: no coverage tag at all → { reply, coverage:null }', () => {
    const { reply, coverage } = _parseAnalystResponse('Just discussing the name, no pitch yet.')
    assert.equal(coverage, null)
    assert.equal(reply, 'Just discussing the name, no pitch yet.')
})
