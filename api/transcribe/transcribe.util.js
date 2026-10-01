// Pure helpers for the transcription route — kept apart from the controller, which builds an OpenAI
// client at load and so cannot be imported by a unit test.

// THE LANGUAGE IS SAID, NOT GUESSED. Left to detect it, Whisper heard a tester's accented English as
// Romanian, French, Polish and Spanish — "până la mine, vă rugăm să generaționați set-up burn" — and
// every one of those turns was stopped and dictated again (Marce, 2026-10-01). The desks answer in
// English (LANGUAGE_RULE), so English is the default; a client that knows better may say so, as a
// two-letter ISO-639-1 code, and anything else is ignored rather than passed through.
export const DEFAULT_LANGUAGE = 'en'

export function transcriptionLanguage(raw) {
    const code = String(raw ?? '').trim().toLowerCase()
    return /^[a-z]{2}$/.test(code) ? code : DEFAULT_LANGUAGE
}

// Spelling bias for what is actually said here. Whisper's `prompt` is a style/vocabulary hint, not an
// instruction: it makes "PACB" and "stop at 2.14" likelier than near-homophones.
export const VOCABULARY = 'A trader dictating to a trading assistant: tickers like PACB, INTC, NVDA; long, short, entry, stop, target, risk, position size, setup, generate.'
