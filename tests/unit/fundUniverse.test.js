import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fundUniverse, publishFundUniverse, _setFundUniverseIO } from '../../api/strategy/fundUniverse.service.js'
import { BUCKET_PROXY } from '../../services/entity/vocabulary.js'

// The list the Python engine fits channel betas on. It must be EXACTLY the funds BUCKET_PROXY
// grades with — a fund missing here is a bucket with no beta, which the sizing would read as
// unmeasured, the case that inflates a position.

test('every fund in the map is in the universe, once', () => {
    const { funds } = fundUniverse()
    const symbols = funds.map(f => f.symbol)
    assert.equal(new Set(symbols).size, symbols.length, 'one entry per fund')
    assert.deepEqual(new Set(symbols), new Set(Object.values(BUCKET_PROXY).map(m => m.symbol)))
})

test('a shared fund lists every bucket it grades, with its grain', () => {
    const iyt = fundUniverse().funds.find(f => f.symbol === 'IYT')
    assert.deepEqual(iyt.buckets.map(b => b.bucket),
        ['General Transportation', 'Integrated Freight & Logistics', 'Railroads', 'Trucking'])
    assert.ok(iyt.buckets.every(b => b.grain === 'industry'))
    assert.equal(fundUniverse().funds.find(f => f.symbol === 'XLK').buckets[0].grain, 'sector')
})

test('the market factor is the benchmark fund', () => {
    assert.equal(fundUniverse().market, 'SPY')
})

test('a map entry without a symbol is skipped, not written as a fund', () => {
    const { funds } = fundUniverse({ A: { symbol: 'AAA', weighting: 'cap', exact: true }, B: {} })
    assert.deepEqual(funds.map(f => f.symbol), ['AAA'])
})

test('publishing writes one document and never throws', async () => {
    const writes = []
    _setFundUniverseIO({ write: async (doc) => { writes.push(doc) } })
    const now = new Date('2026-09-30T00:00:00Z')
    const u = await publishFundUniverse(now)
    assert.equal(writes.length, 1)
    assert.equal(writes[0]._id, 'current')
    assert.equal(writes[0].written_at, now)
    assert.equal(writes[0].funds.length, u.funds.length)

    _setFundUniverseIO({ write: async () => { throw new Error('mongo down') } })
    assert.equal(await publishFundUniverse(now), null, 'a failed boot write costs the list, not the server')
})

test('the industry-to-sector map rides along, so the engine can score a sector fund on all its industries', () => {
    const { industry_sector } = fundUniverse()
    assert.equal(Object.keys(industry_sector).length, 155)
    assert.equal(industry_sector['Semiconductors'], 'Technology')
})
