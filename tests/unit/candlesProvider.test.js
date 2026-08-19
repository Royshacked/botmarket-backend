import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTickerAggregates, _deps } from '../../providers/candles.provider.js'

// THE ONE PLACE THAT DECIDES WHERE A CANDLE COMES FROM.
//
// It had no test of its own. The policy WAS asserted — but in candleFetch's tests, against
// candleFetch's own second copy of it, which is how the copy survived long enough to cost a
// duplicate FMP request on every fallback path. Testing the copy is what made the copy look tested.
//
// The fallback path is not an edge case here: it is futures, index CFDs, broker symbols and
// week/month bars — most of what this app actually trades — and the 429s that once killed the
// agents were our own polling.

const SPEC = { timeSpan: 'day', multiplier: 1 }
const ROW  = { timestamp: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }

/** _deps with `useFmp` overridable — it is a getter on the real object, so it needs redefining. */
function deps({ useFmp = true, fmp, massive }) {
    return {
        useFmp,
        getFmpCandles:        fmp     ?? (async () => []),
        getMassiveAggregates: massive ?? (async () => []),
    }
}

test('FMP serves the spec → Massive is never asked', async () => {
    let massiveCalled = false
    const out = await getTickerAggregates('AAPL', SPEC, deps({
        fmp:     async () => [ROW],
        massive: async () => { massiveCalled = true; return [] },
    }))
    assert.deepEqual(out, [ROW])
    assert.equal(massiveCalled, false)
})

test('FMP cannot serve it → Massive does, and FMP is asked only once', async () => {
    // null = week/month/odd multiplier (a spec FMP has no endpoint for); [] = a symbol it does not
    // cover. Both mean "not here", and both must cost exactly one FMP request before moving on.
    for (const empty of [null, []]) {
        let fmpCalls = 0
        const out = await getTickerAggregates('NQ', SPEC, deps({
            fmp:     async () => { fmpCalls++; return empty },
            massive: async () => [ROW],
        }))
        assert.deepEqual(out, [ROW], `empty=${JSON.stringify(empty)}`)
        assert.equal(fmpCalls, 1, 'one question, one request')
    }
})

test('FMP throwing is a fallback, not a failure', async () => {
    const out = await getTickerAggregates('AAPL', SPEC, deps({
        fmp:     async () => { throw new Error('FMP 500') },
        massive: async () => [ROW],
    }))
    assert.deepEqual(out, [ROW])
})

// ── The flag ──────────────────────────────────────────────────────────────────

test('USE_FMP_CANDLES off means FMP is not called AT ALL', async () => {
    // The flag exists so the cutover is reversible. It was read once at module load and captured in
    // a const, which froze it against config.js's own design — every value there is a live getter
    // precisely so a test can move it. Read per call now, which is what makes this assertion possible.
    let fmpCalled = false
    const out = await getTickerAggregates('AAPL', SPEC, deps({
        useFmp:  false,
        fmp:     async () => { fmpCalled = true; return [ROW] },
        massive: async () => [ROW],
    }))
    assert.equal(fmpCalled, false, 'off must mean off — the whole point of a reversible cutover')
    assert.deepEqual(out, [ROW])
})

test('the real _deps expose the flag live, not a boot-time snapshot', () => {
    // Guards the fix rather than the behaviour: if `useFmp` goes back to being a captured const,
    // this reads undefined and the test above stops meaning anything.
    assert.equal(typeof _deps.useFmp, 'boolean')
    assert.equal(typeof _deps.getFmpCandles, 'function')
    assert.equal(typeof _deps.getMassiveAggregates, 'function')
})
