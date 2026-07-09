import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _parseKairosResponse, _resolveVenue, _finalizeCall } from '../../services/kairos.agent.service.js'

const CALL_JSON = `{
  "asset": "TSLA",
  "trade_type": "day",
  "entry_zones": [{ "side": "long", "anchor": 248, "lower": 247.4, "upper": 248.6 }],
  "sizing": { "max_size": 300 }
}`

// ── _parseKairosResponse ─────────────────────────────────────────────────
test('parse: extracts the call JSON and strips it from the reply', () => {
    const raw = `Here's your call for TSLA.\n<call>${CALL_JSON}</call>`
    const { reply, call } = _parseKairosResponse(raw)
    assert.equal(reply, "Here's your call for TSLA.")
    assert.equal(call.asset, 'TSLA')
    assert.equal(call.entry_zones[0].lower, 247.4)
})

test('parse: no block → call null, reply is the whole text', () => {
    const { reply, call } = _parseKairosResponse('Still mapping levels, one sec.')
    assert.equal(call, null)
    assert.equal(reply, 'Still mapping levels, one sec.')
})

test('parse: malformed JSON → call null but reply still cleaned', () => {
    const raw = 'Done.<call>{ not valid json )</call>'
    const { reply, call } = _parseKairosResponse(raw)
    assert.equal(call, null)
    assert.equal(reply, 'Done.')
})

test('parse: null/undefined raw → empty reply, null call', () => {
    assert.deepEqual(_parseKairosResponse(null), { reply: '', call: null })
    assert.deepEqual(_parseKairosResponse(undefined), { reply: '', call: null })
})

// ── _resolveVenue (symbol gate) ──────────────────────────────────────────
test('resolveVenue: paper trades in chart space (no resolution)', async () => {
    assert.deepEqual(await _resolveVenue('paper', 'u1', 'p1', 'TSLA'), { broker_symbol: 'TSLA', basis_offset: 0 })
})

test('resolveVenue: manual trades in chart space too', async () => {
    assert.deepEqual(await _resolveVenue('manual', 'u1', 'm1', 'AAPL'), { broker_symbol: 'AAPL', basis_offset: 0 })
})

test('resolveVenue: cTrader index maps symbol + measures basis once', async () => {
    const deps = {
        toBrokerSymbol:     (_b, a) => (a === 'NQ' ? 'US100' : a),
        resolveSymbol:      async () => ({ found: true, symbol: 'US100.cash' }),
        computeBasisOffset: async () => ({ offset: -12.5 }),
    }
    assert.deepEqual(await _resolveVenue('ctrader', 'u1', 'ct1', 'NQ', deps), { broker_symbol: 'US100.cash', basis_offset: -12.5 })
})

test('resolveVenue: cTrader symbol resolve failure falls back to the static map', async () => {
    const deps = {
        toBrokerSymbol:     () => 'US100',
        resolveSymbol:      async () => { throw new Error('broker offline') },
        computeBasisOffset: async ({ brokerSymbol }) => ({ offset: brokerSymbol === 'US100' ? -11 : 0 }),
    }
    assert.deepEqual(await _resolveVenue('ctrader', 'u1', 'ct1', 'NQ', deps), { broker_symbol: 'US100', basis_offset: -11 })
})

test('resolveVenue: basis measurement failure yields zero offset (place at authored)', async () => {
    const deps = {
        toBrokerSymbol:     () => 'US100',
        resolveSymbol:      async () => ({ found: true, symbol: 'US100.cash' }),
        computeBasisOffset: async () => { throw new Error('no quote') },
    }
    assert.deepEqual(await _resolveVenue('ctrader', 'u1', 'ct1', 'NQ', deps), { broker_symbol: 'US100.cash', basis_offset: 0 })
})

// ── _finalizeCall gate (no DB: validation rejects before persistence) ──────
test('finalize: no marked account → no_venue (never reaches the DB)', async () => {
    const draft = { asset: 'TSLA', trade_type: 'day', entry_zones: [{ anchor: 248, lower: 247, upper: 249 }], sizing: { max_size: 100 } }
    const res   = await _finalizeCall(draft, { userId: 'u1', accounts: [] })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'no_venue')
})

test('finalize: incomplete draft (no zone) → no_entry_zone before the DB', async () => {
    const draft = { asset: 'TSLA', trade_type: 'day', entry_zones: [], sizing: { max_size: 100 } }
    const res   = await _finalizeCall(draft, { userId: 'u1', accounts: [{ id: 'paper-u1', broker: 'paper' }] })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'no_entry_zone')
})
