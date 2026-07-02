import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldMarketEnterOnUpdate } from '../../api/trade-ideas/tradeIdeas.service.js'

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
