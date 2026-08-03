import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestMarkPrice } from '../../api/broker/paperExecution.service.js'

// latestMarkPrice keeps a "FMP can't price this" cache so a symbol FMP doesn't cover (a future,
// an index CFD, a broker alias) isn't re-asked on every mark tick. The cache was set on ANY
// failure, including a thrown one — so an FMP 429 recorded a rate limit as a permanent fact
// about the symbol and suppressed the quote for a full 10 minutes.
//
// That is only survivable if the next rung down works. On a plan without intraday candles it
// does not: `/quote` is the only real-time price the paper venue has for an equity. So one
// second of rate limiting became ten minutes in which ZTS could not be bought (`paper: no price
// for ZTS` → all_failed → a 502 on the order) and no open position marked at all.
//
// The distinction the cache has to draw: FMP ANSWERING with no price is about the symbol;
// FMP THROWING is about the moment.

// Each test uses its own symbol — the suppression cache is module-level and TTL'd (10 min), so
// shared tickers would leak state between tests in either order.
const deps = (quote, { candles = async () => [], isOpen = () => true } = {}) => ({ quote, candles, isOpen })

test('a rate limit is not remembered — the very next tick asks FMP again', async () => {
    let calls = 0
    const quote = async () => {
        calls++
        if (calls === 1) { const e = new Error('FMP /quote 429'); e.status = 429; throw e }
        return 77.65
    }
    assert.equal(await latestMarkPrice('TST_429', deps(quote)), null, 'the blip itself still yields no price')
    assert.equal(await latestMarkPrice('TST_429', deps(quote)), 77.65, 'and the recovery is immediate, not in 10 minutes')
    assert.equal(calls, 2, 'the second call must actually reach FMP rather than be suppressed')
})

test('FMP answering "no price" IS remembered — that one is about the symbol', async () => {
    let calls = 0
    const quote = async () => { calls++; return null }   // covered endpoint, uncovered symbol
    assert.equal(await latestMarkPrice('TST_NULL', deps(quote)), null)
    assert.equal(await latestMarkPrice('TST_NULL', deps(quote)), null)
    assert.equal(calls, 1, 'a symbol FMP genuinely cannot price is not re-asked every tick')
})

test('a live quote is returned untouched and costs no candle fetch', async () => {
    let candleFetched = false
    const price = await latestMarkPrice('TST_OK', deps(async () => 77.65, {
        candles: async () => { candleFetched = true; return [] },
    }))
    assert.equal(price, 77.65)
    assert.equal(candleFetched, false)
})

test('a zero or non-finite quote is not a price, and does not suppress the fallback', async () => {
    // 0 reaching a fill would book the whole notional; it has to read as absent, and then the
    // intraday rung still gets its chance.
    const price = await latestMarkPrice('TST_ZERO', deps(async () => 0, {
        candles: async () => [{ c: 77.29 }],
    }))
    assert.equal(price, 77.29)
})

test('still never falls back to a day candle — the touch-fill rule is unchanged', async () => {
    // This is the reason latestMarkPrice exists apart from exitMarkPrice: it also answers "did
    // price TOUCH this level", and a stale day close there fires a TP the market never reached.
    // Nothing here loosens that; a closed session yields null rather than a coarse price.
    const price = await latestMarkPrice('TST_CLOSED', deps(async () => null, {
        isOpen:  () => false,
        candles: async () => { throw new Error('must not be fetched with the session closed') },
    }))
    assert.equal(price, null)
})
