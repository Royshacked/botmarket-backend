import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseTouchLiteral, parseCondition } from '../../monitoring/parsers/condition.parser.js'
import { touchLeaf } from '../../services/protectionPlan.service.js'

// The one condition shape this app writes itself is parsed by reading it, not by asking a model.
// `price touches <level>` is what protectionPlan.touchLeaf authors for every ticket stop, target and
// ladder rung; routeExits — the ORDER PATH — and the monitor both parse it back. Until 2026-09-16
// that parse was an LLM call, which meant: a network round-trip before an order could rest at the
// broker, an API key as a precondition for a stop to route natively, and eleven "unit" tests that
// only passed because a provider's stray dotenv.config() had loaded the real key into the runner.

test('the writer and the reader agree without a model in between', async () => {
    for (const level of [21500, 505.25, 0.0042, 1]) {
        const leaf   = touchLeaf(level)
        const parsed = await parseCondition(leaf.condition)
        assert.equal(parsed.value, level)
        assert.equal(parsed.subject, 'close', 'a price subject — the router refuses anything else')
        assert.equal(parsed.operator, 'eq')
        assert.equal(parsed.confirmation, 0)
    }
})

test('the literal is exact — anything the app did not author is not it', () => {
    assert.equal(parseTouchLiteral('price touches 100').value, 100)
    assert.equal(parseTouchLiteral('  PRICE  touches 100.5  ').value, 100.5, 'case and spacing are forgiven')
    assert.equal(parseTouchLiteral('price touches 100 for 3 candles'), null, 'a confirmation clause is a different sentence')
    assert.equal(parseTouchLiteral('price touches VWAP'), null, 'a non-numeric level is the model\'s to read')
    assert.equal(parseTouchLiteral('close above 100'), null)
    assert.equal(parseTouchLiteral(''), null)
    assert.equal(parseTouchLiteral(null), null)
})
