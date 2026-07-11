import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _safeParseJsonArray, _isValidArticle } from '../../services/model.filter.service.js'

// The news relevance filter runs on Claude Haiku (Anthropic). These cover the
// provider-agnostic response handling — the part most exposed to a model swap,
// since Claude may fence JSON in ```json blocks or add a preamble sentence
// despite the "return ONLY a JSON array" instruction.

const ARTICLE = {
    category: 'markets',
    datetime: 1714760000,
    headline: 'Fed holds rates',
    summary: 'The Fed left rates unchanged.',
    url: 'https://example.com/a',
    sentiment: 'bearish',
    confidence: 0.8,
}

// ── _safeParseJsonArray ─────────────────────────────────────────────────
test('safeParseJsonArray: plain JSON array parses', () => {
    const out = _safeParseJsonArray(JSON.stringify([ARTICLE]))
    assert.equal(Array.isArray(out), true)
    assert.equal(out.length, 1)
    assert.equal(out[0].headline, 'Fed holds rates')
})

test('safeParseJsonArray: markdown-fenced ```json block is unwrapped', () => {
    const text = '```json\n' + JSON.stringify([ARTICLE]) + '\n```'
    const out = _safeParseJsonArray(text)
    assert.equal(Array.isArray(out), true)
    assert.equal(out.length, 1)
})

test('safeParseJsonArray: recovers an array embedded in preamble prose', () => {
    const text = `Here are the relevant articles:\n${JSON.stringify([ARTICLE])}\nHope that helps!`
    const out = _safeParseJsonArray(text)
    assert.equal(Array.isArray(out), true)
    assert.equal(out.length, 1)
    assert.equal(out[0].url, 'https://example.com/a')
})

test('safeParseJsonArray: unrecoverable text → null', () => {
    assert.equal(_safeParseJsonArray('no json here at all'), null)
    assert.equal(_safeParseJsonArray(''), null)
    assert.equal(_safeParseJsonArray(null), null)
})

// ── _isValidArticle ─────────────────────────────────────────────────────
test('isValidArticle: well-formed article passes unchanged', () => {
    const a = { ...ARTICLE }
    assert.equal(_isValidArticle(a), true)
    assert.equal(a.sentiment, 'bearish')
    assert.equal(a.confidence, 0.8)
})

test('isValidArticle: missing/empty headline or non-string fields rejected', () => {
    assert.equal(_isValidArticle({ ...ARTICLE, headline: '' }), false)
    assert.equal(_isValidArticle({ ...ARTICLE, headline: '   ' }), false)
    assert.equal(_isValidArticle({ ...ARTICLE, summary: 123 }), false)
    assert.equal(_isValidArticle(null), false)
})

test('isValidArticle: invalid sentiment is coerced to neutral', () => {
    const a = { ...ARTICLE, sentiment: 'very-bullish' }
    assert.equal(_isValidArticle(a), true)
    assert.equal(a.sentiment, 'neutral')
})

test('isValidArticle: out-of-range / non-numeric confidence is coerced to 0', () => {
    const hi = { ...ARTICLE, confidence: 5 }
    assert.equal(_isValidArticle(hi), true)
    assert.equal(hi.confidence, 0)

    const nan = { ...ARTICLE, confidence: 'high' }
    assert.equal(_isValidArticle(nan), true)
    assert.equal(nan.confidence, 0)
})
