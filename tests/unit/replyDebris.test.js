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

// A web citation in the model's markup (gpt-6-luna, 2026-11-05): Mentor's reply read "tentative. citeturn0finance0".
test('a citation marker goes, whole or bare, and the sentence around it closes up', () => {
    const MARK = '\ue200cite\ue202turn0finance0\ue201'
    assert.equal(cleanReply(`The long case is tentative. ${MARK}\n\nApple beat.`), 'The long case is tentative.\n\nApple beat.')
    assert.equal(dropDebris(`It fell ${MARK}.`), 'It fell.')
    assert.equal(dropDebris(`It fell ${MARK} on the news.`), 'It fell on the news.')
    assert.equal(dropDebris('It fell citeturn0news1turn2search3.'), 'It fell.')
    assert.equal(dropDebris('It fell \ue202 hard.'), 'It fell hard.')
    for (const keep of ['Cite the filing.', 'They cite turn 0 of the plan.', 'Excite turn1a.'])
        assert.equal(dropDebris(keep), keep)
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
