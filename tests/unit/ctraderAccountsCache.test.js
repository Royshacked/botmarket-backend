import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { CTraderAdapter, _resetCTraderAdapterCaches } from '../../api/broker/adapters/ctrader.adapter.js'
import { brokerConnectionService } from '../../api/broker/brokerConnection.service.js'

// Two reads that used to happen on EVERY adapter operation: REST /tradingaccounts (three sites in
// the adapter, one REST round-trip each) and the (user, accountId) → ctid resolution in _session
// (a ProtoOA socket round-trip before every positions poll, order and candle read). Both answers
// are facts about the connection that do not move, so they are cached — a minute and ten minutes —
// and dropped on a reconnect, which is the one moment they are known to be wrong.
//
// Only the REST half is asserted here. The ctid half resolves through the session provider's named
// exports, which have no method seam on the adapter yet; it is the same TTL cache, exercised below.

beforeEach(_resetCTraderAdapterCaches)

const ROWS = [{ id: 'A1', traderLogin: 111, balance: 5000, depositCurrency: 'USD', brokerName: 'x', isLive: false }]

/** The adapter's provider calls are methods — the seam ctraderClosePosition.test already uses for _session. */
function adapterWith({ rows = ROWS } = {}) {
    const a = new CTraderAdapter()
    const calls = { tokens: 0, rest: 0 }
    a._freshTokens  = async () => { calls.tokens++; return { accessToken: 't' } }
    a._restGet      = async () => { calls.rest++; return rows }
    a._exchangeCode = async () => ({ accessToken: 'new', refreshToken: 'r', expiresIn: 3600 })
    return { a, calls }
}

test('three account reads inside a minute cost one REST round-trip', async () => {
    const { a, calls } = adapterWith()
    await a.getTradingAccounts('u1')
    await a.getTradingAccounts('u1')
    const list = await a.getTradingAccounts('u1')
    assert.equal(calls.rest, 1)
    assert.equal(calls.tokens, 3, 'the token is still refreshed per call — only the REST read is cached')
    assert.equal(list[0].id, 'A1')
})

test('the cache is per user — one user’s accounts are never another’s', async () => {
    const { a, calls } = adapterWith()
    await a.getTradingAccounts('u1')
    await a.getTradingAccounts('u2')
    assert.equal(calls.rest, 2)
})

test('a reconnect drops the cached accounts — a new grant can carry a different set', async () => {
    const { a, calls } = adapterWith()
    const realSave = brokerConnectionService.saveConnection
    brokerConnectionService.saveConnection = async () => {}
    try {
        await a.getTradingAccounts('u1')
        assert.equal(calls.rest, 1)
        await a.handleCallback('code', 'u1')
        await a.getTradingAccounts('u1')
        assert.equal(calls.rest, 2, 'the read after the reconnect goes to the broker again')
    } finally { brokerConnectionService.saveConnection = realSave }
})
