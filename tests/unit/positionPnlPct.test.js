import { test } from 'node:test'
import assert from 'node:assert/strict'
import { positionPnlPct } from '../../services/agentUtils.js'

// The raw BrokerPosition carries no P&L %, so every surface that shows one derives it here.
// Today that is tradingContext.service, which serves it to the agents via get_trading_context.
// (This file is what survives positionsSection.test.js — buildPositionsSection was retired when
// the injected live-book block gave way to the venue TOOLS.)

test('positionPnlPct: long = price move, short = sign-flipped', () => {
    assert.equal(positionPnlPct({ direction: 'long',  entryPrice: 100, currentPrice: 110 }), 10)
    assert.equal(positionPnlPct({ direction: 'short', entryPrice: 200, currentPrice: 190 }), 5)
    assert.equal(positionPnlPct({ direction: 'short', entryPrice: 200, currentPrice: 210 }), -5)
})

test('positionPnlPct: null when prices missing or entry is zero', () => {
    assert.equal(positionPnlPct({ direction: 'long', entryPrice: 0,   currentPrice: 110 }), null)
    assert.equal(positionPnlPct({ direction: 'long', entryPrice: 100 }), null)
    assert.equal(positionPnlPct({}), null)
    assert.equal(positionPnlPct(null), null)
})
