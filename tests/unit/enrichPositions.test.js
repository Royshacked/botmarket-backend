import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _enrichPositions } from '../../api/trade-ideas/tradeIdeas.service.js'

// WHAT THE TRADE TIER KNOWS ABOUT A BROKER'S POSITIONS.
//
// A broker hands back positions and knows nothing about what the app authored. Two answers only
// this tier can give get stamped on: the DECLARED asset class (the client's market-hours gate is
// exact instead of guessing from the symbol, which cannot tell a forex pair from a stock) and the
// owning callId (a call's execution is hidden from the ideas list, so its position row had no
// resolvable owner and clicking it was a dead no-op).
//
// The join lived inline in broker.controller, where it could not be tested without a controller —
// §1 flagged it as a cross-feature enrichment with no home, and §4 placed it here.

const deps = ({ classes = {}, calls = {} } = {}) => ({
    assetClasses: async () => classes,
    callPositions: async () => calls,
})

const pos = (over = {}) => ({ id: 'p1', accountId: 'a1', symbol: 'EURUSD', volume: 1, ...over })

test('stamps the authored asset class, matched on the normalised symbol', async () => {
    const out = await _enrichPositions('u1', 'ctrader', [pos()], deps({ classes: { EURUSD: 'forex' } }))
    assert.equal(out[0].assetClass, 'forex')
})

// Null, not a guess: null is the signal the client falls back to its symbol heuristic on. Inventing
// a class here would silently override that with something nobody authored.
test('a position no idea matches gets a null class, not a guess', async () => {
    const out = await _enrichPositions('u1', 'ctrader', [pos({ symbol: 'NVDA' })], deps({ classes: { EURUSD: 'forex' } }))
    assert.equal(out[0].assetClass, null)
})

// A class the BROKER already stated is the broker's own answer about its own instrument.
test('a class the broker already stated is not overwritten', async () => {
    const out = await _enrichPositions('u1', 'ctrader', [pos({ assetClass: 'cfd' })], deps({ classes: { EURUSD: 'forex' } }))
    assert.equal(out[0].assetClass, 'cfd')
})

test('stamps the owning callId, keyed broker:account:position', async () => {
    const out = await _enrichPositions('u1', 'ctrader', [pos()], deps({ calls: { 'ctrader:a1:p1': 'call_9' } }))
    assert.equal(out[0].callId, 'call_9')
})

// The key includes the BROKER, so the same position id at a different venue is a different row.
test('a call map entry for another broker does not match', async () => {
    const out = await _enrichPositions('u1', 'paper', [pos()], deps({ calls: { 'ctrader:a1:p1': 'call_9' } }))
    assert.equal(out[0].callId, null)
})

test('an empty position list costs no reads at all', async () => {
    let asked = 0
    const counting = { assetClasses: async () => { asked++; return {} }, callPositions: async () => { asked++; return {} } }
    assert.deepEqual(await _enrichPositions('u1', 'ctrader', [], counting), [])
    assert.equal(asked, 0)
})

// The positions are the answer; the enrichment is a bonus. A map that could not be read must leave
// the rows intact rather than failing the whole positions call.
test('an unreadable map leaves the positions themselves untouched', async () => {
    const out = await _enrichPositions('u1', 'ctrader', [pos()], {
        assetClasses:  async () => ({}),
        callPositions: async () => ({}),
    })
    assert.equal(out.length, 1)
    assert.equal(out[0].symbol, 'EURUSD')
    assert.equal(out[0].volume, 1)
})
