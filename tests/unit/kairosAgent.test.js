import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _parseKairosResponse, _mergeCallDraft, _resolveVenue, _finalizeCall, _parseScanRequest } from '../../services/kairos.agent.service.js'

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

test('parse: partial worksheet (asset only, no zones) parses and strips', () => {
    // The call is now a live preview emitted every turn — early on it carries just the asset/bias.
    const raw = `Locking in TSLA long — mapping zones next.\n<call>{ "asset": "TSLA", "bias": "long", "trade_type": "day" }</call>`
    const { reply, call } = _parseKairosResponse(raw)
    assert.equal(reply, 'Locking in TSLA long — mapping zones next.')
    assert.equal(call.asset, 'TSLA')
    assert.equal(call.bias, 'long')
    assert.equal(call.entry_zones, undefined)   // not ready to Generate yet — no zones
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

test('parse: <scan_request> block is stripped from the visible reply', () => {
    const raw = `I'll send you to Argus to find a long swing setup.\n<scan_request>{ "direction": "long", "style": "swing" }</scan_request>`
    const { reply, call } = _parseKairosResponse(raw)
    assert.equal(reply, "I'll send you to Argus to find a long swing setup.")
    assert.equal(call, null)   // a scan-request turn carries no call
})

// ── _parseScanRequest (discovery hand-off to Argus) ──────────────────────
test('scanRequest: parses direction + validated style + hints (no ticker → discovery)', () => {
    const raw = `Sending you to Argus.\n<scan_request>{ "direction": "long", "style": "swing", "period_hint": "next week", "angle_hint": "momentum breakouts", "note": "large-cap swings" }</scan_request>`
    assert.deepEqual(_parseScanRequest(raw), {
        direction: 'long', ticker: null, style: 'swing', period_hint: 'next week', angle_hint: 'momentum breakouts', note: 'large-cap swings',
    })
})

test('scanRequest: a ticker is parsed + uppercased (validate-a-name mode)', () => {
    const out = _parseScanRequest('<scan_request>{ "direction": "long", "ticker": "nvda", "style": "swing" }</scan_request>')
    assert.equal(out.ticker, 'NVDA')
    assert.equal(out.direction, 'long')
    // a blank ticker is treated as absent (discovery)
    assert.equal(_parseScanRequest('<scan_request>{ "direction": "long", "ticker": "  " }</scan_request>').ticker, null)
})

test('scanRequest: no block → null', () => {
    assert.equal(_parseScanRequest('Just chatting, no scan.'), null)
    assert.equal(_parseScanRequest(null), null)
})

test('scanRequest: a block without a valid direction → null (a scan needs a bias to constrain)', () => {
    assert.equal(_parseScanRequest('<scan_request>{ "style": "swing" }</scan_request>'), null)
    assert.equal(_parseScanRequest('<scan_request>{ "direction": "sideways" }</scan_request>'), null)
})

test('scanRequest: off-vocabulary style drops to null, hints default to null', () => {
    const out = _parseScanRequest('<scan_request>{ "direction": "short", "style": "scalp" }</scan_request>')
    assert.deepEqual(out, { direction: 'short', ticker: null, style: null, period_hint: null, angle_hint: null, note: null })
})

test('scanRequest: malformed JSON → null', () => {
    assert.equal(_parseScanRequest('<scan_request>{ not json )</scan_request>'), null)
})

// ── _mergeCallDraft (carry-forward on a partial re-emit) ─────────────────
test('merge: delta re-emit carries omitted prior fields forward (the AXON bug)', () => {
    // Build turn produced a full call; the edit turn re-emitted ONLY sizing ("everything else stands").
    const prev  = {
        asset: 'AXON', trade_type: 'day',
        entry_zones:      [{ side: 'long', lower: 555, upper: 575 }],
        reference_levels: [{ kind: 'support', price: 538 }],
        patterns:         [{ name: 'shelf hold', weight: 'primary' }],
        sizing:           { max_size: 1000, unit: 'shares', risk_basis: 'stop_distance' },
    }
    const delta  = { sizing: { max_size: 1000, unit: 'notional_usd', risk_basis: 'stop_distance' } }
    const merged = _mergeCallDraft(prev, delta)
    assert.deepEqual(merged.entry_zones,      prev.entry_zones)       // preserved by omission
    assert.deepEqual(merged.reference_levels, prev.reference_levels)  // preserved
    assert.deepEqual(merged.patterns,         prev.patterns)          // preserved
    assert.equal(merged.sizing.unit, 'notional_usd')                 // the actual edit applied
})

test('merge: a re-emitted array fully replaces — model can still DROP a zone', () => {
    const prev   = { entry_zones: [{ lower: 1, upper: 2 }, { lower: 3, upper: 4 }] }
    const merged = _mergeCallDraft(prev, { entry_zones: [{ lower: 1, upper: 2 }] })
    assert.equal(merged.entry_zones.length, 1)   // NOT deep-merged — removal is honored
})

test('merge: explicit null in the new call clears a settled field', () => {
    assert.equal(_mergeCallDraft({ rr: 2.1 }, { rr: null }).rr, null)
})

test('merge: no new call this turn → null (client keeps its existing draft)', () => {
    assert.equal(_mergeCallDraft({ asset: 'AXON' }, null), null)
    assert.equal(_mergeCallDraft(null, null), null)
})

test('merge: no prior draft → the new call as-is', () => {
    assert.deepEqual(_mergeCallDraft(null, { asset: 'AXON' }), { asset: 'AXON' })
    assert.deepEqual(_mergeCallDraft(undefined, { asset: 'AXON' }), { asset: 'AXON' })
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

test('finalize (update): updateId routes to the in-place update + still gate-checks before the DB', async () => {
    // Same validation gate applies on edit — an incomplete draft is rejected before any DB write.
    const draft = { asset: 'TSLA', trade_type: 'day', entry_zones: [], sizing: { max_size: 100 } }
    const res   = await _finalizeCall(draft, { userId: 'u1', accounts: [{ id: 'paper-u1', broker: 'paper' }], updateId: 'call_x', chatState: { messages: [] } })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'no_entry_zone')
})
