// Binance USDⓈ-M futures provider — the crypto analog to equity short-interest /
// options positioning. Surfaces three free, no-key, public-API signals for a
// perpetual: funding rate (who's paying to hold the trade), open interest (how
// much leverage is committed), and the global long/short account ratio (retail
// positioning). Crypto perps only — there is no equivalent for equities/FX here.
//
// FREE-PLAN NOTES:
//  - All endpoints below are public market data: no API key, generous limits.
//  - Data is exchange-specific (Binance) and snapshot/short-history, not a
//    consolidated cross-venue figure. Good enough for positioning context.

import { logger } from '../services/logger.service.js'

const LOG  = '[binance]'
const BASE = 'https://fapi.binance.com'

const _cache = new Map() // PERP -> { at, text }
const TTL_MS = 5 * 60 * 1000

// Normalize a user/idea symbol to a Binance USDT perpetual: BTC, BTC-USD,
// BTCUSD, BTC/USDT, BTCUSDT → BTCUSDT.
function _toPerp(symbol) {
    let s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!s) return ''
    if (s.endsWith('PERP')) s = s.slice(0, -4)
    if (s.endsWith('USDT')) return s
    if (s.endsWith('USDC')) return s.slice(0, -4) + 'USDT'
    if (s.endsWith('USD'))  return s.slice(0, -3) + 'USDT'
    return s + 'USDT'
}

async function _get(path) {
    const res = await fetch(`${BASE}${path}`)
    if (!res.ok) throw new Error(`Binance ${path} → HTTP ${res.status}`)
    return res.json()
}

const money = v => {
    const n = Number(v)
    if (!Number.isFinite(n)) return null
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
    return `$${n.toFixed(0)}`
}

/**
 * Derivatives positioning for a crypto perpetual as an LLM-ready string.
 * Returns funding rate, open interest (notional), and global long/short account
 * ratio. Falls back gracefully when the symbol isn't a tracked Binance perp.
 */
export async function getDerivativesContext(symbol) {
    const perp = _toPerp(symbol)
    if (!perp) return 'No symbol provided.'

    const hit = _cache.get(perp)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.text

    const [premium, oiHist, lsRatio] = await Promise.allSettled([
        _get(`/fapi/v1/premiumIndex?symbol=${perp}`),
        _get(`/futures/data/openInterestHist?symbol=${perp}&period=1h&limit=1`),
        _get(`/futures/data/globalLongShortAccountRatio?symbol=${perp}&period=1h&limit=1`),
    ])

    // If even the premium index 404s, this isn't a Binance perp.
    if (premium.status !== 'fulfilled' || !premium.value || premium.value.code != null) {
        return `No Binance perpetual found for "${symbol}" (tried ${perp}). Funding/OI/long-short context is only available for crypto perps, not equities, FX or traditional futures.`
    }

    const p = premium.value
    const fundingPct = p.lastFundingRate != null ? (Number(p.lastFundingRate) * 100).toFixed(4) : null
    const nextFunding = p.nextFundingTime ? new Date(p.nextFundingTime).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null
    const markPrice = p.markPrice != null ? `$${Number(p.markPrice).toFixed(2)}` : null

    const oi = oiHist.status === 'fulfilled' && Array.isArray(oiHist.value) ? oiHist.value[0] : null
    const lsr = lsRatio.status === 'fulfilled' && Array.isArray(lsRatio.value) ? lsRatio.value[0] : null

    const fundingLine = fundingPct != null
        ? `Funding rate: ${fundingPct}% / 8h${Number(p.lastFundingRate) >= 0 ? ' (positive — longs pay shorts; long-skewed/crowded)' : ' (negative — shorts pay longs; short-skewed)'}${nextFunding ? `, next ${nextFunding}` : ''}`
        : null

    const lsLine = lsr
        ? `Global long/short account ratio: ${Number(lsr.longShortRatio).toFixed(2)} (${(Number(lsr.longAccount) * 100).toFixed(0)}% long / ${(Number(lsr.shortAccount) * 100).toFixed(0)}% short, retail accounts)`
        : null

    const text = [
        `${perp} — crypto derivatives positioning (Binance, snapshot)`,
        markPrice ? `Mark price: ${markPrice}` : null,
        fundingLine,
        oi ? `Open interest: ${money(oi.sumOpenInterestValue)} (${Number(oi.sumOpenInterest).toLocaleString('en-US', { maximumFractionDigits: 0 })} contracts)` : null,
        lsLine,
        'Note: Binance-only positioning, not a consolidated cross-exchange figure.',
    ].filter(Boolean).join('\n')

    if (_cache.size > 300) _cache.clear()
    _cache.set(perp, { at: Date.now(), text })
    logger.info(LOG, 'derivatives context fetched', { perp })
    return text
}
