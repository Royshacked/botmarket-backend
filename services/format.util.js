// Shared number handling — formatting for display, and the one safe numeric coercion.
//
// Formatting reconciles the three near-identical local copies (fmp money(), binance money(),
// yahoo fmtShares()) onto one threshold table: T/B/M tiers with Math.abs handling. Non-finite
// input → null.
//
//  - compactMoney(v) → prefixed with `$` (e.g. "$1.23B", "$450")
//  - compactNumber(v) → no prefix (e.g. "1.23B", "450")
//  - toNum(v) → a finite number or null

function _compact(v, prefix) {
    const n = Number(v)
    if (!Number.isFinite(n)) return null
    if (Math.abs(n) >= 1e12) return `${prefix}${(n / 1e12).toFixed(2)}T`
    if (Math.abs(n) >= 1e9)  return `${prefix}${(n / 1e9).toFixed(2)}B`
    if (Math.abs(n) >= 1e6)  return `${prefix}${(n / 1e6).toFixed(2)}M`
    return `${prefix}${n.toFixed(0)}`
}

export function compactNumber(v) {
    return _compact(v, '')
}

export function compactMoney(v) {
    return _compact(v, '$')
}

/**
 * Coerce to a finite number, or null. Pure.
 *
 * The guard that matters is the nullish/blank one FIRST: `Number(null)` and `Number('')` are both
 * `0`, so the terse `Number.isFinite(Number(v)) ? Number(v) : null` silently turns a MISSING value
 * into a real zero. That is not academic — it is how a failed price fetch read as "price 0" and
 * killed every live research thesis in the coverage book. Absent in → null out, always.
 */
export function toNum(v) {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
}
