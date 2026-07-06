import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrokerAdapter } from '../../api/broker/adapters/broker.interface.js'
import { PaperAdapter } from '../../api/broker/adapters/paper.adapter.js'
import { _groupByBroker } from '../../api/trade-ideas/tradeIdeas.service.js'

// ── resolveSymbol ("getTicker") contract ──────────────────────────────────────

test('base adapter resolveSymbol is unsupported → found:null (caller uses static map)', async () => {
    const res = await new BrokerAdapter().resolveSymbol('u', 'a', 'NQ')
    assert.deepEqual(res, { symbol: 'NQ', found: null })
})

test('paper resolveSymbol is identity → found:true (paper is a valid venue)', async () => {
    const res = await new PaperAdapter().resolveSymbol('u', 'a', 'NQ')
    assert.deepEqual(res, { symbol: 'NQ', found: true })
})

// ── Gate #5 predicate (no broker + no paper → reject) ──────────────────────────
// saveIdea rejects when `partitions.every(p => p.broker == null)`. Compose it on the
// real _groupByBroker so the gate stays honest to the partition logic.

const noVenue = partitions => partitions.every(p => p.broker == null)

test('gate: all-unresolved accounts → single null-broker partition → rejected', () => {
    const { partitions } = _groupByBroker(['a1', 'a2'], new Map(), null)
    assert.equal(partitions.length, 1)
    assert.equal(partitions[0].broker, null)
    assert.equal(noVenue(partitions), true)
})

test('gate: a known broker → venue present → accepted', () => {
    const { partitions } = _groupByBroker(['a1'], new Map([['a1', 'ctrader']]), null)
    assert.equal(partitions[0].broker, 'ctrader')
    assert.equal(noVenue(partitions), false)
})

test('gate: forked multi-broker → no null partitions → accepted', () => {
    const brokerBy = new Map([['a1', 'ctrader'], ['a2', 'ibkr']])
    const { partitions } = _groupByBroker(['a1', 'a2'], brokerBy, null)
    assert.equal(partitions.length, 2)
    assert.ok(partitions.every(p => p.broker != null))
    assert.equal(noVenue(partitions), false)
})
