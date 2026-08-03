import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entryMarkPrice } from '../../api/broker/paperExecution.service.js'

// The entry counterpart of exitMarkPrice, and deliberately NOT its twin.
//
// An exit degrades (live → day close → last mark) because the decision is already made and
// refusing strands a position nobody can get out of. An entry sets the COST BASIS — every P&L
// number, every R multiple, every ledger line is measured from it — so a stale print here
// misstates the trade for its whole life. Refusing is recoverable; a wrong basis isn't.
//
// So it never degrades. It asks twice. The venue has exactly one real-time source (on a plan
// without intraday candles, FMP `/quote` is the whole ladder for an equity), and that source can
// blink — a 429, a timeout — or answer from a 3s cache that captured a poll's blink a moment
// earlier. One fresh retry separates "the market has no price" from "we asked at a bad instant".

const nowait = async () => {}

test('a good live quote fills immediately and never costs a retry', async () => {
    let retried = false
    const res = await entryMarkPrice('ZTS', {
        mark:  async () => 77.65,
        fresh: async () => { retried = true; return 99 },
        wait:  nowait,
    })
    assert.deepEqual(res, { price: 77.65, source: 'live' })
    assert.equal(retried, false)
})

test('a blinked quote is retried past the cache — this is the 429-on-the-order case', async () => {
    const res = await entryMarkPrice('ZTS', {
        mark:  async () => null,      // the rate limit lands exactly on the order
        fresh: async () => 77.65,     // a beat later, the window has moved on
        wait:  nowait,
    })
    assert.deepEqual(res, { price: 77.65, source: 'retry' })
})

test('the retry is reported, so a fill that needed one is not silently identical to a clean one', async () => {
    const { source } = await entryMarkPrice('ZTS', { mark: async () => null, fresh: async () => 77.65, wait: nowait })
    assert.equal(source, 'retry')
})

test('it waits before retrying — an instant re-ask is the same rate-limit window', async () => {
    let waited = null
    await entryMarkPrice('ZTS', {
        mark:  async () => null,
        fresh: async () => 77.65,
        wait:  async (ms) => { waited = ms },
        delayMs: 300,
    })
    assert.equal(waited, 300)
})

test('two failures is a refusal, not a degraded fill', async () => {
    // The whole point: no day close, no last mark, no invented number. The caller turns this
    // into "no live price right now — try again", and the user is free to press Buy again.
    assert.deepEqual(
        await entryMarkPrice('ZTS', { mark: async () => null, fresh: async () => null, wait: nowait }),
        { price: null, source: null },
    )
})

test('a non-positive or non-finite price is not a price at either attempt', async () => {
    // 0 reaching openPosition would book the entire notional as the basis.
    assert.deepEqual(await entryMarkPrice('ZTS', { mark: async () => 0,   fresh: async () => 77.65, wait: nowait }), { price: 77.65, source: 'retry' })
    assert.deepEqual(await entryMarkPrice('ZTS', { mark: async () => NaN, fresh: async () => 77.65, wait: nowait }), { price: 77.65, source: 'retry' })
    assert.deepEqual(await entryMarkPrice('ZTS', { mark: async () => -5,  fresh: async () => 0,     wait: nowait }), { price: null,  source: null })
})
