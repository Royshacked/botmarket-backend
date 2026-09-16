import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { CTraderAdapter } from '../../api/broker/adapters/ctrader.adapter.js'
import { BROKER_DISCONNECTED } from '../../api/broker/adapters/broker.interface.js'
import { brokerConnectionService } from '../../api/broker/brokerConnection.service.js'
import { errorHandler } from '../../api/_shared/handle.util.js'

// A missing or unrefreshable BROKER session used to throw `status: 401`. 401 is the APP's login
// code: the client clears the session and leaves the page on any 401, so an expired cTrader token
// on the positions poll logged the user out of the app. It answers 424 (Failed Dependency) now —
// the broker is a dependency that failed, not the user's login.

const real = { getConnection: brokerConnectionService.getConnection, updateTokens: brokerConnectionService.updateTokens }
afterEach(() => Object.assign(brokerConnectionService, real))

test('BROKER_DISCONNECTED is not the app auth code', () => {
    assert.equal(BROKER_DISCONNECTED, 424)
    assert.notEqual(BROKER_DISCONNECTED, 401)
})

test('no saved connection → 424, never 401', async () => {
    brokerConnectionService.getConnection = async () => null
    await assert.rejects(
        () => new CTraderAdapter()._freshTokens('u1'),
        err => err.status === BROKER_DISCONNECTED && /not connected/.test(err.message),
    )
})

test('the 424 REACHES the client as 424 with its sentence — in production too', async () => {
    // The adapter asserting its own status is not the same as the user seeing it: the error handler
    // answers only a MINTED status, and a bare `{ status: 424 }` would have been a 500 "Internal
    // server error" on every positions poll, the "reconnect" hint gone (CR on §9).
    brokerConnectionService.getConnection = async () => null
    const saved = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
        const err = await new CTraderAdapter()._freshTokens('u1').then(() => null, e => e)
        const res = { statusCode: 200, body: null, headersSent: false }
        res.status = c => { res.statusCode = c; return res }
        res.json   = b => { res.body = b; return res }
        errorHandler(err, { method: 'GET', originalUrl: '/api/broker/ctrader/positions' }, res, () => {})
        assert.equal(res.statusCode, 424)
        assert.match(res.body.error, /not connected/)
    } finally {
        if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved
    }
})

test('a refresh that fails → 424, never 401', async () => {
    brokerConnectionService.getConnection = async () => ({ refreshToken: 'r', expiresAt: Date.now() - 1 })
    const adapter = new CTraderAdapter()
    adapter.provider = { refreshTokens: async () => { throw new Error('invalid_grant') } }
    await assert.rejects(
        () => adapter._freshTokens('u1'),
        err => err.status === BROKER_DISCONNECTED && /reconnect/.test(err.message),
    )
})

test('a live token is returned as-is; a near-expiry one is refreshed and persisted', async () => {
    const live = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 10 * 60_000 }
    brokerConnectionService.getConnection = async () => live
    assert.equal(await new CTraderAdapter()._freshTokens('u1'), live)

    const saved = []
    brokerConnectionService.getConnection = async () => ({ ...live, expiresAt: Date.now() + 10_000 })   // inside the 60s buffer
    brokerConnectionService.updateTokens  = async (...a) => { saved.push(a) }
    const adapter = new CTraderAdapter()
    adapter.provider = { refreshTokens: async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 3600 }) }
    const fresh = await adapter._freshTokens('u1')
    assert.equal(fresh.accessToken, 'a2')
    assert.equal(saved.length, 1)
    assert.equal(saved[0][1], 'ctrader')
})
