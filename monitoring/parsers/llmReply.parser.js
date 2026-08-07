// Reading what a model actually said — the two lenient parses every LLM-backed monitor needs.
//
// Sits with the other parsers (condition, indicators) rather than in monitorUtils, which is the
// candle/timeframe module. `services/util.service.js` carries a note pointing here so nobody adds
// a second JSON parser next to the file caches; that note now points at the right file.

/**
 * Walk from the first `{` to its MATCHING `}` and JSON.parse that slice.
 *
 * Brace-counting rather than a regex because models wrap the object in explanatory prose, and prose
 * contains braces: a greedy match runs from the first `{` in the preamble to the last `}` in the
 * epilogue and parses neither. Throws on no-JSON / unclosed — callers catch and retry, which is why
 * the message carries the head of the response.
 */
export function extractFirstJSON(text) {
    const start = text.indexOf('{')
    if (start === -1) throw new Error(`no JSON in response — ${String(text).slice(0, 120)}`)
    let depth = 0
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1))
    }
    throw new Error('unclosed JSON object in response')
}

/**
 * Standard lenient parse of a yes/no reply: trim, upper-case, first char `Y`. Shared by the
 * news / indicator / chart evaluators so "YES", "Yes." and "yes" all pass alike.
 */
export const parseYesNo = raw => String(raw ?? '').trim().toUpperCase().startsWith('Y')
