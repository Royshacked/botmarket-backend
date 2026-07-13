import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isClosedIdeaFrozen } from '../../api/trade-ideas/tradeIdeas.service.js'

// A 'closed' idea is terminal: updateIdea must reject any status patch that would revert it.
// Guards the phantom-idea bug — dismissing a lingering entry-confirm card AFTER the position
// had already opened and closed reverted status→'waiting', leaving a mangled waiting-but-closed
// doc that reappeared in the list (which only hides 'closed'). See project_timestamp_ideas.

test('closed idea + a reverting status patch → frozen', () => {
    assert.equal(isClosedIdeaFrozen('closed', 'waiting'), true)
    assert.equal(isClosedIdeaFrozen('closed', 'looking'), true)
    assert.equal(isClosedIdeaFrozen('closed', 'hit'), true)
    assert.equal(isClosedIdeaFrozen('closed', 'long'), true)
})

test('closed idea with no status change (or status=closed) → not frozen (edit passes through)', () => {
    assert.equal(isClosedIdeaFrozen('closed', null), false)
    assert.equal(isClosedIdeaFrozen('closed', undefined), false)
    assert.equal(isClosedIdeaFrozen('closed', 'closed'), false)
})

test('non-closed ideas are never frozen by this guard', () => {
    for (const s of ['waiting', 'looking', 'resting', 'hit', 'long', 'short']) {
        assert.equal(isClosedIdeaFrozen(s, 'waiting'), false, s)
        assert.equal(isClosedIdeaFrozen(s, 'closed'), false, s)
    }
})
