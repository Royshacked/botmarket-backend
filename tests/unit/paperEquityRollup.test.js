import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollUpPositions } from '../../api/broker/paperExecution.service.js'

// Equity READS the mark the mark loop wrote; it does not fetch its own quotes. That loop is the one
// writer of `currentPrice` and refreshes every open symbol on its own cadence, so a P&L readout is
// at most one interval stale — while `getAccount`, which the client polls, no longer costs one FMP
// request per open position per poll. Measured before the change: ~40-55 of a ~130 req/min budget
// re-fetching prices already written to the DB.

const pos = (over = {}) => ({ avgPrice: 100, qty: 10, direction: 'long', currentPrice: 110, ...over })

test('a long marks up, a short marks down, off the STORED price', () => {
    assert.equal(rollUpPositions([pos()]).unrealized, 100)                                  // (110-100)*10
    assert.equal(rollUpPositions([pos({ direction: 'short' })]).unrealized, -100)
    assert.equal(rollUpPositions([pos({ currentPrice: 90 })]).unrealized, -100)
    assert.equal(rollUpPositions([pos({ currentPrice: 90, direction: 'short' })]).unrealized, 100)
})

test('exposure is entry-priced, never mark-priced — the mark moves, the commitment does not', () => {
    assert.equal(rollUpPositions([pos({ currentPrice: 999 })]).marginUsed, 1000)
    // A short is exposure too: the absolute notional, not a negative one that would net away.
    assert.equal(rollUpPositions([pos({ direction: 'short' })]).marginUsed, 1000)
})

test('several positions sum, including across symbols and sides', () => {
    const r = rollUpPositions([
        pos(),                                                    // +100
        pos({ direction: 'short', currentPrice: 95 }),            // +50
        pos({ avgPrice: 50, qty: 4, currentPrice: 45 }),          // -20
    ])
    assert.equal(r.unrealized, 130)
    assert.equal(r.marginUsed, 1000 + 1000 + 200)
})

// The only case the removed live fetch used to cover. openPosition now seeds the mark with the fill
// price, so this is a legacy row — it must contribute nothing rather than NaN the whole account.
test('an unmarked position contributes no P&L but still counts as exposure', () => {
    const r = rollUpPositions([pos({ currentPrice: undefined }), pos()])
    assert.equal(r.unrealized, 100, 'only the marked one moves the number')
    assert.equal(r.marginUsed, 2000, 'both are still committed capital')
})

test('a null or non-finite mark cannot poison the roll-up', () => {
    for (const bad of [null, undefined, NaN, Infinity, 'abc']) {
        const r = rollUpPositions([pos({ currentPrice: bad })])
        assert.equal(r.unrealized, 0, `currentPrice=${String(bad)} must not produce NaN`)
        assert.ok(Number.isFinite(r.unrealized))
    }
})

test('no positions is zero, not a crash', () => {
    assert.deepEqual(rollUpPositions([]), { unrealized: 0, marginUsed: 0 })
    assert.deepEqual(rollUpPositions(), { unrealized: 0, marginUsed: 0 })
})
