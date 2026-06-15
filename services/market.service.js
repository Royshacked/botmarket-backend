/**
 * Market-hours helpers (US regular session, 9:30 AM – 4:00 PM ET, weekdays).
 *
 * Single source of truth shared by the monitor (skip intraday checks when
 * closed) and the API (tell the UI whether an order can be placed, and when the
 * market next opens). Holidays are NOT excluded — same approximation the monitor
 * has always used.
 */

const ET   = 'America/New_York'
const OPEN  = 9 * 60 + 30   // 09:30 in minutes
const CLOSE = 16 * 60       // 16:00 in minutes

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
 * Market status for a symbol.
 * @returns {{ open: boolean, isCrypto: boolean, nextOpenMs: number|null }}
 */
export function getMarketStatus(symbol) {
    if (isCrypto(symbol)) return { open: true, isCrypto: true, nextOpenMs: null }
    const open = isMarketOpen()
    return { open, isCrypto: false, nextOpenMs: open ? null : nextMarketOpenMs() }
}

export const marketService = { isCrypto, isMarketOpen, nextMarketOpenMs, getMarketStatus }
