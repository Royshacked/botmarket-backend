import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSuggestions, makeSuggestionCapture, MAX_SUGGESTIONS, SUGGEST_TAG } from '../../services/suggestions.service.js'
import { ALL_EMIT_TAGS } from '../../services/llmStream.util.js'

// The shared pipe for follow-up chips. It has no opinion about CONTENT — what to suggest is each
// agent's judgment, authored in its own prompt. What it guarantees is the wire format, so the
// client renders one thing however many agents start emitting the tag.

test('the tag is REGISTERED — otherwise it prints at the user instead of being captured', () => {
    // The footgun this list exists for: buildTagCaptures suppresses everything in ALL_EMIT_TAGS and
    // nothing else, so an emit tag missing from it leaks raw into the chat. `<open>` shipped that
    // way once. Registered before Axl started emitting it, deliberately.
    assert.ok(ALL_EMIT_TAGS.includes(SUGGEST_TAG))
})

test('captures are cleaned, in order', () => {
    assert.deepEqual(
        normalizeSuggestions(['Why is MU carrying the week?', '  Run a portfolio review  ']),
        ['Why is MU carrying the week?', 'Run a portfolio review'],
    )
})

test('the decoration a model adds even when asked not to is stripped', () => {
    assert.deepEqual(
        normalizeSuggestions(['1. Why is MU up?', '- Run a review', '• Show my queue', '"Quoted one"']),
        ['Why is MU up?', 'Run a review', 'Show my queue'],   // capped at three
    )
})

test('newlines inside a chip collapse — a chip is one line by definition', () => {
    assert.deepEqual(normalizeSuggestions(['Why is\n  MU   down?']), ['Why is MU down?'])
})

test('THREE, hard — the cap is a guarantee, not a request in a prompt', () => {
    const many = ['one', 'two', 'three', 'four', 'five']
    assert.equal(normalizeSuggestions(many).length, MAX_SUGGESTIONS)
    assert.deepEqual(normalizeSuggestions(many), ['one', 'two', 'three'])
})

test('duplicates collapse, case-insensitively', () => {
    // Two chips that differ only in capitalisation are one chip rendered twice, which reads as a bug.
    assert.deepEqual(normalizeSuggestions(['Run a review', 'run a review', 'Show my queue']),
        ['Run a review', 'Show my queue'])
})

test('an over-long suggestion is DROPPED, not truncated', () => {
    // Truncating a question makes it a different question — and a chip that trails off mid-sentence
    // is worse than one fewer chip.
    const long = 'Why '.repeat(40)
    assert.deepEqual(normalizeSuggestions([long, 'Short one']), ['Short one'])
})

test('empty, blank and junk captures vanish rather than rendering a blank chip', () => {
    assert.deepEqual(normalizeSuggestions(['', '   ', null, undefined, '-', 'Real one']), ['Real one'])
    assert.deepEqual(normalizeSuggestions([]), [])
    assert.deepEqual(normalizeSuggestions(), [])
})

test('the capture helper is the whole wiring an agent needs', () => {
    const suggest = makeSuggestionCapture()
    assert.deepEqual(suggest.result(), [], 'a turn that suggested nothing is a normal turn')

    suggest.onCapture('Why is MU down?')
    suggest.onCapture('Why is MU down?')   // the model repeating itself
    suggest.onCapture('Run a review')
    assert.deepEqual(suggest.result(), ['Why is MU down?', 'Run a review'])
})
