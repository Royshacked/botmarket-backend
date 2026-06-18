/**
 * Market-hours helpers.
 *
 * Single source of truth shared by the monitor (skip intraday checks when
 * closed) and the API (tell the UI whether an order can be placed, and when the
 * market next opens). Holidays are NOT excluded — same approximation the monitor
 * has always used.
 *
 * Three session classes, picked by symbol:
 *   • crypto  — 24/7 (no gate).
 *   • futures — CME equity-index hours: near-24/5. Sun 18:00 ET → Fri 17:00 ET,
 *               with a daily 17:00–18:00 ET maintenance break. Covers the index
 *               futures (NQ/ES/YM/RTY) and their cTrader cash-CFD aliases
 *               (US100/US500/US30/US2000) — they fill outside the equity session.
 *   • equity  — US regular session, 9:30 AM – 4:00 PM ET, weekdays (the default).
 */

import { normSymbol, baseSymbol } from './brokerSymbol.service.js'

const ET   = 'America/New_York'
const OPEN  = 9 * 60 + 30   // 09:30 in minutes  (equity RTH open)
const CLOSE = 16 * 60       // 16:00 in minutes  (equity RTH close)

// Futures session boundaries (ET, in minutes from midnight).
const FUT_DAY_CLOSE = 17 * 60   // 17:00 — daily close / start of maintenance break
const FUT_EVE_OPEN  = 18 * 60   // 18:00 — daily reopen after the break (and Sunday open)

/** Wall-clock ET as a Date whose get*() fields read as ET (parsed in local tz). */
function _etWall(date = new Date()) {
    return new Date(date.toLocaleString('en-US', { timeZone: ET }))
}

// Crypto base tickers whose fiat-quoted pairs (e.g. BTCUSD) are 24/7. A pair like
// BTCUSD is otherwise indistinguishable from a forex pair (EURUSD) by shape alone,
// so we recognise it by a known crypto base. Extend as brokers add instruments.
const CRYPTO_BASES = [
    'BTC', 'XBT', 'ETH', 'LTC', 'XRP', 'BCH', 'ADA', 'SOL', 'DOT', 'DOGE',
    'LINK', 'XLM', 'EOS', 'TRX', 'BNB', 'UNI', 'AVAX', 'MATIC', 'ATOM', 'ALGO',
    'XMR', 'ETC', 'NEO', 'FIL', 'AAVE', 'SHIB', 'APE', 'NEAR', 'FTM', 'ICP',
]
const CRYPTO_BASE_SET = new Set(CRYPTO_BASES)
// <crypto base><fiat quote>, e.g. BTCUSD / ETHEUR (separators already stripped).
const CRYPTO_FIAT_PAIR = new RegExp(`^(${CRYPTO_BASES.join('|')})(USD|EUR|GBP|JPY|AUD)$`)

/** Crypto assets trade 24/7 — no market-hours gate. */
export function isCrypto(symbol) {
    const s = String(symbol ?? '').toUpperCase().replace(/[/\-_]/g, '')
    if (!s) return false
    if (/(USDT|USDC)$/.test(s)) return true   // stablecoin quote → always crypto
    if (CRYPTO_FIAT_PAIR.test(s)) return true  // known crypto base + fiat quote (BTCUSD…)
    return CRYPTO_BASE_SET.has(s)              // bare base symbol (e.g. "BTC")
}

// Index futures and their cTrader cash-CFD aliases. Both the app-canonical names
// (NQ…) and the broker names (US100…) appear in the wild (see brokerSymbol.service),
// so we recognise both. These follow CME equity-index hours, NOT the cash session.
const INDEX_FUTURES = new Set([
    'NQ', 'ES', 'YM', 'RTY',            // app canonical (CME index futures)
    'US100', 'US500', 'US30', 'US2000', // cTrader cash-CFD aliases
])

/** True for an index future / its cash-CFD alias (near-24/5 hours, not equity RTH). */
export function isFutures(symbol) {
    if (symbol == null) return false
    return INDEX_FUTURES.has(normSymbol(symbol))   // 'US-100' → 'US100'
        || INDEX_FUTURES.has(baseSymbol(symbol))   // 'US100.cash' → 'US100'
}

/**
 * True during the CME equity-index session: Sun 18:00 ET → Fri 17:00 ET, minus the
 * daily 17:00–18:00 ET maintenance break (Mon–Thu). Holidays not excluded.
 */
export function isFuturesOpen(date = new Date()) {
    const et   = _etWall(date)
    const day  = et.getDay()
    const mins = et.getHours() * 60 + et.getMinutes()

    if (day === 6) return false                  // Saturday: closed all day
    if (day === 0) return mins >= FUT_EVE_OPEN    // Sunday: opens 18:00 ET
    if (day === 5) return mins < FUT_DAY_CLOSE    // Friday: closes 17:00 ET into the weekend
    // Mon–Thu: open except the 17:00–18:00 ET maintenance break.
    return mins < FUT_DAY_CLOSE || mins >= FUT_EVE_OPEN
}

/** Epoch ms of the next futures-session open. Returns now if already open. */
export function nextFuturesOpenMs(date = new Date()) {
    if (isFuturesOpen(date)) return date.getTime()

    const et   = _etWall(date)
    const day  = et.getDay()
    const mins = et.getHours() * 60 + et.getMinutes()

    // Daily maintenance break (Mon–Thu) or Sunday pre-open: reopens the same day at 18:00 ET.
    if ((day >= 1 && day <= 4 && mins >= FUT_DAY_CLOSE) || day === 0) {
        return date.getTime() + (FUT_EVE_OPEN - mins) * 60_000
    }
    // Weekend close (Fri ≥17:00 / Sat): walk forward to Sunday 18:00 ET.
    const minutesToMidnight = 24 * 60 - mins
    const fullDaysToSunday  = day === 5 ? 1 : 0   // Fri→Sun spans Sat; Sat→Sun spans none
    return date.getTime() + (minutesToMidnight + fullDaysToSunday * 24 * 60 + FUT_EVE_OPEN) * 60_000
}

/** True between 9:30 and 16:00 ET on a weekday. */
export function isMarketOpen(date = new Date()) {
    const et  = _etWall(date)
    const day = et.getDay()
    if (day === 0 || day === 6) return false
    const mins = et.getHours() * 60 + et.getMinutes()
    return mins >= OPEN && mins < CLOSE
}

/**
 * Epoch ms of the next regular-session open (9:30 ET). Returns now if already
 * open. DST transitions during the gap may shift the result by up to an hour
 * (twice a year) — acceptable for a "next open" hint.
 */
export function nextMarketOpenMs(date = new Date()) {
    if (isMarketOpen(date)) return date.getTime()

    const et   = _etWall(date)
    const day  = et.getDay()
    const mins = et.getHours() * 60 + et.getMinutes()

    let minutesUntil
    if (day >= 1 && day <= 5 && mins < OPEN) {
        // Opens later today
        minutesUntil = OPEN - mins
    } else {
        // Walk forward to the next weekday's 09:30
        const minutesToMidnight = 24 * 60 - mins
        let addDays  = 1
        let probeDay = (day + 1) % 7
        while (probeDay === 0 || probeDay === 6) {
            addDays++
            probeDay = (probeDay + 1) % 7
        }
        minutesUntil = minutesToMidnight + (addDays - 1) * 24 * 60 + OPEN
    }
    return date.getTime() + minutesUntil * 60_000
}

/**
 * Whether `symbol`'s market is tradeable right now. Single gate used by the
 * monitor and order-state logic so every call site classifies the same way:
 * crypto 24/7, index futures near-24/5, everything else equity RTH.
 */
export function isAssetOpen(symbol) {
    if (isCrypto(symbol))  return true
    if (isFutures(symbol)) return isFuturesOpen()
    return isMarketOpen()
}

/**
 * Market status for a symbol.
 * @returns {{ open: boolean, isCrypto: boolean, nextOpenMs: number|null }}
 */
export function getMarketStatus(symbol) {
    if (isCrypto(symbol)) return { open: true, isCrypto: true, nextOpenMs: null }
    if (isFutures(symbol)) {
        const open = isFuturesOpen()
        return { open, isCrypto: false, nextOpenMs: open ? null : nextFuturesOpenMs() }
    }
    const open = isMarketOpen()
    return { open, isCrypto: false, nextOpenMs: open ? null : nextMarketOpenMs() }
}

export const marketService = {
    isCrypto, isFutures, isMarketOpen, isFuturesOpen, isAssetOpen,
    nextMarketOpenMs, nextFuturesOpenMs, getMarketStatus,
}
