// getQuotes — the batch that was not batched.
//
// There is no multi-symbol quote endpoint on this tier, so "batch" means a loop, and the loop was
// `Promise.allSettled` over every symbol given: one request each, all at once, plus a second one per
// symbol whenever FMP misses and Yahoo is asked instead. Handed a scanner's 116-name board that is
// 116+ simultaneous requests against a key the paper mark and fill loops already hold at 45-85 a
// minute — which is how a quote sweep starved the calendar call running beside it and came back
// "quote unavailable" for half a board, and how the model then read half a board as untradeable.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getQuotes, QUOTE_FANOUT } from '../../providers/yahoofinance.provider.js'

const quote = (symbol, price = 100, chg = 1.25) => ({
    symbol, regularMarketPrice: price, regularMarketChangePercent: chg,
})

/** A stub quote reader that records the high-water mark of concurrent reads. */
function tracker({ fail = [], unpriced = [] } = {}) {
    const t = { active: 0, peak: 0, asked: [] }
    t.deps = { quote: async (s) => {
        t.active++
        t.peak = Math.max(t.peak, t.active)
        await new Promise(r => setTimeout(r, 4))
        t.active--
        t.asked.push(s)
        if (fail.includes(s))     throw new Error('Request failed with status code 429')
        if (unpriced.includes(s)) return null
        return quote(s)
    } }
    return t
}

const many = (n) => Array.from({ length: n }, (_, i) => `S${i}`)

test('a long list is PACED, never fired all at once', async () => {
    const t = tracker()
    await getQuotes(many(30), t.deps)
    assert.equal(t.peak, QUOTE_FANOUT, `expected a ceiling of ${QUOTE_FANOUT}, saw ${t.peak}`)
    assert.equal(t.asked.length, 30, 'every symbol was still read')
})

test('a list shorter than the cap is not slowed — it all overlaps', async () => {
    const t = tracker()
    await getQuotes(['A', 'B', 'C'], t.deps)
    assert.equal(t.peak, 3, 'the cap is a ceiling, not a batch size')
})

test('lines come back in the order the symbols were given, not the order the reads finished', async () => {
    const t = tracker()
    const out = await getQuotes(['AAA', 'BBB', 'CCC'], t.deps)
    assert.deepEqual(out.split('\n').map(l => l.split(':')[0]), ['AAA', 'BBB', 'CCC'])
})

// ONE SYMBOL FAILING MUST NOT COST THE REST — mapLimit has no swallow mode, so the catch lives in the
// mapped function, which is the caller that owns that judgment.
test('one symbol throwing leaves every other line intact', async () => {
    const t = tracker({ fail: ['BBB'] })
    const out = await getQuotes(['AAA', 'BBB', 'CCC'], t.deps)
    const lines = out.split('\n')
    assert.equal(lines.length, 3)
    assert.match(lines[0], /^AAA: \$100\.00 \(1\.25%\)$/)
    assert.match(lines[2], /^CCC: \$100\.00/)
})

// THE DISTINCTION THAT COST A BOARD. "quote unavailable" was printed for both a failed fetch and an
// uncovered symbol, and a model reads either as "cannot price it, so leave it off".
test('a failed READ says so, and says it is not a fact about the symbol', async () => {
    const out = await getQuotes(['BBB'], tracker({ fail: ['BBB'] }).deps)
    assert.match(out, /price read FAILED/)
    assert.match(out, /429/, 'the reason travels with it')
    assert.match(out, /NOT a fact about the symbol/)
    assert.match(out, /do not read it as untradeable/)
})

test('a symbol the feed does not cover is a different line entirely', async () => {
    const out = await getQuotes(['XYZ'], tracker({ unpriced: ['XYZ'] }).deps)
    assert.match(out, /no price on this feed \(uncovered symbol\)/)
    assert.doesNotMatch(out, /FAILED/, 'an uncovered symbol is not a failure')
})

test('duplicates and case fold, so a symbol is fetched once', async () => {
    const t = tracker()
    const out = await getQuotes(['nvda', 'NVDA', ' nvda '.trim()], t.deps)
    assert.deepEqual(t.asked, ['NVDA'])
    assert.equal(out.split('\n').length, 1)
})

test('no tickers is a sentence, not a throw or an empty string', async () => {
    assert.equal(await getQuotes([]), 'No tickers provided.')
    assert.equal(await getQuotes(), 'No tickers provided.')
})
