/**
 * Shared indicator-grammar parser.
 *
 * Scans a free-text condition for EXPLICIT-period indicator references of the form
 * `family(N)` — rsi/ema/sma/atr — and returns them as a normalized list. This is the
 * one grammar the indicator table builder and the chart-studies builder both need to
 * discover custom periods mentioned in the condition text.
 *
 * Deliberately narrow: it only recognises the `family(N)` explicit-period form (the
 * exact unanchored, global, case-insensitive match those two sites already used). It
 * does NOT recognise:
 *   • bare keyword studies (macd / bollinger / volume / vwap) — chart-only concern
 *   • optional-period defaults (rsi/atr with no period → 14) — chart-only concern
 *   • the anchored single-subject resolution in the structured evaluator (which maps
 *     ONE subject token, including non-indicator subjects like close/vwap/macd_*, and
 *     needs `^…$` anchoring). That site is intentionally left on its own grammar.
 *
 * Each family keeps the exact regex the consuming site used, so matches are identical.
 *
 * @param {string} text
 * @returns {{ family: 'rsi'|'ema'|'sma'|'atr', period: number }[]}
 *          In family order (rsi, ema, sma, atr), in text order within a family.
 *          Periods are NOT de-duplicated — callers dedupe as they always have (by
 *          keying into an object), so a repeated `rsi(14) … rsi(14)` collapses there.
 */
const FAMILIES = ['rsi', 'ema', 'sma', 'atr']

export function parseIndicators(text) {
    if (!text || typeof text !== 'string') return []
    const out = []
    for (const family of FAMILIES) {
        const re = new RegExp(`${family}\\((\\d+)\\)`, 'gi')
        for (const [, p] of text.matchAll(re)) {
            out.push({ family, period: +p })
        }
    }
    return out
}
