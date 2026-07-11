import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    newThreadId, isSubstantive, computeExpiry, draftsToEvict, deriveTitle,
    DRAFT_TTL_MS, DRAFT_CAP,
} from '../../services/thread.util.js'

test('newThreadId: prefixed, unique-ish', () => {
    const a = newThreadId()
    const b = newThreadId()
    assert.match(a, /^thr_\d+_[a-z0-9]+$/)
    assert.notEqual(a, b)
})

test('isSubstantive: artifact is always substantive', () => {
    assert.equal(isSubstantive({ agent: 'idea', phase: 1, hasArtifact: true }), true)
    assert.equal(isSubstantive({ agent: 'portfolio', hasArtifact: true }), true)
})

test('isSubstantive: nucleus / gathering (phase < 2, no signal) is NOT saved', () => {
    assert.equal(isSubstantive({ agent: 'idea', phase: 1 }), false)
    assert.equal(isSubstantive({ agent: 'scanner', phase: 1 }), false)
    assert.equal(isSubstantive({ agent: 'portfolio', phase: 1 }), false)
    assert.equal(isSubstantive({ agent: 'idea' }), false)           // no phase at all
})

test('isSubstantive: past nucleus (phase >= 2) is saved', () => {
    assert.equal(isSubstantive({ agent: 'idea', phase: 2 }), true)
    assert.equal(isSubstantive({ agent: 'scanner', phase: 3 }), true)
})

test('isSubstantive: kairos rides the generic phase floor (>= 2 saved, phase 1 not)', () => {
    assert.equal(isSubstantive({ agent: 'kairos', phase: 1 }), false)   // Classify step — not yet
    assert.equal(isSubstantive({ agent: 'kairos', phase: 2 }), true)    // past nucleus (mapping zones)
    assert.equal(isSubstantive({ agent: 'kairos', hasArtifact: true }), true)
})

test('isSubstantive: axl is always substantive (no phases / no artifact)', () => {
    assert.equal(isSubstantive({ agent: 'axl' }), true)
    assert.equal(isSubstantive({ agent: 'axl', phase: null }), true)
    assert.equal(isSubstantive({ agent: 'axl', phase: 1 }), true)
})

test('isSubstantive: portfolio mandate-ready is saved even at phase 1', () => {
    assert.equal(isSubstantive({ agent: 'portfolio', phase: 1, mandateReady: true }), true)
    // mandateReady is a portfolio-only signal — it does not lift other agents
    assert.equal(isSubstantive({ agent: 'idea', phase: 1, mandateReady: true }), false)
})

test('computeExpiry: draft gets a future Date, linked gets null', () => {
    const now = 1_000_000
    const exp = computeExpiry('draft', now, DRAFT_TTL_MS)
    assert.ok(exp instanceof Date)
    assert.equal(exp.getTime(), now + DRAFT_TTL_MS)
    assert.equal(computeExpiry('linked', now), null)
})

test('draftsToEvict: under cap evicts nothing', () => {
    const drafts = [{ threadId: 'a', updatedAt: 1 }, { threadId: 'b', updatedAt: 2 }]
    assert.deepEqual(draftsToEvict(drafts, 5, 'b'), [])
})

test('draftsToEvict: keeps newest (cap-1) others + keepId, evicts the oldest', () => {
    const drafts = [
        { threadId: 'old',  updatedAt: 1 },
        { threadId: 'mid',  updatedAt: 2 },
        { threadId: 'new',  updatedAt: 3 },
        { threadId: 'keep', updatedAt: 4 },
    ]
    // cap 2 → keep 'keep' + 1 newest other ('new'); evict 'mid' and 'old'
    assert.deepEqual(draftsToEvict(drafts, 2, 'keep').sort(), ['mid', 'old'])
})

test('draftsToEvict: a brand-new keepId not in the list still counts as a slot', () => {
    const drafts = [
        { threadId: 'a', updatedAt: 1 },
        { threadId: 'b', updatedAt: 2 },
    ]
    // cap 2, keepId 'c' is new → keep 'c' + newest other ('b'); evict 'a'
    assert.deepEqual(draftsToEvict(drafts, 2, 'c'), ['a'])
})

test('draftsToEvict: never evicts keepId', () => {
    const drafts = [{ threadId: 'keep', updatedAt: 1 }, { threadId: 'x', updatedAt: 9 }]
    assert.ok(!draftsToEvict(drafts, 1, 'keep').includes('keep'))
})

test('deriveTitle: artifact name wins', () => {
    assert.equal(deriveTitle({ artifactName: 'Tech Growth Book', messages: [{ role: 'user', content: 'hi' }] }), 'Tech Growth Book')
})

test('deriveTitle: falls back to first user message, then Untitled', () => {
    assert.equal(deriveTitle({ messages: [{ role: 'assistant', content: 'yo' }, { role: 'user', content: 'buy NVDA?' }] }), 'buy NVDA?')
    assert.equal(deriveTitle({ messages: [] }), 'Untitled')
    assert.equal(deriveTitle({}), 'Untitled')
})

test('DRAFT_CAP is a sane positive bound', () => {
    assert.ok(Number.isInteger(DRAFT_CAP) && DRAFT_CAP > 0)
})
