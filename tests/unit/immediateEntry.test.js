import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldMarketEnterOnUpdate, resolveImmediate, hasEntryConditions } from '../../api/trade-ideas/tradeIdeas.service.js'
import { resolveConditionTree } from '../../services/conditionTree.service.js'

// "Go in at market now" while editing a pending idea: updateIdea flips it to an
// immediate market entry ONLY when an explicit immediate flag lands on a still-
// pending (waiting/looking) idea. The bug hunt flagged that a plain "Update idea"
// must never place an order, and a live/closed idea must never be market-entered —
// these pin exactly that guard.

test('immediate flag on a waiting idea → market entry', () => {
    assert.equal(shouldMarketEnterOnUpdate({ immediate: true }, 'waiting'), true)
})

test('immediate flag on a looking idea → market entry', () => {
    assert.equal(shouldMarketEnterOnUpdate({ immediate: true }, 'looking'), true)
})

test('no immediate flag → never a market entry (plain update)', () => {
    assert.equal(shouldMarketEnterOnUpdate({}, 'waiting'), false)
    assert.equal(shouldMarketEnterOnUpdate({ immediate: false }, 'waiting'), false)
    assert.equal(shouldMarketEnterOnUpdate({ status: 'waiting' }, 'waiting'), false)
})

test('in-position / resting / hit / closed ideas are never market-entered', () => {
    for (const status of ['long', 'short', 'resting', 'hit', 'closed']) {
        assert.equal(shouldMarketEnterOnUpdate({ immediate: true }, status), false, status)
    }
})

test('a truthy-but-not-true immediate value does not trigger (strict === true)', () => {
    assert.equal(shouldMarketEnterOnUpdate({ immediate: 1 }, 'waiting'), false)
    assert.equal(shouldMarketEnterOnUpdate({ immediate: 'true' }, 'waiting'), false)
})

test('null/undefined patch is safe', () => {
    assert.equal(shouldMarketEnterOnUpdate(null, 'waiting'), false)
    assert.equal(shouldMarketEnterOnUpdate(undefined, 'waiting'), false)
})

// saveIdea's immediate guard: `immediate:true` only survives when the entry tree is
// empty. A gating entry condition — including a scheduled TIME leaf — neutralizes it, so
// a timestamp idea is saved as a monitored (waiting) idea instead of firing at save time.
// This is the fix for "timestamp idea doesn't go in on time" (project_timestamp_ideas).
const timeTree  = resolveConditionTree({ condition: 'on/after 16:40 ET', type: 'time', after: '2026-07-13T20:40:00Z', before: null, timeframe: null }, null, 'AND')
const priceTree = resolveConditionTree({ condition: 'breaks above 100 on close', type: 'structured', timeframe: '15min' }, null, 'AND')

test('hasEntryConditions: time leaf counts as a real entry condition', () => {
    assert.equal(hasEntryConditions(timeTree), true)
    assert.equal(hasEntryConditions(priceTree), true)
    assert.equal(hasEntryConditions(null), false)                 // truly no conditions
    assert.equal(hasEntryConditions(resolveConditionTree(null, [], 'AND')), false)
})

test('resolveImmediate: a TIME entry leaf neutralizes immediate → monitored', () => {
    assert.equal(resolveImmediate(true, timeTree), false)         // the bug: was firing at save time
})

test('resolveImmediate: any gating entry leaf neutralizes immediate', () => {
    assert.equal(resolveImmediate(true, priceTree), false)
})

test('resolveImmediate: naked immediate (no entry conditions) stays immediate', () => {
    // Protects the legit immediate paths — Kairos handoff + portfolio ideas are naked
    // market entries with no entry_condition_tree.
    assert.equal(resolveImmediate(true, null), true)
})

test('resolveImmediate: no/false/non-strict flag is never immediate', () => {
    assert.equal(resolveImmediate(false, null), false)
    assert.equal(resolveImmediate(undefined, null), false)
    assert.equal(resolveImmediate(1, null), false)
    assert.equal(resolveImmediate('true', null), false)
})
