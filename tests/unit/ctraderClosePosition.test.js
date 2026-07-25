import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CTraderAdapter } from '../../api/broker/adapters/ctrader.adapter.js'
import { executionBus } from '../../services/executionBus.js'

// G4 regression — a cTrader partial close (trim) must convert the requested LOTS into native
// volume (× lotSize, step-aligned), exactly like placeOrder. The prior bug forwarded the lot
// count straight through as native volume, closing a tiny fraction of the intended size.

// A fake cTrader session: answers RECONCILE with one position (300 native units, symbolId 42,
// lotSize 100), records every send, and resolves specs deterministically.
function fakeSession({ totalVolume = 300 } = {}) {
    const sends = []
    return {
        ctid: 'ctid1',
        _sends: sends,
        async send(type, payload) {
            sends.push({ type, payload })
            const isReconcile = payload && Object.keys(payload).length === 0
            if (isReconcile) {
                return { position: [{ positionId: 555, tradeData: { volume: totalVolume, symbolId: 42 } }], order: [] }
            }
            return {}   // CLOSE_POSITION / CANCEL_ORDER ack
        },
        async _loadSymbols() { return new Map() },
        symbolNameById() { return 'BTCUSD' },
        async _symbolSpecs() { return { lotSize: 100, stepVolume: 1, minVolume: 1, maxVolume: 100000 } },
    }
}

function adapterWith(session) {
    const a = new CTraderAdapter()
    a._session = async () => session
    a._wireExecutionFeed = () => {}
    return a
}

// Capture executionBus 'execution' events during fn(), then detach.
async function withCapturedEvents(fn) {
    const events = []
    const cb = (e) => events.push(e)
    executionBus.on('execution', cb)
    try { await fn() } finally { executionBus.off('execution', cb) }
    return events
}

const closeSend = (session) => session._sends.find(s => s.payload && 'positionId' in s.payload && 'volume' in s.payload)

test('partial trim converts 2 lots → 200 native volume (not the raw 2), and does not self-emit', async () => {
    const session = fakeSession({ totalVolume: 300 })
    const adapter = adapterWith(session)
    const events = await withCapturedEvents(() => adapter.closePosition('u1', 'acc1', 555, { quantity: 2 }))

    const sent = closeSend(session)
    assert.equal(sent.payload.volume, 200)                 // 2 lots × lotSize 100 — the fix
    assert.notEqual(sent.payload.volume, 2)                // the old bug
    assert.equal(events.length, 0)                         // partial relies on the real reduce fill
})

test('full close (no quantity) sends the position native volume and emits position.closed', async () => {
    const session = fakeSession({ totalVolume: 300 })
    const adapter = adapterWith(session)
    const events = await withCapturedEvents(() => adapter.closePosition('u1', 'acc1', 555, {}))

    assert.equal(closeSend(session).payload.volume, 300)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'position.closed')
    assert.equal(events[0].positionId, '555')
})

test('a trim whose converted size meets/exceeds the whole position is treated as a full close', async () => {
    const session = fakeSession({ totalVolume: 300 })
    const adapter = adapterWith(session)
    // 5 lots × 100 = 500 native > 300 total → clamp to 300, emit closed.
    const events = await withCapturedEvents(() => adapter.closePosition('u1', 'acc1', 555, { quantity: 5 }))

    assert.equal(closeSend(session).payload.volume, 300)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'position.closed')
})

test('unknown position id throws (nothing to close)', async () => {
    const session = fakeSession()
    session.send = async (type, payload) =>
        (payload && Object.keys(payload).length === 0) ? { position: [], order: [] } : {}
    const adapter = adapterWith(session)
    await assert.rejects(() => adapter.closePosition('u1', 'acc1', 999, { quantity: 2 }), /not found/)
})
