import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanReply, dropDebris } from '../../services/agentUtils.js'

// A reasoning model's channel debris in a settled reply (gpt-6-luna, 2026-10-18): Axl answered
// "X\n\n(no final)\n\nX" — the marker and the answer twice, in one reply, stored and shown.

const X = 'Mentor will pressure-test your NVDA plan and work it as a paper setup.'

test('the marker line goes, and the repeated answer with it', () => {
    assert.equal(cleanReply(`${X}\n\n(no final)\n\n${X}<route>assist NVDA</route>`), X)
    assert.equal(dropDebris(`${X}\n(final)\n`), X)
    assert.equal(dropDebris(`${X}\n\n(No Final Answer)`), X)
})

test('prose is otherwise untouched — a marker inside a sentence, or a repeat that is not adjacent, stays', () => {
    const p = 'The (no final) wording is theirs.'
    assert.equal(dropDebris(p), p)
    assert.equal(dropDebris('A\n\nB\n\nA'), 'A\n\nB\n\nA')
    assert.equal(dropDebris('- one\n- two\n\nNext.'), '- one\n- two\n\nNext.')
})
