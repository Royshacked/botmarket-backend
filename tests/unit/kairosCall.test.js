import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateCall, normalizeCall, computeKairosPerformance, _normalizeSensitivity } from '../../api/kairos/kairos.service.js'

// A minimal well-formed call the build agent (Phase 1) would emit, with venue bound (Generate).
function call(extra = {}) {
    return {
        asset: 'TSLA',
        asset_class: 'equity',
        trade_type: 'day',
        bias: 'long',
        thesis: 'PDH reclaim',
        timeframe_ladder: ['1d', '1hr', '15min', '5min'],
        entry_zones: [
            { side: 'long', anchor: 248.0, lower: 247.4, upper: 248.6, kind: 'reclaim', note: 'PDH' },
        ],
        reference_levels: [
            { kind: 'support', price: 245.2 },
            { kind: 'resistance', price: 252.0 },
        ],
        patterns: [
            { name: 'false break', type: 'price_action', weight: 'primary', evidence: 'observed', confidence: 0.7, relates_to: ['ez1'], look_for: 'sweep + reclaim' },
            { name: 'VWAP respect', type: 'indicator', weight: 'confirming' },
        ],
        sizing: { max_size: 300, unit: 'shares', risk_basis: 'stop_distance' },
        broker: 'paper',
        accounts: ['paper-u_abc'],
        ...extra,
    }
}

// ── validateCall: accept ─────────────────────────────────────────────────
test('validate: full call passes the gate', () => {
    assert.deepEqual(validateCall(call()), { ok: true })
})

test('validate: paper with no explicit account still passes (account derivable)', () => {
    assert.deepEqual(validateCall(call({ accounts: [] })), { ok: true })
})

// ── validateCall: reject ─────────────────────────────────────────────────
test('validate: non-object → invalid_call', () => {
    assert.equal(validateCall(null).reason, 'invalid_call')
    assert.equal(validateCall('nope').reason, 'invalid_call')
})

test('validate: missing / bad trade_type → invalid_trade_type', () => {
    assert.equal(validateCall(call({ trade_type: undefined })).reason, 'invalid_trade_type')
    assert.equal(validateCall(call({ trade_type: 'scalp' })).reason, 'invalid_trade_type')
})

test('validate: no entry zones → no_entry_zone', () => {
    assert.equal(validateCall(call({ entry_zones: [] })).reason, 'no_entry_zone')
    assert.equal(validateCall(call({ entry_zones: undefined })).reason, 'no_entry_zone')
})

test('validate: inverted / degenerate band → invalid_zone', () => {
    assert.equal(validateCall(call({ entry_zones: [{ anchor: 248, lower: 249, upper: 247 }] })).reason, 'invalid_zone')
    assert.equal(validateCall(call({ entry_zones: [{ anchor: 248, lower: 248, upper: 248 }] })).reason, 'invalid_zone')
})

test('validate: anchor outside band → invalid_zone', () => {
    assert.equal(validateCall(call({ entry_zones: [{ anchor: 250, lower: 247.4, upper: 248.6 }] })).reason, 'invalid_zone')
})

test('validate: non-numeric band → invalid_zone', () => {
    assert.equal(validateCall(call({ entry_zones: [{ anchor: 248, lower: 'x', upper: 248.6 }] })).reason, 'invalid_zone')
})

test('validate: missing / non-positive max_size → no_max_size', () => {
    assert.equal(validateCall(call({ sizing: {} })).reason, 'no_max_size')
    assert.equal(validateCall(call({ sizing: { max_size: 0 } })).reason, 'no_max_size')
    assert.equal(validateCall(call({ sizing: { max_size: -5 } })).reason, 'no_max_size')
})

test('validate: bad broker → no_venue', () => {
    assert.equal(validateCall(call({ broker: 'robinhood' })).reason, 'no_venue')
    assert.equal(validateCall(call({ broker: undefined })).reason, 'no_venue')
})

test('validate: live/manual with no accounts → no_venue', () => {
    assert.equal(validateCall(call({ broker: 'ctrader', accounts: [] })).reason, 'no_venue')
    assert.equal(validateCall(call({ broker: 'manual', accounts: [] })).reason, 'no_venue')
})

// ── normalizeCall ────────────────────────────────────────────────────────
test('normalize: assigns stable ids to zones / levels / patterns', () => {
    const doc = normalizeCall(call(), 'u_abc')
    assert.equal(doc.entry_zones[0].id, 'ez1')
    assert.deepEqual(doc.reference_levels.map(r => r.id), ['rl1', 'rl2'])
    assert.deepEqual(doc.patterns.map(p => p.id), ['p1', 'p2'])
})

test('normalize: keeps a caller-provided id instead of reassigning', () => {
    const doc = normalizeCall(call({ entry_zones: [{ id: 'zoneA', anchor: 248, lower: 247, upper: 249 }] }))
    assert.equal(doc.entry_zones[0].id, 'zoneA')
})

test('normalize: missing anchor defaults to band midpoint', () => {
    const doc = normalizeCall(call({ entry_zones: [{ lower: 100, upper: 102 }] }))
    assert.equal(doc.entry_zones[0].anchor, 101)
})

test('normalize: zone side falls back to bias', () => {
    const doc = normalizeCall(call({ bias: 'short', entry_zones: [{ anchor: 248, lower: 247, upper: 249 }] }))
    assert.equal(doc.entry_zones[0].side, 'short')
})

test('normalize: evidence coerces to inferred unless explicitly observed', () => {
    const doc = normalizeCall(call())
    assert.equal(doc.patterns[0].evidence, 'observed')  // explicit
    assert.equal(doc.patterns[1].evidence, 'inferred')  // omitted → inferred
})

test('normalize: event_risk carried through when present, defaults to [] when absent', () => {
    const events = [{ type: 'earnings', label: 'TSLA earnings', date: '2026-07-15', when: 'pre_market', impact: 'high' }]
    assert.deepEqual(normalizeCall(call({ event_risk: events })).event_risk, events)
    assert.deepEqual(normalizeCall(call()).event_risk, [])                       // absent → []
    assert.deepEqual(normalizeCall(call({ event_risk: 'nope' })).event_risk, []) // non-array → []
})

test('normalizeSensitivity: valid level + drivers upper-cased/bounded, note stringified', () => {
    assert.deepEqual(
        _normalizeSensitivity({ level: 'high', drivers: ['qqq', ' smh ', 'soxx', 'nvda', 'amd'], note: 'semi beta' }),
        { level: 'high', drivers: ['QQQ', 'SMH', 'SOXX', 'NVDA'], note: 'semi beta' },   // capped at 4
    )
})
test('normalizeSensitivity: unknown/missing level → null, garbage block → safe defaults', () => {
    assert.deepEqual(_normalizeSensitivity({ level: 'bogus' }), { level: null, drivers: [], note: null })
    assert.deepEqual(_normalizeSensitivity(undefined),          { level: null, drivers: [], note: null })
    assert.deepEqual(_normalizeSensitivity('nope'),             { level: null, drivers: [], note: null })
    assert.deepEqual(_normalizeSensitivity({ drivers: 'QQQ' }), { level: null, drivers: [], note: null }) // non-array drivers
})
test('normalize: market_sensitivity carried through the stored doc', () => {
    const doc = normalizeCall(call({ market_sensitivity: { level: 'medium', drivers: ['spy'], note: 'x' } }))
    assert.deepEqual(doc.market_sensitivity, { level: 'medium', drivers: ['SPY'], note: 'x' })
    assert.deepEqual(normalizeCall(call()).market_sensitivity, { level: null, drivers: [], note: null }) // absent
})

test('normalize: cadence defaults by trade_type when omitted', () => {
    assert.deepEqual(normalizeCall(call({ trade_type: 'swing' })).cadence, { min_gap_min: 5, max_gap_min: 30 })
    assert.deepEqual(normalizeCall(call({ trade_type: 'day' })).cadence, { min_gap_min: 1, max_gap_min: 15 })
})

test('normalize: explicit cadence is preserved', () => {
    const doc = normalizeCall(call({ cadence: { min_gap_min: 3, max_gap_min: 45 } }))
    assert.deepEqual(doc.cadence, { min_gap_min: 3, max_gap_min: 45 })
})

test('normalize: main_account_id defaults to first account', () => {
    assert.equal(normalizeCall(call()).main_account_id, 'paper-u_abc')
    assert.equal(normalizeCall(call({ main_account_id: 'paper-main' })).main_account_id, 'paper-main')
})

test('normalize: chat_state persists (build conversation for the edit pencil), null when absent', () => {
    assert.equal(normalizeCall(call()).chat_state, null)
    const cs  = { messages: [{ role: 'user', content: 'NVDA day trade' }], draft: { asset: 'NVDA' } }
    const doc = normalizeCall(call({ chat_state: cs }))
    assert.deepEqual(doc.chat_state, cs)
})

test('normalize: broker_symbol defaults to asset, basis_offset to 0', () => {
    const doc = normalizeCall(call())
    assert.equal(doc.broker_symbol, 'TSLA')
    assert.equal(doc.basis_offset, 0)
})

test('normalize: index carries its resolved broker_symbol + basis_offset', () => {
    const doc = normalizeCall(call({ asset: 'NQ', broker: 'ctrader', accounts: ['ct1'], broker_symbol: 'US100', basis_offset: -12.5 }))
    assert.equal(doc.broker_symbol, 'US100')
    assert.equal(doc.basis_offset, -12.5)
})

test('normalize: fresh call starts waiting with empty monitor_state', () => {
    const doc = normalizeCall(call(), 'u_abc')
    assert.equal(doc.status, 'waiting')
    assert.equal(doc.strategy, 'kairos')
    assert.equal(doc.user_id, 'u_abc')
    assert.deepEqual(doc.monitor_state, {
        next_check_at: null, armed_zone_id: null, chosen_timeframe: null,
        check_count: 0, memo: '', last_assessment: null,
    })
    assert.match(doc.id, /^call_TSLA_[0-9a-f]{8}$/)
})

// ── computeKairosPerformance (Phase 5 slice 4) ───────────────────────────────
const closedCall = (r, pnl) => ({ status: 'closed', position_state: { outcome: { r_multiple: r, pnl } } })

test('performance: aggregates wins/losses/avg_r/total_pnl from closed calls', () => {
    const perf = computeKairosPerformance([
        closedCall(2, 300),
        closedCall(-1, -110),
        closedCall(1.5, 180),
        { status: 'in_position', position_state: { outcome: null } },   // ignored (not closed)
        { status: 'closed' },                                            // ignored (no outcome)
    ])
    assert.equal(perf.closed, 3)
    assert.equal(perf.wins, 2)
    assert.equal(perf.losses, 1)
    assert.equal(perf.win_rate, 0.67)
    assert.equal(perf.avg_r, 0.83)          // (2 - 1 + 1.5)/3
    assert.equal(perf.total_pnl, 370)
    assert.equal(perf.best_r, 2)
    assert.equal(perf.worst_r, -1)
})

test('performance: empty → null aggregates, zero counts', () => {
    const perf = computeKairosPerformance([])
    assert.equal(perf.closed, 0)
    assert.equal(perf.wins, 0)
    assert.equal(perf.win_rate, null)
    assert.equal(perf.avg_r, null)
    assert.equal(perf.total_pnl, null)
})

test('performance: win falls back to R when P&L unknown', () => {
    const perf = computeKairosPerformance([closedCall(1.2, null), closedCall(-0.5, null)])
    assert.equal(perf.wins, 1)
    assert.equal(perf.losses, 1)
    assert.equal(perf.total_pnl, null)      // no finite P&L
    assert.equal(perf.avg_r, 0.35)
})
