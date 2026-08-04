import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publish, readMark, markAge, published, forget, retainOnly, partitionByFreshness, _reset } from '../../services/priceFeed.service.js'

// The feed exists because a shared FETCHER did not dedupe anything: three consumers each polled
// slower than the 3s quote cache lived, so every one of them missed it and fetched its own copy.
// A publisher fixes what a cache could not — one loop fetches on one cadence, everyone else reads.
//
// The two doors are the design: readMark is free and may be stale, fetchFresh costs a request and
// is not. Which one a caller wants is the CALLER's judgment (a P&L display vs pricing a fill), so
// the freshness bound is an argument here, never a constant inside the feed.

test.beforeEach(() => _reset())

test('what is published is what is read, symbol case notwithstanding', () => {
    publish('aapl', 305.19)
    assert.equal(readMark('AAPL'), 305.19)
    assert.equal(readMark('aapl'), 305.19)
})

test('an unpublished symbol is null, not a guess and not a throw', () => {
    assert.equal(readMark('NOPE'), null)
    assert.equal(readMark(''), null)
    assert.equal(readMark(), null)
    assert.equal(markAge('NOPE'), null)
})

// A price of 0 reaching a fill would book the whole notional; it has to read as absent.
test('a junk price is refused at publish rather than served later', () => {
    for (const bad of [0, -5, null, undefined, NaN, Infinity, 'abc']) {
        publish('JUNK', bad)
        assert.equal(readMark('JUNK'), null, `published ${String(bad)}`)
    }
})

test('the caller sets the staleness bound, and the feed enforces exactly that', () => {
    publish('SPY', 762.94, Date.now() - 10_000)
    assert.equal(readMark('SPY'), 762.94, 'no bound given → any age is acceptable')
    assert.equal(readMark('SPY', { maxAgeMs: 30_000 }), 762.94)
    assert.equal(readMark('SPY', { maxAgeMs: 5_000 }), null, 'too old FOR THIS CALLER')
})

// Null from readMark means "not cheaply", never "no such price" — the caller decides what next.
test('a too-stale read reports null while the mark itself survives', () => {
    publish('MSFT', 500, Date.now() - 60_000)
    assert.equal(readMark('MSFT', { maxAgeMs: 1_000 }), null)
    assert.equal(readMark('MSFT'), 500, 'still there for a caller with looser needs')
    assert.ok(markAge('MSFT') >= 60_000)
})

test('a later publish replaces the earlier one', () => {
    publish('NVDA', 100)
    publish('NVDA', 101)
    assert.equal(readMark('NVDA'), 101)
    assert.equal(published().filter(r => r.symbol === 'NVDA').length, 1)
})

test('forget drops one symbol and leaves the rest', () => {
    publish('A', 1); publish('B', 2)
    forget('a')
    assert.equal(readMark('A'), null)
    assert.equal(readMark('B'), 2)
})

// The map should be the size of the book, not of everything ever marked — otherwise a long-running
// process accumulates prices for symbols closed weeks ago and serves them to anyone who asks.
test('retainOnly keeps the live set and retires the rest', () => {
    publish('A', 1); publish('B', 2); publish('C', 3)
    assert.equal(retainOnly(['a', 'C']), 1, 'exactly one dropped')
    assert.equal(readMark('A'), 1)
    assert.equal(readMark('C'), 3)
    assert.equal(readMark('B'), null)
})

test('retaining nothing empties the feed', () => {
    publish('A', 1)
    retainOnly([])
    assert.deepEqual(published(), [])
})

test('published() reports newest first', () => {
    publish('OLD', 1, Date.now() - 10_000)
    publish('NEW', 2)
    assert.deepEqual(published().map(r => r.symbol), ['NEW', 'OLD'])
})

// ── The reciprocity: read what someone else paid for, buy only the rest ────────

test('a symbol someone else just priced is read, not re-bought', () => {
    publish('AAPL', 305)                       // e.g. a chart ticking on a held name
    const { fresh, stale } = partitionByFreshness(['AAPL', 'MSFT'], 7_500)
    assert.deepEqual([...fresh], [['AAPL', 305]])
    assert.deepEqual(stale, ['MSFT'], 'only the unpriced one costs a request')
})

// The invariant that keeps a polling loop honest. If its tolerance reached its own interval, the
// mark it published last tick would satisfy this one — and it would stop looking at the market
// entirely while continuing to report a price with total confidence.
test('a loop can never be satisfied by its OWN publication from the previous tick', () => {
    const INTERVAL = 15_000
    publish('SPY', 762.94, Date.now() - INTERVAL)          // exactly one interval ago: our own last tick
    const { fresh, stale } = partitionByFreshness(['SPY'], INTERVAL / 2)
    assert.equal(fresh.size, 0)
    assert.deepEqual(stale, ['SPY'], 'it must go and look again')
})

test('duplicate symbols are collapsed — many positions, one price', () => {
    const { stale } = partitionByFreshness(['NVDA', 'NVDA', 'NVDA'], 1_000)
    assert.deepEqual(stale, ['NVDA'])
})

test('nothing published means everything is bought, and nothing throws', () => {
    const { fresh, stale } = partitionByFreshness(['A', 'B'], 5_000)
    assert.equal(fresh.size, 0)
    assert.deepEqual(stale, ['A', 'B'])
    assert.deepEqual(partitionByFreshness([], 5_000), { fresh: new Map(), stale: [] })
})
