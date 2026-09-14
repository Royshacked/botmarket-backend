// The positions read prices from the mark the loop already wrote, not from a fresh quote.
//
// GET /api/broker/paper/positions used to call latestMarkPrice on every open symbol on every
// read. The client polls it every 4s — one beat past the 3s quote cache — so every poll refetched
// every symbol: 13 open symbols was 195 FMP requests a minute from a process that was not even
// running the mark loop, and the reason a chart's candles came back 429 and it fell back to
// chart-img. The mark loop had stamped a price on every one of those positions seconds earlier.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PaperAdapter } from '../../api/broker/adapters/paper.adapter.js'

const adapter = new PaperAdapter()
const NOW = 1_800_000_000_000
const pos = (symbol, over = {}) => ({ positionId: symbol, symbol, direction: 'long', qty: 1, avgPrice: 100, ...over })

function fetcher() {
    const calls = []
    const fetch = async s => { calls.push(s); return 999 }
    return { calls, fetch }
}

test('a fresh stored mark is the price — no fetch', async () => {
    const { calls, fetch } = fetcher()
    const m = await adapter._priceMap([pos('NVDA', { currentPrice: 110, markedAt: NOW - 2_000 })], { now: NOW, fetch, freshMs: 15_000 })
    assert.equal(m.get('NVDA'), 110)
    assert.deepEqual(calls, [])
})

test('a stale mark is re-priced', async () => {
    const { calls, fetch } = fetcher()
    const m = await adapter._priceMap([pos('NVDA', { currentPrice: 110, markedAt: NOW - 60_000 })], { now: NOW, fetch, freshMs: 15_000 })
    assert.equal(m.get('NVDA'), 999)
    assert.deepEqual(calls, ['NVDA'])
})

test('a position never marked is priced', async () => {
    const { calls, fetch } = fetcher()
    const m = await adapter._priceMap([pos('NVDA')], { now: NOW, fetch, freshMs: 15_000 })
    assert.equal(m.get('NVDA'), 999)
    assert.deepEqual(calls, ['NVDA'])
})

test('the freshest mark wins when several positions share a symbol, and one stale row forces nothing', async () => {
    const { calls, fetch } = fetcher()
    const m = await adapter._priceMap([
        pos('NVDA', { currentPrice: 105, markedAt: NOW - 60_000 }),
        pos('NVDA', { currentPrice: 111, markedAt: NOW - 1_000 }),
    ], { now: NOW, fetch, freshMs: 15_000 })
    assert.equal(m.get('NVDA'), 111)
    assert.deepEqual(calls, [])
})

test('one fetch per stale symbol, none for the fresh ones', async () => {
    const { calls, fetch } = fetcher()
    const m = await adapter._priceMap([
        pos('A', { currentPrice: 1, markedAt: NOW - 1_000 }),
        pos('B', { currentPrice: 2, markedAt: NOW - 90_000 }),
        pos('B', { currentPrice: 2, markedAt: NOW - 91_000 }),
        pos('C'),
    ], { now: NOW, fetch, freshMs: 15_000 })
    assert.deepEqual([...m.entries()].sort(), [['A', 1], ['B', 999], ['C', 999]])
    assert.deepEqual(calls.sort(), ['B', 'C'])
})

test('a mark with no timestamp is not trusted', async () => {
    const { calls, fetch } = fetcher()
    await adapter._priceMap([pos('NVDA', { currentPrice: 110 })], { now: NOW, fetch, freshMs: 15_000 })
    assert.deepEqual(calls, ['NVDA'])
})

test('the default window is a few mark intervals, not forever', async () => {
    const { config } = await import('../../services/config.js')
    const { calls, fetch } = fetcher()
    const justInside = config.paperMarkIntervalMs * 5 - 1
    const justPast   = config.paperMarkIntervalMs * 5 + 1
    await adapter._priceMap([pos('A', { currentPrice: 1, markedAt: NOW - justInside })], { now: NOW, fetch })
    await adapter._priceMap([pos('B', { currentPrice: 1, markedAt: NOW - justPast })], { now: NOW, fetch })
    assert.deepEqual(calls, ['B'])
})
