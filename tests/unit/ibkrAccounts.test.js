import { test } from 'node:test'
import assert from 'node:assert/strict'

import { accountsFromSummary } from '../../api/broker/adapters/ibkr.adapter.js'

// IB's accountSummary is a flat list of [account, tag, value, currency] rows across EVERY account
// the gateway login holds. The single-account read used to fold them all into one bag — the last
// account's id, the tags merged — while the list read grouped them correctly two functions up. One
// parse now, and both reads use it.

const rows = [
    ['U111', 'NetLiquidation', '100000', 'USD'],
    ['U111', 'TotalCashValue', '40000',  'USD'],
    ['U111', 'AvailableFunds', '38000',  'USD'],
    ['U111', 'InitMarginReq',  '2000',   'USD'],
    ['U222', 'NetLiquidation', '5000',   'EUR'],
    ['U222', 'TotalCashValue', '5000',   'EUR'],
    ['U222', 'ExcessLiquidity', '4900',  'EUR'],   // no AvailableFunds → the fallback
]

test('two accounts stay two accounts — nothing of one leaks into the other', () => {
    const [a, b] = accountsFromSummary(rows)
    assert.equal(a.id, 'U111'); assert.equal(a.currency, 'USD')
    assert.equal(a.balance, 40000, 'balance is CASH (TotalCashValue)')
    assert.equal(a.equity, 100000, 'equity is net liquidation')
    assert.equal(a.freeMargin, 38000)
    assert.equal(a.margin, 2000)
    assert.equal(b.id, 'U222'); assert.equal(b.currency, 'EUR')
    assert.equal(b.balance, 5000); assert.equal(b.equity, 5000)
    assert.equal(b.freeMargin, 4900, 'ExcessLiquidity is the fallback when AvailableFunds is absent')
    assert.equal(b.margin, null)
})

test('order is the gateway\'s, and the first is what getAccount answers', () => {
    assert.deepEqual(accountsFromSummary(rows).map(a => a.id), ['U111', 'U222'])
})

test('no rows → no accounts; a row with no account id is dropped, not merged', () => {
    assert.deepEqual(accountsFromSummary([]), [])
    assert.deepEqual(accountsFromSummary(null), [])
    assert.equal(accountsFromSummary([[null, 'NetLiquidation', '1', 'USD'], ...rows]).length, 2)
})

test('currency defaults to USD only when the gateway gave none', () => {
    const [a] = accountsFromSummary([['U1', 'TotalCashValue', '10', null]])
    assert.equal(a.currency, 'USD')
})
