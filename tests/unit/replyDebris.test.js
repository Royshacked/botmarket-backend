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

// A stray token (gpt-6-luna, 2026-10-19): Argus's reply opened "<չ>\nThe best fit for a swing long is MSI…".
test('a stray bracketed token goes — at the start, on its own line, or between words — and only that shape', () => {
    const MSI = 'The best fit for a swing long is MSI.'
    assert.equal(cleanReply(`<չ>\n${MSI}`), MSI)
    assert.equal(cleanReply(`<չ>${MSI}`), MSI)
    assert.equal(dropDebris(`Pick: MSI <ա> over FCX.`), 'Pick: MSI over FCX.')
    assert.equal(dropDebris(`Pick:<ա>MSI.`), 'Pick: MSI.')
    assert.equal(cleanReply(`${MSI}<|end|>`), MSI)
    assert.equal(cleanReply(`<|channel|>${MSI}`), MSI)
    // Never a real shape: a comparison, an arrow, an ASCII tag left in prose, a ticker in brackets.
    for (const keep of ['RSI <30 and > 70 is the band.', 'Rotation: XLE <-> XLK.', 'Use <b>bold</b> sparingly.', 'Long <NVDA> into earnings.'])
        assert.equal(dropDebris(keep), keep)
})
