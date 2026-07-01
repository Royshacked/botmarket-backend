import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toBrokerSymbol, toAppAsset } from '../../services/brokerSymbol.service.js'

test('cTrader index-future aliases map and round-trip', () => {
    // NQ (canonical app asset) ↔ US100 (cTrader cash CFD)
    const brokerSym = toBrokerSymbol('ctrader', 'NQ')
    assert.notEqual(brokerSym, 'NQ')                       // genuinely renamed
    assert.equal(toAppAsset('ctrader', brokerSym), 'NQ')   // reverse restores canonical
})

test('non-aliased symbols resolve by identity', () => {
    assert.equal(toBrokerSymbol('ctrader', 'EURUSD'), 'EURUSD')
    assert.equal(toAppAsset('ctrader', 'EURUSD'), 'EURUSD')
})

test('paper broker uses canonical symbols unchanged', () => {
    assert.equal(toBrokerSymbol('paper', 'NQ'), 'NQ')
})
