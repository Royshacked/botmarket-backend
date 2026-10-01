import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transcriptionLanguage, DEFAULT_LANGUAGE } from '../../api/transcribe/transcribe.util.js'

// Whisper left to guess heard accented English as four other languages in one build (Marce,
// 2026-10-01). The language is told, never detected.

test('English unless told otherwise — detection is never left to Whisper', () => {
    assert.equal(DEFAULT_LANGUAGE, 'en')
    assert.equal(transcriptionLanguage(undefined), 'en')
    assert.equal(transcriptionLanguage(''), 'en')
})

test('a client may name the language as a two-letter code; anything else is ignored, not passed on', () => {
    assert.equal(transcriptionLanguage('he'), 'he')
    assert.equal(transcriptionLanguage(' ES '), 'es')
    assert.equal(transcriptionLanguage('english'), 'en')
    assert.equal(transcriptionLanguage('en-US'), 'en')
    assert.equal(transcriptionLanguage(['he']), 'he')
    assert.equal(transcriptionLanguage('x"; drop'), 'en')
})
