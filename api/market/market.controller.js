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
import { makeHandle }         from '../_shared/handle.util.js'
import { httpError }          from '../../services/httpError.util.js'
import * as marketService     from './market.service.js'

const LOG    = '[market:controller]'
const handle = makeHandle(LOG)

/** The symbol every route here takes, normalized. Empty string when absent — the caller 400s. */
const _symbol = req => String(req.query.symbol ?? '').toUpperCase().trim()

export const getStatus = handle('getStatus', async (req, res) => {
    const assetClass = req.query.assetClass ?? req.query.asset_class ?? undefined
    res.send(getMarketStatus(req.query.symbol ?? '', assetClass))
})

// GET /api/market/quote?symbol=AAPL
// Never throws for an unpriceable symbol — see market.service.getQuote for why a blip is a skipped
// tick rather than a 500.
export const getQuote = handle('getQuote', async (req, res) => {
    const symbol = _symbol(req)
    if (!symbol) throw httpError(400, 'symbol is required')
    res.send(await marketService.getQuote(symbol))
})

// GET /api/market/candles?symbol=AAPL&interval=5min[&from=<ms>&to=<ms>]
export const getCandles = handle('getCandles', async (req, res) => {
    const symbol = _symbol(req)
    if (!symbol) throw httpError(400, 'symbol is required')

    const intervalRaw = String(req.query.interval ?? 'day')
    const spec = parseChartInterval(intervalRaw)
    if (!spec) throw httpError(400, `unsupported interval: ${intervalRaw}`)

    res.send(await marketService.getCandles(symbol, intervalRaw, spec, {
        fromMs: marketService.parseWhenMs(req.query.from),
        toMs:   marketService.parseWhenMs(req.query.to),
    }))
})
