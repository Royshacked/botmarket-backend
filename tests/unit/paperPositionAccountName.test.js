import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PaperAdapter } from '../../api/broker/adapters/paper.adapter.js'

// A virtual account is one the USER named ("Momentum", "RAZ TEST"); its accountId is a generated
// key (`paper-<userId>-<short>`). Every positions surface identified a paper account by that key —
// forty characters of uuid where a name was meant to be. The account doc was already being read
// here to give the position its own currency, so the name rides along on the same read: no extra
// query, and the frontend gets to decide which of the two to show (positionAccountLabel).

const adapter = new PaperAdapter()
const raw = {
    positionId: 'pp1', symbol: 'NVDA', direction: 'long', qty: 10,
    avgPrice: 100, openedAt: 1_700_000_000_000, accountId: 'paper-u1-f695aff1',
}

test('a position carries its account NAME beside the generated id', () => {
    const p = adapter._toBrokerPosition(raw, 110, { name: 'Momentum', currency: 'USD' })
    assert.equal(p.accountName, 'Momentum')
    assert.equal(p.accountId,   'paper-u1-f695aff1', 'the id is still the key that routes')
    assert.equal(p.accountNo,   'paper-u1-f695aff1', 'and the broker field is unchanged')
})

test('the account read still gives the position its own currency', () => {
    assert.equal(adapter._toBrokerPosition(raw, 110, { name: 'Stable', currency: 'EUR' }).currency, 'EUR')
    assert.equal(adapter._toBrokerPosition(raw, 110, { name: 'Stable' }).currency, 'USD', 'default')
})

test('an unreadable account is a nameless position, never a throw', () => {
    for (const acct of [null, undefined, {}]) {
        const p = adapter._toBrokerPosition(raw, 110, acct)
        assert.equal(p.accountName, null)
        assert.equal(p.currency, 'USD')
        assert.equal(p.id, 'pp1', 'the position itself still reports')
    }
})

test('naming a position does not disturb what it is worth', () => {
    const p = adapter._toBrokerPosition(raw, 110, { name: 'Momentum', currency: 'USD' })
    assert.equal(p.pnl, 100, '(110 - 100) × 10 long')
    assert.equal(p.currentPrice, 110)
    assert.equal(adapter._toBrokerPosition(raw, null, null).pnl, null, 'unpriced stays unpriced')
})
