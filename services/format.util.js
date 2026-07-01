// Shared compact-number formatting. Reconciles the three near-identical local
// copies (fmp money(), binance money(), yahoo fmtShares()) onto one threshold
// table: T/B/M tiers with Math.abs handling. Non-finite input → null.
//
//  - compactMoney(v) → prefixed with `$` (e.g. "$1.23B", "$450")
//  - compactNumber(v) → no prefix (e.g. "1.23B", "450")

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
