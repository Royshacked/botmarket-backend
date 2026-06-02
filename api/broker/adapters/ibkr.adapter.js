/**
 * Interactive Brokers (IBKR) broker adapter.
 * Implements BrokerAdapter using the IBKR Client Portal Web API.
 *
 * Key difference from cTrader: IBKR DOES support OHLCV via REST,
 * so getCandles() is implemented and returns real bars.
 *
 * Required env vars (add after registering at IBKR):
 *   IBKR_CLIENT_ID
 *   IBKR_CLIENT_SECRET
 *   IBKR_REDIRECT_URI   e.g. http://localhost:3030/api/broker/callback
 */

import { BrokerAdapter }           from './broker.interface.js'
import * as ibkr                   from '../../../providers/ibkr.provider.js'
import { brokerConnectionService } from '../brokerConnection.service.js'
import { logger }                  from '../../../services/logger.service.js'

const LOG = '[ibkr.adapter]'

// Map our unified timeframe labels → IBKR period + bar params
const TIMEFRAME_MAP = {
    minutes: { period: '1d',  bar: '5mins' },
    hours:   { period: '5d',  bar: '1h'    },
    daily:   { period: '1y',  bar: '1d'    },
    weekly:  { period: '2y',  bar: '1w'    },
    monthly: { period: '5y',  bar: '1m'    },
}

export class IBKRAdapter extends BrokerAdapter {

    // ── OAuth ──────────────────────────────────────────────────────────────────

    getAuthUrl(state) {
        return ibkr.getAuthUrl(state)
    }

    async handleCallback(code, userId) {
        const tokens = await ibkr.exchangeCode(code)
        await brokerConnectionService.saveConnection(userId, 'ibkr', tokens)
        logger.info(LOG, `Connection saved for user ${userId}`)
    }

    // ── Status ─────────────────────────────────────────────────────────────────

    async isConnected(userId) {
        const conn = await brokerConnectionService.getConnection(userId, 'ibkr')
        return !!conn?.refreshToken
    }

    // ── Account ────────────────────────────────────────────────────────────────

    async getAccount(userId) {
        const tokens    = await this._freshTokens(userId)
        const accountId = await this._resolveAccountId(userId, tokens)

        // Client Portal API: /portfolio/{accountId}/summary returns named fields
        const raw = await ibkr.get(`/portfolio/${accountId}/summary`, tokens)
        return _normaliseAccount(accountId, raw)
    }

    // ── Positions ──────────────────────────────────────────────────────────────

    async getPositions(userId) {
        const tokens    = await this._freshTokens(userId)
        const accountId = await this._resolveAccountId(userId, tokens)

        // Positions are paginated — page 0 is usually enough for most accounts
        const raw  = await ibkr.get(`/portfolio/${accountId}/positions/0`, tokens)
        const list = Array.isArray(raw) ? raw : []
        return list.map(_normalisePosition)
    }

    // ── Candles — supported via IBKR historical data API ──────────────────────

    async getCandles(symbol, timeframe, count = 50, userId) {
        const opts = TIMEFRAME_MAP[timeframe] ?? TIMEFRAME_MAP.daily
        if (!TIMEFRAME_MAP[timeframe]) {
            logger.warn(LOG, `Unknown timeframe "${timeframe}" — falling back to daily`)
        }

        const tokens = await this._freshTokens(userId)
        const bars   = await ibkr.getHistoricalBars(symbol, opts, tokens)
        return bars.slice(-count)
    }

    // ── Private ────────────────────────────────────────────────────────────────

    async _freshTokens(userId) {
        const conn = await brokerConnectionService.getConnection(userId, 'ibkr')
        if (!conn) {
            throw Object.assign(new Error('IBKR not connected'), { status: 401 })
        }

        const bufferMs = 60_000
        if (Date.now() + bufferMs >= conn.expiresAt) {
            logger.info(LOG, `Refreshing tokens for user ${userId}`)
            const fresh = await ibkr.refreshTokens(conn)
            await brokerConnectionService.updateTokens(userId, 'ibkr', fresh)
            return fresh
        }
        return conn
    }

    async _resolveAccountId(userId, tokens) {
        const cached = await brokerConnectionService.getAccountId(userId, 'ibkr')
        if (cached) return cached

        const accounts = await ibkr.get('/portfolio/accounts', tokens)
        const list     = Array.isArray(accounts) ? accounts : []
        if (list.length === 0) throw new Error('No IBKR accounts found')

        const accountId = String(list[0].accountId ?? list[0].id)
        await brokerConnectionService.setAccountId(userId, 'ibkr', accountId)
        logger.info(LOG, `Account ID ${accountId} cached for user ${userId}`)
        return accountId
    }
}

// ─── Normalisers ──────────────────────────────────────────────────────────────

function _normaliseAccount(accountId, raw) {
    // Client Portal summary returns { fieldName: { amount, currency, ... }, ... }
    const get = key => _num(raw[key]?.amount ?? raw[key])
    return {
        id:          accountId,
        login:       accountId,
        broker:      'Interactive Brokers',
        currency:    raw.totalcashvalue?.currency ?? raw.netliquidation?.currency ?? 'USD',
        balance:     get('totalcashvalue'),
        equity:      get('netliquidation'),
        margin:      get('initmarginreq'),
        freeMargin:  get('excessliquidity'),
        marginLevel: null,    // IBKR doesn't expose margin level directly
        leverage:    null,
    }
}

function _normalisePosition(raw) {
    return {
        id:           String(raw.conid ?? raw.position),
        symbol:       raw.contractDesc ?? raw.ticker ?? raw.symbol,
        direction:    Number(raw.position) >= 0 ? 'long' : 'short',
        volume:       Math.abs(_num(raw.position)),
        entryPrice:   _num(raw.avgCost ?? raw.avgPrice),
        currentPrice: _num(raw.mktPrice),
        pnl:          _num(raw.unrealizedPnl),
        pnlPips:      null,
        swap:         null,
        openedAt:     null,
    }
}

function _num(v) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
}
