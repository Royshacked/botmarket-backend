/**
 * Rounding, once.
 *
 * Twelve modules each kept a private `_round2` / `round8` / `_round4` / `round` — the same two
 * lines of arithmetic in two spellings (`Math.round(n * 100) / 100` and `Number(n.toFixed(2))`)
 * that agree on every value that matters and would eventually be edited apart. paperBroker.service
 * even carried a copy "rather than imported" to dodge an import cycle through paperExecution — the
 * fix for which is a module with no imports at all, which this is.
 *
 * Three edge behaviours were in use and each is a named function here, so a caller says which it
 * means instead of relying on a local helper's accident:
 *   roundTo / round2 / round4 / round8   plain: a non-number stays NaN (the caller checks)
 *   roundOrNull                          null / undefined / non-finite → null (a display value that
 *                                        may legitimately be "not reported")
 *   roundOrZero                          non-finite → 0 (an accumulator or quantity)
 *
 * Presentation rounds; storage keeps the number. Prices and blended cost bases are stored at 8dp
 * (round8) so a sub-cent instrument is not rounded to zero — see paperExecution.blendPosition.
 */

/** Round to `dp` decimal places. NaN in → NaN out. */
export function roundTo(n, dp) {
    const f = 10 ** dp
    return Math.round(n * f) / f
}

export const round2 = n => roundTo(n, 2)
export const round4 = n => roundTo(n, 4)
export const round8 = n => roundTo(n, 8)

/** null / undefined / non-finite → null; otherwise rounded to `dp` (default 2). */
export function roundOrNull(n, dp = 2) {
    const v = Number(n)
    return n == null || !Number.isFinite(v) ? null : roundTo(v, dp)
}

/** Non-finite → 0; otherwise rounded to `dp` (default 2). */
export function roundOrZero(n, dp = 2) {
    const v = Number(n)
    return roundTo(Number.isFinite(v) ? v : 0, dp)
}
