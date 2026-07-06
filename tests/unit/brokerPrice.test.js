import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    realReferenceTicker,
    cashIndexTicker,
    applyOffset,
    computeBasisOffset,
} from '../../api/broker/brokerPrice.service.js'

test('realReferenceTicker maps index futures to their Yahoo futures ticker', () => {
    assert.equal(realReferenceTicker('NQ'),  'NQ=F')
    assert.equal(realReferenceTicker('ES'),  'ES=F')
    assert.equal(realReferenceTicker('YM'),  'YM=F')
    assert.equal(realReferenceTicker('RTY'), 'RTY=F')
    assert.equal(realReferenceTicker('nq'),  'NQ=F')   // normalised
})

test('cashIndexTicker maps index futures to their Yahoo cash index', () => {
    assert.equal(cashIndexTicker('NQ'),  '^NDX')
    assert.equal(cashIndexTicker('ES'),  '^GSPC')
    assert.equal(cashIndexTicker('YM'),  '^DJI')
    assert.equal(cashIndexTicker('RTY'), '^RUT')
    assert.equal(cashIndexTicker('AAPL'), null)   // no cash index → no conversion
})

test('realReferenceTicker returns null for anything without a mapped real reference', () => {
    assert.equal(realReferenceTicker('AAPL'), null)
    assert.equal(realReferenceTicker(''), null)
    assert.equal(realReferenceTicker('US100'), null)   // broker name, not a canonical asset
})

test('applyOffset shifts a real-authored price into broker space', () => {
    assert.equal(applyOffset(29900, -246.94), 29653.06)
    assert.equal(applyOffset(100, 0), 100)             // zero offset = identity
    assert.equal(applyOffset(null, 5), null)           // non-numeric passes through
    assert.equal(applyOffset(undefined, 5), undefined)
})

// computeBasisOffset early returns before any network I/O — unit-testable.

test('computeBasisOffset is identity for a non-aliased instrument', async () => {
    const res = await computeBasisOffset({ brokerSymbol: 'AAPL', asset: 'AAPL' })
    assert.deepEqual(res, { offset: 0, reason: 'not_aliased' })
})

test('computeBasisOffset is identity when aliased but not a convertible instrument', async () => {
    // e.g. an aliased commodity/CFD with no cash-index mapping → no basis to convert
    const res = await computeBasisOffset({ brokerSymbol: 'USOIL', asset: 'CL' })
    assert.deepEqual(res, { offset: 0, reason: 'no_conversion' })
})
