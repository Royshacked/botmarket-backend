/**
 * /api/market handlers — request in, payload out.
 *
 * What stays here is transport judgment only: which query params exist, what a missing or
 * unsupported one answers with, and the status code. The caches, the window arithmetic, the price
 * feed and the provider call moved to market.service.js — this was the only controller in the app
 * importing a provider directly.
 */

import { getMarketStatus }    from '../../services/market.service.js'
import { parseChartInterval } from '../../services/candleInterval.util.js'
import { logger }             from '../../services/logger.service.js'
import * as marketService     from './market.service.js'

const LOG = '[market:controller]'

/** The symbol every route here takes, normalized. Empty string when absent — the caller 400s. */
const _symbol = req => String(req.query.symbol ?? '').toUpperCase().trim()

export async function getStatus(req, res, next) {
    try {
        const assetClass = req.query.assetClass ?? req.query.asset_class ?? undefined
        res.send(getMarketStatus(req.query.symbol ?? '', assetClass))
    } catch (err) {
        logger.error(LOG, 'getStatus failed', err)
        next(err)
    }
}

// GET /api/market/quote?symbol=AAPL
// Never throws for an unpriceable symbol — see market.service.getQuote for why a blip is a skipped
// tick rather than a 500.
export async function getQuote(req, res, next) {
    const symbol = _symbol(req)
    if (!symbol) return res.status(400).send({ error: 'symbol is required' })
    try {
        res.send(await marketService.getQuote(symbol))
    } catch (err) {
        logger.error(LOG, 'getQuote failed', err)
        next(err)
    }
}

// GET /api/market/candles?symbol=AAPL&interval=5min[&from=<ms>&to=<ms>]
export async function getCandles(req, res, next) {
    const symbol = _symbol(req)
    if (!symbol) return res.status(400).send({ error: 'symbol is required' })

    const intervalRaw = String(req.query.interval ?? 'day')
    const spec = parseChartInterval(intervalRaw)
    if (!spec) return res.status(400).send({ error: `unsupported interval: ${intervalRaw}` })

    try {
        const payload = await marketService.getCandles(symbol, intervalRaw, spec, {
            fromMs: marketService.parseWhenMs(req.query.from),
            toMs:   marketService.parseWhenMs(req.query.to),
        })
        res.send(payload)
    } catch (err) {
        logger.error(LOG, 'getCandles failed', err)
        next(err)
    }
}
