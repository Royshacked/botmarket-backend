/**
 * Interactive Brokers (IBKR) broker adapter.
 *
 * Implements BrokerAdapter over the TWS API socket to a local IB Gateway / TWS
 * (providers/ibkr.gateway.provider.js). One running gateway = one IB account, so
 * the "connection" is gateway coordinates { host, port, clientId } — no OAuth.
 * Paper vs live is the port (paper 4002/7497, live 4001/7496).
 *
 * Build status:
 *   Phase 1 (this) — connection lifecycle + account summary.   DONE
 *   Phase 2 — positions, contract qualification, candles over the socket.
 *   Phase 3 — execution feed → executionBus.
 *   Phase 4 — trading (placeOrder/closePosition/cancel/list/protection).
 *
 * The older providers/ibkr.provider.js (Client Portal REST/OAuth) is retired in
 * Phase 2 once candles move to reqHistoricalData on the socket.
 */

import { BarSizeSetting, WhatToShow } from '@stoqey/ib'
import { BrokerAdapter }           from './broker.interface.js'
import { num }                     from './normalize.js'
import { getIBKRGateway }          from '../../../providers/ibkr.gateway.provider.js'
import { brokerConnectionService } from '../brokerConnection.service.js'
import { logger }                  from '../../../services/logger.service.js'

const LOG = '[ibkr.adapter]'

// Gateway ports that designate a PAPER session (everything else is treated live).
const PAPER_PORTS = new Set([4002, 7497])

// Canonical app asset → IBKR contract spec for NON-equities (futures/indices), where
// the app symbol isn't a tradable IB ticker on its own. Equities/ETFs fall through to
// a SMART-routed US stock whose ticker IS the canonical symbol (AAPL → AAPL). This is
// the CFD-vs-real-instrument boundary: cTrader trades US100 (a CFD); IBKR trades the
// real NQ future, which must be qualified to a concrete front-month contract.
const IBKR_CONTRACTS = {
    NQ:  { secType: 'FUT', symbol: 'NQ',  exchange: 'CME',   currency: 'USD' },
    ES:  { secType: 'FUT', symbol: 'ES',  exchange: 'CME',   currency: 'USD' },
    RTY: { secType: 'FUT', symbol: 'RTY', exchange: 'CME',   currency: 'USD' },
    YM:  { secType: 'FUT', symbol: 'YM',  exchange: 'CBOT',  currency: 'USD' },
    CL:  { secType: 'FUT', symbol: 'CL',  exchange: 'NYMEX', currency: 'USD' },
    GC:  { secType: 'FUT', symbol: 'GC',  exchange: 'COMEX', currency: 'USD' },
}

// Unified timeframe label → IB historical request params.
const TIMEFRAME_MAP = {
    minutes: { duration: '1 D', barSize: BarSizeSetting.MINUTES_FIVE },
    hours:   { duration: '5 D', barSize: BarSizeSetting.HOURS_ONE },
    daily:   { duration: '1 Y', barSize: BarSizeSetting.DAYS_ONE },
    weekly:  { duration: '2 Y', barSize: BarSizeSetting.WEEKS_ONE },
    monthly: { duration: '5 Y', barSize: BarSizeSetting.MONTHS_ONE },
}

// Module-level cache of qualified contracts (conId is stable; adapter instances are
// created per-request by the factory, so an instance cache would never hit).
const _contractCache = new Map()   // canonicalAsset → qualified IB Contract

export class IBKRAdapter extends BrokerAdapter {

    brokerType  = 'ibkr'
    brokerLabel = 'IBKR'

    // ── Connection ───────────────────────────────────────────────────────────────

    /**
     * Connect this user to an IB Gateway / TWS by persisting its coordinates.
     * There is no OAuth redirect — the gateway is a local process the user logs
     * into themselves. Defaults target the paper gateway.
     * @param {string} userId
     * @param {{ host?: string, port?: number, clientId?: number }} [coords]
     */
    async connectGateway(userId, coords = {}) {
        const resolved = {
            host:     coords.host     ?? process.env.IBKR_GW_HOST     ?? '127.0.0.1',
            port:     Number(coords.port     ?? process.env.IBKR_GW_PORT     ?? 4002),
            clientId: Number(coords.clientId ?? process.env.IBKR_GW_CLIENTID ?? 1),
        }
        await brokerConnectionService.saveGatewayConnection(userId, 'ibkr', resolved)
        logger.info(LOG, `Gateway connection saved for user ${userId}: ${resolved.host}:${resolved.port}`)
        return resolved
    }

    getAuthUrl() {
        // IBKR connects via a local gateway, not an OAuth redirect.
        throw Object.assign(
            new Error('IBKR uses IB Gateway — call connectGateway() instead of OAuth'),
            { status: 400 }
        )
    }

    /**
     * Resolve the gateway coordinates stored for this user (env defaults otherwise).
     * Replaces the base-class _freshTokens(): IBKR has no tokens to refresh.
     * @param {string} userId
     * @returns {Promise<{ host: string, port: number, clientId: number }>}
     */
    async _coords(userId) {
        const conn = await brokerConnectionService.getConnection(userId, 'ibkr')
        return {
            host:     conn?.host     ?? process.env.IBKR_GW_HOST     ?? '127.0.0.1',
            port:     Number(conn?.port     ?? process.env.IBKR_GW_PORT     ?? 4002),
            clientId: Number(conn?.clientId ?? process.env.IBKR_GW_CLIENTID ?? 1),
        }
    }

    /** The shared gateway socket for this user's coordinates. */
    async _gateway(userId) {
        return getIBKRGateway(await this._coords(userId))
    }

    async isConnected(userId) {
        const conn = await brokerConnectionService.getConnection(userId, 'ibkr')
        if (!conn?.gateway && !process.env.IBKR_GW_HOST) return false
        try {
            const gw = await this._gateway(userId)
            await gw.ready
            return true
        } catch (err) {
            logger.warn(LOG, `Gateway not reachable for user ${userId}: ${err.message}`)
            return false
        }
    }

    // ── Account ──────────────────────────────────────────────────────────────────

    async getAccount(userId) {
        const gw   = await this._gateway(userId)
        const rows = await gw.reqAccountSummary('All')
        return _normaliseAccount(rows)
    }

    async getTradingAccounts(userId) {
        const coords = await this._coords(userId)
        const gw     = getIBKRGateway(coords)
        const rows   = await gw.reqAccountSummary('All')
        const isLive = !PAPER_PORTS.has(coords.port)

        const byAccount = new Map()
        for (const [account, tag, value, currency] of rows) {
            if (!byAccount.has(account)) byAccount.set(account, { currency: null, balance: null })
            const entry = byAccount.get(account)
            if (tag === 'NetLiquidation') { entry.balance = num(value); entry.currency = currency }
        }
        return [...byAccount.entries()].map(([id, { currency, balance }]) => ({
            id,
            login:    id,
            currency,
            balance,
            broker:   'Interactive Brokers',
            isLive,
        }))
    }

    // ── Contract qualification ───────────────────────────────────────────────────

    /**
     * Resolve a canonical app asset to a concrete, tradable IB Contract (conId set).
     * Futures resolve to the active front-month; equities to the SMART-routed US
     * listing. Cached module-wide (conId is stable). This is the only place the
     * CFD-vs-real-instrument difference lives — callers work in canonical symbols.
     * @param {string} userId
     * @param {string} canonicalAsset
     * @returns {Promise<object>} qualified IB Contract
     */
    async _qualify(userId, canonicalAsset) {
        const key = canonicalAsset.toUpperCase()
        if (_contractCache.has(key)) return _contractCache.get(key)

        const gw      = await this._gateway(userId)
        const spec    = IBKR_CONTRACTS[key] ?? { secType: 'STK', symbol: key, exchange: 'SMART', currency: 'USD' }
        const details = await gw.reqContractDetails(spec)
        if (!details.length) throw Object.assign(new Error(`IBKR: no contract for "${canonicalAsset}"`), { status: 404 })

        const chosen = spec.secType === 'FUT'
            ? _pickFrontMonth(details)
            : (details.find(d => ['NASDAQ', 'NYSE', 'ARCA', 'BATS', 'ISLAND'].includes(d.contract?.primaryExch))
               ?? details[0])

        const contract = chosen.contract
        _contractCache.set(key, contract)
        logger.info(LOG, `Qualified ${canonicalAsset} → conId ${contract.conId} (${contract.secType} ${contract.lastTradeDateOrContractMonth ?? contract.exchange})`)
        return contract
    }

    // ── Positions ────────────────────────────────────────────────────────────────

    async getPositions(userId) {
        const gw  = await this._gateway(userId)
        const raw = (await gw.reqPositions()).filter(p => p.pos !== 0)

        return Promise.all(raw.map(async ({ account, contract, pos, avgCost }) => {
            const multiplier = Number(contract.multiplier) || 1
            const pnlSnap    = await gw.reqPnlSingle(account, Number(contract.conId)).catch(() => null)
            const value      = pnlSnap?.value ?? null

            return {
                id:           String(contract.conId),
                symbol:       _toCanonical(contract),
                direction:    pos >= 0 ? 'long' : 'short',
                volume:       Math.abs(pos),
                // IB avgCost is per-contract incl. multiplier (futures); ÷ multiplier → price.
                entryPrice:   avgCost ? avgCost / multiplier : null,
                // market value = signed qty × multiplier × price ⇒ price = value / (qty × mult)
                currentPrice: value != null && pos !== 0 ? Math.abs(value / (pos * multiplier)) : null,
                pnl:          pnlSnap?.unrealizedPnL ?? null,
                pnlPips:      null,
                swap:         null,
                openedAt:     null,
                accountId:    account,
                accountNo:    account,
                currency:     contract.currency ?? null,
            }
        }))
    }

    // ── Candles (over the TWS socket — retires the old REST provider) ─────────────

    async getCandles(symbol, timeframe, count = 50, userId) {
        const tf = TIMEFRAME_MAP[timeframe] ?? TIMEFRAME_MAP.daily
        if (!TIMEFRAME_MAP[timeframe]) logger.warn(LOG, `Unknown timeframe "${timeframe}" — using daily`)

        const gw       = await this._gateway(userId)
        const contract = await this._qualify(userId, symbol)
        // Cash indices have no trades; everything we map (futures/equities) uses TRADES.
        const whatToShow = contract.secType === 'IND' ? WhatToShow.MIDPOINT : WhatToShow.TRADES

        const bars = await gw.reqHistoricalBars(contract, { ...tf, whatToShow })
        return bars.slice(-count)
    }

    capabilities() {
        // Trading flips on in Phase 4. ohlcv is now served over the socket.
        return {
            trading:          false,
            nativeProtection: false,
            modifyProtection: false,
            closePosition:    false,
            cancelOrder:      false,
            listOrders:       false,
            amendOrder:       false,
            ohlcv:            true,
        }
    }
}

// ─── Contract helpers ─────────────────────────────────────────────────────────

/**
 * Pick the active front-month from a future's ContractDetails list: the nearest
 * expiry that hasn't passed (falls back to the last if all appear expired).
 * @param {object[]} details
 */
function _pickFrontMonth(details) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')   // YYYYMMDD
    const dated = details
        .filter(d => d.contract?.lastTradeDateOrContractMonth)
        .sort((a, b) => String(a.contract.lastTradeDateOrContractMonth).localeCompare(String(b.contract.lastTradeDateOrContractMonth)))
    return dated.find(d => String(d.contract.lastTradeDateOrContractMonth) >= today) ?? dated.at(-1) ?? details[0]
}

/**
 * IBKR symbol → canonical app asset. IBKR trades real instruments whose IB symbol
 * already matches our canonical (NQ→NQ, AAPL→AAPL), so this is identity today — it
 * exists as the single seam to add aliasing later if a broker symbol ever diverges.
 * @param {object} contract  IB contract from a position
 */
function _toCanonical(contract) {
    return contract.symbol ?? contract.localSymbol ?? String(contract.conId)
}

// ─── Normalisers ──────────────────────────────────────────────────────────────

/**
 * Reduce IB accountSummary rows ([account, tag, value, currency]) to a BrokerAccount.
 */
function _normaliseAccount(rows) {
    const tags = {}
    let account = null
    let currency = 'USD'
    for (const [acct, tag, value, curr] of rows) {
        account = acct
        tags[tag] = value
        if (tag === 'NetLiquidation' && curr) currency = curr
    }
    return {
        id:          account,
        login:       account,
        broker:      'Interactive Brokers',
        currency,
        balance:     num(tags.TotalCashValue),
        equity:      num(tags.NetLiquidation),
        margin:      num(tags.InitMarginReq),
        freeMargin:  num(tags.AvailableFunds ?? tags.ExcessLiquidity),
        marginLevel: null,    // IBKR doesn't expose a margin level directly
        leverage:    null,
    }
}
