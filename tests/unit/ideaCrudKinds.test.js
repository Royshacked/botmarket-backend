import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDEA_CRUD_KINDS, _ideaCrudKind } from '../../api/trade-ideas/tradeIdeas.service.js'

// /api/trade-ideas list / get / delete reach ideas and portfolio legs, never a setup (2026-11-10).
// Before, the crud had no kind filter, so GET returned a setup as an idea and DELETE removed one
// past setups.service's own guards. The filter is `{ kind: { $in: IDEA_CRUD_KINDS } }`; Mongo's
// `$in` with `null` also matches a MISSING field, which is how a pre-`kind` legacy idea stays in.
// `matches` mirrors those two Mongo rules so the cases read as documents, not as an array.

const matches = (doc) => IDEA_CRUD_KINDS.includes(doc.kind ?? null)

test('an idea and a portfolio leg are reachable', () => {
    assert.equal(matches({ kind: 'idea' }), true)
    assert.equal(matches({ kind: 'portfolio_item', portfolioId: 'p1' }), true)
})

test('a legacy doc with no kind is reachable — it reads as an idea', () => {
    assert.equal(matches({}), true)
})

test('a setup is NOT reachable — Mentor owns its read and delete', () => {
    assert.equal(matches({ kind: 'setup' }), false)
})

test('a deleted kind (call) is not reachable either', () => {
    assert.equal(matches({ kind: 'call' }), false)
})

// The cases above test the constant; this one tests the WIRING. Without it, deleting the crud's `kind` line left every
// test green while setups came back through GET/DELETE (code review 2026-11-10).
test('the trade-ideas crud is built with exactly this scope', () => {
    assert.deepEqual(_ideaCrudKind, { $in: IDEA_CRUD_KINDS })
})

test('the list is frozen', () => {
    assert.ok(Object.isFrozen(IDEA_CRUD_KINDS))
})
