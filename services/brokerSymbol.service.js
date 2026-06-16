/**
 * Broker symbol alias map.
 *
 * The app speaks ONE canonical asset name per instrument — the symbol authored on
 * an idea and used by the Massive/Yahoo monitor feed (e.g. 'NQ'). A broker may
 * list the same instrument under a different name: cTrader trades the Nasdaq-100 as
 * the 'US100' cash CFD, not the 'NQ' future. This module is the single, static,
 * bidirectional translation between the two — keyed by broker type.
 *
 * Only instruments whose broker name DIFFERS from the app's canonical name are
 * listed. Everything else (FX, crypto, metals — EURUSD, BTC-USD, XAUUSD) resolves
 * by identity, with a separator/case-insensitive fuzzy fallback, so the tables stay
 * small and carry only the genuine renames (index futures ↔ cash CFDs). The fuzzy
 * key also means the alias survives cosmetic punctuation differences ('US-100').
 *
 *   • toBrokerSymbol(broker, asset)  — forward: app canonical → broker symbol.
 *     Used when forking an idea onto a broker child, so the tradable symbol is
 *     resolved + persisted once (no per-order lookup).
 *   • toAppAsset(broker, brokerSymbol) — reverse: broker symbol → app canonical.
 *     Used by the execution feed so a broker fill's symbol maps back to the asset
 *     the idea is stored under (the reconciler matches `exec.symbol` to `idea.asset`).
 *
 * Both directions are idempotent on values that are already in the target space:
 * toBrokerSymbol('ctrader', 'US100') === 'US100', toAppAsset('ctrader', 'NQ') === 'NQ'.
 */

/**
 * Canonical app asset → broker symbol, per broker type.
 *
 * cTrader lists the US equity indices as cash-CFD names. Only NQ↔US100 is
 * live-verified (project memory: pure offset, scale k=1); the rest follow the same
 * Spotware naming convention. An asset that is NOT mapped falls through to identity,
 * so an un-listed or mis-named instrument simply trades under its own name (and a
 * truly unknown symbol is rejected by the broker rather than silently mis-routed).
 */
const ALIASES = {
    ctrader: {
        NQ:  'US100',   // Nasdaq-100
        ES:  'US500',   // S&P 500
        YM:  'US30',    // Dow Jones 30
        RTY: 'US2000',  // Russell 2000
    },
}

// Values are the suffix-LESS base name. Real cTrader brokers append an account-specific
// suffix (FTMO lists 'US100.cash', others use '.spot' / '.r' / none), so matching is
// suffix-tolerant: the session indexes a pre-dot base key for the forward lookup, and
// the reverse lookup (toAppAsset) strips the suffix via baseSymbol before matching.

// Per-broker lookup tables, built lazily from ALIASES and memoised. Each holds the
// exact forward/reverse maps plus normalized-key variants for the fuzzy fallback.
const _tables = new Map()   // broker → { fwd, rev, fwdNorm, revNorm }

function _tableFor(broker) {
    let t = _tables.get(broker)
    if (t) return t

    const fwd     = ALIASES[broker] ?? {}
    const rev     = {}
    const fwdNorm = {}
    const revNorm = {}
    for (const [asset, brokerSym] of Object.entries(fwd)) {
        rev[brokerSym]              = asset
        fwdNorm[normSymbol(asset)]  = brokerSym
        revNorm[normSymbol(brokerSym)] = asset
    }

    t = { fwd, rev, fwdNorm, revNorm }
    _tables.set(broker, t)
    return t
}

/**
 * App canonical asset → broker symbol. Returns the input unchanged when the broker
 * lists the instrument under the same name (FX/crypto/metals) or has no alias for it.
 * @param {string} broker  broker type, e.g. 'ctrader'
 * @param {string} asset   app canonical asset, e.g. 'NQ'
 * @returns {string} broker symbol, e.g. 'US100'
 */
export function toBrokerSymbol(broker, asset) {
    if (asset == null) return asset
    const t = _tableFor(broker)
    return t.fwd[asset] ?? t.fwdNorm[normSymbol(asset)] ?? asset
}

/**
 * Broker symbol → app canonical asset. Returns the input unchanged when the broker
 * name already matches the app's (no reverse alias).
 * @param {string} broker        broker type, e.g. 'ctrader'
 * @param {string} brokerSymbol  broker symbol, e.g. 'US100'
 * @returns {string} app canonical asset, e.g. 'NQ'
 */
export function toAppAsset(broker, brokerSymbol) {
    if (brokerSymbol == null) return brokerSymbol
    const t = _tableFor(broker)
    return t.rev[brokerSymbol]
        ?? t.revNorm[normSymbol(brokerSymbol)]
        ?? t.revNorm[baseSymbol(brokerSymbol)]   // drop the broker suffix: 'US100.cash' → NQ
        ?? brokerSymbol
}

/** Separator/case-insensitive symbol key: 'BTC-USD' / 'us100' → 'BTCUSD' / 'US100'. */
export function normSymbol(name) {
    return String(name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Pre-suffix symbol key: drops a broker suffix segment. 'US100.cash' → 'US100'. */
export function baseSymbol(name) {
    return normSymbol(String(name ?? '').split('.')[0])
}

export const brokerSymbolService = { toBrokerSymbol, toAppAsset, normSymbol, baseSymbol }
