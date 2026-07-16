/**
 * Market-hours helpers.
 *
 * Single source of truth shared by the monitor (skip intraday checks when
 * closed) and the API (tell the UI whether an order can be placed, and when the
 * market next opens). Holidays are NOT excluded — same approximation the monitor
 * has always used.
 *
 * The session is chosen from the idea's explicit `asset_class` (set by the chat
 * assistant) when available, falling back to a symbol heuristic for ideas that
 * predate the class field. Four session classes:
 *   • crypto  — 24/7 (no gate).
 *   • forex   — 24/5: Sun 17:00 ET → Fri 17:00 ET, continuous (no daily break).
 *   • futures — CME equity-index hours: near-24/5. Sun 18:00 ET → Fri 17:00 ET,
 *               with a daily 17:00–18:00 ET maintenance break. Covers the index
 *               futures (NQ/ES/YM/RTY) and their cTrader cash-CFD aliases
 *               (US100/US500/US30/US2000) — they fill outside the equity session.
 *   • equity  — US regular session, 9:30 AM – 4:00 PM ET, weekdays (stocks + ETFs).
 */

import { normSymbol, baseSymbol } from './brokerSymbol.service.js'

const ET   = 'America/New_York'
const OPEN  = 9 * 60 + 30   // 09:30 in minutes  (equity RTH open)
const CLOSE = 16 * 60       // 16:00 in minutes  (equity RTH close)

// Futures session boundaries (ET, in minutes from midnight).
const FUT_DAY_CLOSE = 17 * 60   // 17:00 — daily close / start of maintenance break
const FUT_EVE_OPEN  = 18 * 60   // 18:00 — daily reopen after the break (and Sunday open)

// Forex session boundary (ET, minutes from midnight): Sun 17:00 open, Fri 17:00 close.
const FX_OPEN_CLOSE = 17 * 60

/** Wall-clock ET as a Date whose get*() fields read as ET (parsed in local tz). */
function _etWall(date = new Date()) {
    return new Date(date.toLocaleString('en-US', { timeZone: ET }))
}

/** Offset (ms) of a timezone from UTC at a given instant — negative west of UTC. */
function _tzOffsetMs(date, tz) {
    const asTz  = new Date(date.toLocaleString('en-US', { timeZone: tz }))
    const asUtc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }))
    return asTz.getTime() - asUtc.getTime()
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

/**
 * True during the forex week: Sun 17:00 ET → Fri 17:00 ET, continuous (no daily
 * maintenance break). Holidays not excluded.
 */
export function isForexOpen(date = new Date()) {
    const et   = _etWall(date)
    const day  = et.getDay()
    const mins = et.getHours() * 60 + et.getMinutes()

    if (day === 6) return false                    // Saturday: closed all day
    if (day === 0) return mins >= FX_OPEN_CLOSE     // Sunday: opens 17:00 ET
    if (day === 5) return mins < FX_OPEN_CLOSE      // Friday: closes 17:00 ET into the weekend
    return true                                     // Mon–Thu: open all day
}

/** Epoch ms of the next forex-session open (Sun 17:00 ET). Returns now if open. */
export function nextForexOpenMs(date = new Date()) {
    if (isForexOpen(date)) return date.getTime()

    const et   = _etWall(date)
    const day  = et.getDay()
    const mins = et.getHours() * 60 + et.getMinutes()

    // Sunday before the open → reopens later today at 17:00 ET.
    if (day === 0 && mins < FX_OPEN_CLOSE) return date.getTime() + (FX_OPEN_CLOSE - mins) * 60_000

    // Weekend close (Fri ≥17:00 / Sat) → walk forward to Sunday 17:00 ET.
    const minutesToMidnight = 24 * 60 - mins
    const fullDaysToSunday  = day === 5 ? 1 : 0   // Fri→Sun spans Sat; Sat→Sun spans none
    return date.getTime() + (minutesToMidnight + fullDaysToSunday * 24 * 60 + FX_OPEN_CLOSE) * 60_000
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
 * Resolve an explicit asset class (set by the chat assistant) to a session, or null
 * when missing/unrecognised so the caller falls back to the symbol heuristic.
 * @param {string} [assetClass] 'stock'|'etf'|'futures'|'forex'|'crypto' (synonyms ok)
 * @returns {'crypto'|'forex'|'futures'|'equity'|null}
 */
function _sessionForClass(assetClass) {
    if (!assetClass) return null
    switch (String(assetClass).toLowerCase().trim()) {
        case 'crypto': case 'cryptocurrency':                       return 'crypto'
        case 'forex':  case 'fx': case 'currency': case 'currencies': return 'forex'
        case 'future': case 'futures':                              return 'futures'
        case 'stock':  case 'stocks': case 'equity': case 'equities': case 'etf': return 'equity'
        default:                                                    return null
    }
}

/** Heuristic session from the symbol alone (back-compat for ideas with no class). */
function _sessionForSymbol(symbol) {
    if (isCrypto(symbol))  return 'crypto'
    if (isFutures(symbol)) return 'futures'
    return 'equity'
}

/**
 * Whether an asset's market is tradeable right now. Single gate used by the monitor
 * and order-state logic. Prefers the explicit `assetClass` (assistant-set); falls
 * back to a symbol heuristic for ideas saved before the class field existed.
 * @param {string} symbol
 * @param {string} [assetClass]
 */
export function isAssetOpen(symbol, assetClass) {
    switch (_sessionForClass(assetClass) ?? _sessionForSymbol(symbol)) {
        case 'crypto':  return true
        case 'forex':   return isForexOpen()
        case 'futures': return isFuturesOpen()
        default:        return isMarketOpen()
    }
}

/**
 * Market status for an asset (class-aware, symbol fallback).
 * @param {string} symbol
 * @param {string} [assetClass]
 * @returns {{ open: boolean, isCrypto: boolean, nextOpenMs: number|null }}
 */
export function getMarketStatus(symbol, assetClass) {
    switch (_sessionForClass(assetClass) ?? _sessionForSymbol(symbol)) {
        case 'crypto':
            return { open: true, isCrypto: true, nextOpenMs: null }
        case 'forex': {
            const open = isForexOpen()
            return { open, isCrypto: false, nextOpenMs: open ? null : nextForexOpenMs() }
        }
        case 'futures': {
            const open = isFuturesOpen()
            return { open, isCrypto: false, nextOpenMs: open ? null : nextFuturesOpenMs() }
        }
        default: {
            const open = isMarketOpen()
            return { open, isCrypto: false, nextOpenMs: open ? null : nextMarketOpenMs() }
        }
    }
}

/**
 * Coarse SESSION-OF-DAY phase, for weighting an intraday entry/management decision (Hermes P3).
 * Asset-class-aware: crypto/forex are ~24h → '24h' (session texture immaterial); index futures use the
 * equity cash-session texture during RTH and 'overnight' outside it; equities get the RTH phase plus
 * pre/after-market and weekend. ET-based (DST-correct via _etWall). This is a LABEL the assessment
 * prompt interprets like a discretionary trader — not a hard rule. Pure (date injectable for tests).
 * @returns {'24h'|'overnight'|'closed'|'pre-market'|'after-hours'|'opening'|'mid'|'lunch'|'power'|'into-close'}
 */
export function sessionPhase(symbol, assetClass, date = new Date()) {
    const session = _sessionForClass(assetClass) ?? _sessionForSymbol(symbol)
    if (session === 'crypto' || session === 'forex') return '24h'

    const et  = _etWall(date)
    const day = et.getDay()
    if (day === 0 || day === 6) return session === 'futures' ? 'overnight' : 'closed'
    const mins = et.getHours() * 60 + et.getMinutes()

    // Outside equity RTH: index futures still trade (thin 'overnight'); equities are pre/after-market.
    if (mins < OPEN)   return session === 'futures' ? 'overnight' : 'pre-market'
    if (mins >= CLOSE) return session === 'futures' ? 'overnight' : 'after-hours'

    // Within the RTH cash session — the texture that matters for equities AND index futures.
    if (mins < 10 * 60)          return 'opening'     // 09:30–10:00
    if (mins < 11 * 60 + 30)     return 'mid'         // 10:00–11:30
    if (mins < 13 * 60 + 30)     return 'lunch'       // 11:30–13:30 (thin, chop-prone)
    if (mins < 15 * 60)          return 'mid'         // 13:30–15:00
    if (mins < 15 * 60 + 50)     return 'power'       // 15:00–15:50 (power hour)
    return 'into-close'                               // 15:50–16:00
}

/**
 * Epoch ms of the start of the current trading "day" for an asset — the boundary a
 * cumulative-volume condition sums from (see [[project_intrabar_cumulative_volume]]).
 *   • equity → today's RTH open, 09:30 ET (pre/post-market ignored for now).
 *   • crypto / futures / forex → UTC midnight of the current UTC date.
 * Futures use calendar midnight by design — this intentionally differs from the
 * exchange's ~18:00 ET session reset.
 * @param {string} symbol
 * @param {string} [assetClass]
 * @param {Date}   [date]
 * @returns {number} epoch ms
 */
export function sessionStartMs(symbol, assetClass, date = new Date()) {
    const session = _sessionForClass(assetClass) ?? _sessionForSymbol(symbol)
    if (session === 'equity') {
        const et  = _etWall(date)
        const off = _tzOffsetMs(date, ET)   // ET→UTC offset (negative)
        // 09:30 on the ET calendar date, expressed in UTC ms.
        return Date.UTC(et.getFullYear(), et.getMonth(), et.getDate(), 9, 30) - off
    }
    // crypto / futures / forex → UTC midnight of the current UTC date.
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

