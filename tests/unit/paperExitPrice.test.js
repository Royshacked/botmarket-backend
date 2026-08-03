import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exitMarkPrice } from '../../api/broker/paperExecution.service.js'

// An EXIT is not a trigger. latestMarkPrice deliberately refuses a day candle because it also
// answers "did price touch this level" — a stale close there would fire a TP against a level the
// market never reached. Booking a close/trim that has ALREADY been decided is the opposite case:
// refusing leaves a position nobody can get out of. It did exactly that — an FMP 429 on the 1-min
// feed turned every paper close into a 500 ("paper: no price for ZTS") while a good day close sat
// one call away, and it took a monitor's stop down the same way.
//
// So exitMarkPrice degrades: live → day close → the last mark stamped on the position, and only
// gives up when nothing prices the symbol at all. `source` comes back so a degraded fill can say so.

const deps = (live, last) => ({ live: async () => live, last: async () => last })

test('prefers the live quote, and never asks for the fallback when it has one', async () => {
    let dayFetched = false
    const res = await exitMarkPrice('ZTS', 70, {
        live: async () => 77.29,
        last: async () => { dayFetched = true; return 60 },
    })
    assert.deepEqual(res, { price: 77.29, source: 'live' })
    assert.equal(dayFetched, false, 'a good live quote must not cost a second provider call')
})

test('falls back to the day close when the intraday feed is down (the 429 case)', async () => {
    assert.deepEqual(await exitMarkPrice('ZTS', 70, deps(null, 77.29)), { price: 77.29, source: 'day' })
})

test('falls back to the position’s last stamped mark when nothing else resolves', async () => {
    assert.deepEqual(await exitMarkPrice('ZTS', 70.5, deps(null, null)), { price: 70.5, source: 'mark' })
})

test('gives up only when the symbol has no price at all', async () => {
    assert.deepEqual(await exitMarkPrice('ZTS', null, deps(null, null)), { price: null, source: null })
})

// A zero / negative / NaN price is not a price. Booking an exit at 0 would bank the entire notional
// as a loss, which is worse than the 500 this replaced.
test('treats a non-positive or non-finite price as absent at every tier', async () => {
    assert.deepEqual(await exitMarkPrice('ZTS', null, deps(0, 77.29)),        { price: 77.29, source: 'day' })
    assert.deepEqual(await exitMarkPrice('ZTS', null, deps(NaN, 77.29)),      { price: 77.29, source: 'day' })
    assert.deepEqual(await exitMarkPrice('ZTS', null, deps(-5, 77.29)),       { price: 77.29, source: 'day' })
    assert.deepEqual(await exitMarkPrice('ZTS', 0,    deps(null, null)),      { price: null,  source: null })
    assert.deepEqual(await exitMarkPrice('ZTS', 70,   deps(null, 0)),         { price: 70,    source: 'mark' })
})

test('stamped mark defaults to absent, so callers may omit it', async () => {
    assert.deepEqual(await exitMarkPrice('ZTS', undefined, deps(null, null)), { price: null, source: null })
})
