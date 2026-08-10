/**
 * Spot FX — turning a number the user stated in their own currency into the app's internal unit.
 *
 * The app values everything in USD because that is what the price feed returns (FMP `/quote` covers
 * equities, ETFs, crypto and forex on this key). A user with a bank book abroad states two things in
 * their own currency: what the account is worth, and how much of it is cash.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT. Converting CASH at spot is correct — cash is worth today's
 * rate today. Converting a COST BASIS at spot is not: those lots were bought at historical rates, so
 * a spot conversion folds years of currency drift into what then reads as market P&L. Per-lot
 * historical FX is a separate piece of work; until it exists, only cash-like figures come through
 * here. See docs/design/adopted-book.md §3.
 *
 * A holding that genuinely trades in another currency needs its whole price space converted, not one
 * rate at intake — the design in project_broker_native_price_space. Those lines are unpriceable to us
 * today, which the intake already handles as a first-class case rather than a failure.
 */

import { quoteMapForSymbols } from '../api/broker/paperExecution.service.js'
import { logger }             from './logger.service.js'

const LOG = '[fxRate]'

/**
 * How many USD one unit of `currency` buys, or null when we cannot price it.
 *
 * Tries the DIRECT listing first (`ILSUSD` — already the multiplier we want), then the inverse
 * (`USDILS`) and inverts it, because any given pair is conventionally listed only one way round.
 * Rides the shared quote read, so it inherits its cache and its unpriceable-symbol latch.
 *
 * @param {string} currency ISO 4217, e.g. 'ILS'
 * @returns {Promise<number|null>}
 */
export async function fxToUsd(currency) {
    const cur = String(currency ?? '').trim().toUpperCase()
    if (!cur)          return null
    if (cur === 'USD') return 1
    if (!/^[A-Z]{3}$/.test(cur)) return null

    try {
        const direct = `${cur}USD`
        const d = Number((await quoteMapForSymbols([direct])).get(direct))
        if (Number.isFinite(d) && d > 0) return d

        const inverse = `USD${cur}`
        const i = Number((await quoteMapForSymbols([inverse])).get(inverse))
        if (Number.isFinite(i) && i > 0) return 1 / i
    } catch (err) {
        logger.warn(LOG, `no rate for ${cur}: ${err.message}`)
    }
    return null
}

export const fxRateService = { fxToUsd }
