/**
 * cTrader broker adapter.
 * Implements BrokerAdapter using the cTrader Open API (Spotware).
 *
 * Note on candles: cTrader's OHLCV data lives on the ProtoOA WebSocket
 * protocol, NOT on the REST API we use here. So getCandles() returns null
 * and the monitoring system falls back to Massive/Polygon.
 */

import { BrokerAdapter }           from './broker.interface.js'
import * as ctrader                from '../../../providers/ctrader.provider.js'
import { brokerConnectionService } from '../brokerConnection.service.js'
import { logger }                  from '../../../services/logger.service.js'

const LOG = '[ctrader.adapter]'

export class CTraderAdapter extends BrokerAdapter {

    // ── OAuth ──────────────────────────────────────────────────────────────────

    getAuthUrl(state) {
        return ctrader.getAuthUrl(state)
    }

    async handleCallback(code, userId) {
        const tokens = await ctrader.exchangeCode(code)
        await brokerConnectionService.saveConnection(userId, 'ctrader', tokens)
        logger.info(LOG, `Connection saved for user ${userId}`)
    }

    // ── Status ─────────────────────────────────────────────────────────────────

    async isConnected(userId) {
        const conn = await brokerConnectionService.getConnection(userId, 'ctrader')
        return !!conn?.refreshToken
    }

    // ── Account ────────────────────────────────────────────────────────────────

    async getAccount(userId) {
        const tokens    = await this._freshTokens(userId)
        const accountId = await this._resolveAccountId(userId, tokens)
        const raw       = await ctrader.get(`/tradingaccounts/${accountId}`, tokens)
        return _normaliseAccount(raw)
    }

    // ── Positions ──────────────────────────────────────────────────────────────

    async getPositions(userId) {
        const tokens    = await this._freshTokens(userId)
        const accountId = await this._resolveAccountId(userId, tokens)
        const raw       = await ctrader.get(`/tradingaccounts/${accountId}/positions`, tokens)
        const list      = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
        return list.map(_normalisePosition)
    }

    // ── Trading accounts ───────────────────────────────────────────────────────

    async getTradingAccounts(userId) {
        const tokens = await this._freshTokens(userId)
        const raw    = await ctrader.get('/tradingaccounts', tokens)
        const list   = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
        return list.map(_normaliseTradingAccount)
    }

    // ── Candles — not supported via REST ──────────────────────────────────────
    // Returns null → caller falls back to Massive/Polygon
    async getCandles() { return null }

    // ── Private ────────────────────────────────────────────────────────────────

    /** Return valid tokens for this user, refreshing if within 60s of expiry. */
    async _freshTokens(userId) {
        const conn = await brokerConnectionService.getConnection(userId, 'ctrader')
        if (!conn) {
            throw Object.assign(new Error('cTrader not connected'), { status: 401 })
        }

        const bufferMs = 60_000
        if (Date.now() + bufferMs >= conn.expiresAt) {
            logger.info(LOG, `Refreshing tokens for user ${userId}`)
            const fresh = await ctrader.refreshTokens(conn)
            await brokerConnectionService.updateTokens(userId, 'ctrader', fresh)
            return fresh
        }
        return conn
    }

    /** Resolve the user's primary trading account ID, caching in DB. */
    async _resolveAccountId(userId, tokens) {
        const cached = await brokerConnectionService.getAccountId(userId, 'ctrader')
        if (cached) return cached

        const raw  = await ctrader.get('/tradingaccounts', tokens)
        const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
        if (list.length === 0) throw new Error('No cTrader trading accounts found')

        const accountId = String(list[0].id ?? list[0].accountId)
        await brokerConnectionService.setAccountId(userId, 'ctrader', accountId)
        logger.info(LOG, `Account ID ${accountId} cached for user ${userId}`)
        return accountId
    }
}

// ─── Normalisers ──────────────────────────────────────────────────────────────

function _normaliseAccount(raw) {
    return {
        id:          raw.id          ?? raw.accountId,
        login:       raw.traderLogin ?? raw.login     ?? raw.accountNumber,
        broker:      raw.brokerName  ?? raw.broker,
        currency:    raw.depositCurrency ?? raw.currency,
        balance:     _num(raw.balance),
        equity:      _num(raw.equity),
        margin:      _num(raw.margin  ?? raw.usedMargin),
        freeMargin:  _num(raw.freeMargin),
        marginLevel: _num(raw.marginLevel),
        leverage:    raw.leverage,
    }
}

function _normalisePosition(raw) {
    return {
        id:           raw.id ?? raw.positionId,
        symbol:       raw.symbolName ?? raw.symbol,
        direction:    (raw.tradeSide ?? raw.side)?.toLowerCase() === 'sell' ? 'short' : 'long',
        volume:       _num(raw.volume),
        entryPrice:   _num(raw.entryPrice ?? raw.openPrice),
        currentPrice: _num(raw.currentPrice),
        pnl:          _num(raw.pnl ?? raw.grossProfit),
        pnlPips:      _num(raw.pnlPips),
        swap:         _num(raw.swap),
        openedAt:     raw.openTimestamp ?? raw.createTimestamp,
    }
}

function _normaliseTradingAccount(raw) {
    return {
        id:       String(raw.id ?? raw.accountId ?? ''),
        login:    raw.traderLogin ?? raw.login ?? raw.accountNumber ?? null,
        currency: raw.depositCurrency ?? raw.currency ?? null,
        balance:  _num(raw.balance),
        broker:   raw.brokerName ?? raw.broker ?? null,
        isLive:   !!(raw.isLive ?? !raw.isDemo),
    }
}

function _num(v) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
}
