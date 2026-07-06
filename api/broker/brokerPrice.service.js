/**
 * Basis-price conversion — translate a REAL-authored price into a broker's own price
 * space, MEASURED from market data (never hardcoded — the basis drifts toward expiry).
 *
 * Some brokers list an instrument whose price basis differs from the real-market
 * reference a user analyzes: cTrader trades the Nasdaq-100 as the US100 CASH CFD, but a
 * user reads levels off the NQ FUTURE (NQ=F) — a ~227pt futures basis.
 *
 * In practice ONLY index futures carry a gap worth converting (broker sells the cash
 * CFD, the user analyses the future → a ~227pt basis). Everything else the broker lists
 * is the SAME instrument as the real reference — oil CFD ≈ CL=F front future, gold spot ≈
 * spot, stocks ≈ stocks — so the gap is ~0 and no conversion is needed. And the index
 * futures all have a cash index, so one method covers 100% of the real need:
 *
 *     offset      = yahooClose(cashIndex) − yahooClose(future)   // e.g. ^NDX − NQ=F
 *     brokerPrice = realPrice + offset
 *
 * Two Yahoo daily CLOSES (same source + settled) → no free-feed delay and no cross-source
 * misalignment (a live-vs-delayed or broker-vs-Yahoo mix both corrupt the basis). The
 * ~1.7pt broker-CFD-vs-cash-index residual is dropped as negligible. Everything without a
 * cash-index mapping (oil, gold, stocks, FX, crypto, paper, non-aliased) is IDENTITY.
 *
 * This module measures the offset; the caller (fork-time in tradeIdeas.service) applies
 * it to the idea's absolute price leaves.
 */

import { getNumericQuoteWithTime }    from '../../providers/yahoofinance.provider.js'
import { normSymbol }                 from '../../services/brokerSymbol.service.js'
import { logger }                     from '../../services/logger.service.js'

const LOG = '[brokerPrice]'

// Real-market reference the user analyzes, per canonical asset — the FUTURE (their
// choice), not the cash index. Only aliased instruments with a real basis need it;
// anything unmapped gets no conversion. Extend as more aliased instruments are onboarded.
const REAL_TICKER = {
    NQ:  'NQ=F',
    ES:  'ES=F',
    YM:  'YM=F',
    RTY: 'RTY=F',
}

// Cash index the broker's CFD tracks, per canonical asset — the delay-free close method
// pairs it with the future (cashIndex − future). A convertible instrument has BOTH a
// cash index and a future here; anything else is identity (no basis worth converting).
const CASH_INDEX = {
    NQ:  '^NDX',
    ES:  '^GSPC',
    YM:  '^DJI',
    RTY: '^RUT',
}

/** Canonical asset → Yahoo real-reference ticker (futures), or null when unmapped. */
export function realReferenceTicker(asset) {
    return REAL_TICKER[normSymbol(asset)] ?? null
}

/** Canonical asset → Yahoo cash-index ticker (for the accurate close method), or null. */
export function cashIndexTicker(asset) {
    return CASH_INDEX[normSymbol(asset)] ?? null
}

/** Apply a measured basis offset to a real-authored price. Identity on 0/non-numeric. */
export function applyOffset(price, offset) {
    if (price == null || !Number.isFinite(Number(price))) return price
    return Number(price) + (Number(offset) || 0)
}

/**
 * Measure the basis offset used to shift REAL-authored prices into the broker's price
 * space, from two Yahoo daily closes (cashIndex − future). Returns { offset, reason,
 * ...meta }. `offset` is 0 (identity — no shift) unless the instrument is aliased AND has
 * both a cash-index and a future mapping (i.e. an index future) AND both closes resolve.
 *
 *   reason: 'not_aliased'   — brokerSymbol == asset (stocks/FX/crypto/paper)
 *           'no_conversion' — aliased but no cash-index/future mapping (oil, gold, …)
 *           'no_close'      — convertible, but a Yahoo daily close was unavailable
 *           'ok'            — offset measured
 *
 * @param {{ brokerSymbol:string, asset:string }} p
 * @returns {Promise<{ offset:number, reason:string, cashTicker?:string, futureTicker?:string, cashClose?:number, futureClose?:number }>}
 */
export async function computeBasisOffset({ brokerSymbol, asset }) {
    const aliased = brokerSymbol && normSymbol(brokerSymbol) !== normSymbol(asset)
    if (!aliased) return { offset: 0, reason: 'not_aliased' }

    // Only instruments whose broker CFD tracks a cash index carry a convertible basis
    // (the index futures). Everything else aliased has no meaningful gap → identity.
    const cashTicker   = cashIndexTicker(asset)
    const futureTicker = realReferenceTicker(asset)
    if (!cashTicker || !futureTicker) return { offset: 0, reason: 'no_conversion' }

    // Accurate, delay-free basis: two Yahoo daily CLOSES, same source + settled.
    const [cash, fut] = await Promise.all([_quoteSafe(cashTicker), _quoteSafe(futureTicker)])
    if (cash?.prevClose == null || fut?.prevClose == null) {
        logger.warn(LOG, `basis: missing daily close for ${cashTicker}/${futureTicker} — placing at authored price`)
        return { offset: 0, reason: 'no_close', cashTicker, futureTicker }
    }

    const offset = cash.prevClose - fut.prevClose
    logger.info(LOG, `basis ${asset}: ${cashTicker} ${cash.prevClose} − ${futureTicker} ${fut.prevClose} = ${offset.toFixed(2)}`)
    return { offset, reason: 'ok', cashTicker, futureTicker, cashClose: cash.prevClose, futureClose: fut.prevClose }
}

async function _quoteSafe(ticker) {
    try {
        return await getNumericQuoteWithTime(ticker)
    } catch (err) {
        logger.warn(LOG, `basis: quote failed for ${ticker}: ${err.message}`)
        return null
    }
}
