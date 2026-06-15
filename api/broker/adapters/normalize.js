/**
 * Shared normalisation helpers for broker adapters.
 *
 * Every adapter maps a broker's raw REST shapes onto the unified contracts in
 * broker.interface.js. These three primitives showed up identically in each
 * adapter, so they live here — a new adapter imports them instead of re-copying.
 */

/**
 * Broker REST responses arrive either bare (an array) or wrapped ({ data: [...] }),
 * depending on the endpoint. Normalise both to a plain array.
 * @param {unknown} raw
 * @returns {unknown[]}
 */
export function asList(raw) {
    return Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
}

/**
 * Coerce a value to a finite number, or null if it isn't one.
 * @param {unknown} v
 * @returns {number|null}
 */
export function num(v) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
}

/**
 * Coerce a monetary value reported in integer cents to account-currency units
 * (e.g. cTrader REST money fields), or null if it isn't a finite number.
 * @param {unknown} v
 * @returns {number|null}
 */
export function money(v) {
    const n = Number(v)
    return Number.isFinite(n) ? n / 100 : null
}
