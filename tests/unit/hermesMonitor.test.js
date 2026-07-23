import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    _zoneGate, _isPreActive, _isExpiring, _isPastExpiry, _effectiveVerdict, _computeNextCheckAt, _nextStatus,
    _snapToReference, _finalizeProposal, _applyAssessment, _hasEditProposal, _scheduledPatch, _proximityGapMin,
    _nearestZoneWidth, _shouldPulse, _checkCall,
    _timelineEntry, _zonesLabel, _withTimeout, _thinkingConfig, _assessText, _formatHeadlines, _formatEventRisk, _marketBlock,
    _isMarketSensitive, _applyEntryConfirmation, _allText, _chartTool, _validChartTf, _structureTools, _institutionalTools, _handleAssessToolUses,
    _reconcilePosition, _rMultiple, _checkPosition, _isStopOut,
    _computeMetrics, _positionGate, _reviewDue, _finalizePositionProposal, _applyPositionAssessment,
} from '../../monitoring/hermes.monitor.service.js'

function call(extra = {}) {
    return {
        id: 'call_TSLA_x', asset: 'TSLA', bias: 'long', trade_type: 'day',
        cadence: { min_gap_min: 5, max_gap_min: 60 },
        entry_zones: [
            { id: 'ez1', side: 'long', anchor: 248, lower: 247.4, upper: 248.6 },
            { id: 'ez2', side: 'long', anchor: 245, lower: 244.8, upper: 245.2 },
        ],
        reference_levels: [
            { id: 'rl1', kind: 'support',    price: 245.2 },
            { id: 'rl2', kind: 'resistance', price: 252.0 },
            { id: 'rl3', kind: 'target',     price: 255.5 },
        ],
        sizing: { max_size: 300 },
        monitor_state: { check_count: 2, memo: 'prior note', armed_zone_id: null },
        valid_until: '2026-07-09T20:00:00Z',
        ...extra,
    }
}

const NOW = Date.parse('2026-07-09T15:00:00Z')

// ── _zoneGate: multi-zone first-wins ──────────────────────────────────────
test('zoneGate: price inside the first zone arms that zone', () => {
    assert.equal(_zoneGate(call(), 248.0)?.id, 'ez1')
})
test('zoneGate: price inside the second zone arms it when the first misses', () => {
    assert.equal(_zoneGate(call(), 245.0)?.id, 'ez2')
})
test('zoneGate: overlapping-eligible price returns the FIRST matching zone', () => {
    const c = call({ entry_zones: [
        { id: 'ez1', lower: 244, upper: 249 },
        { id: 'ez2', lower: 244.8, upper: 245.2 },
    ] })
    assert.equal(_zoneGate(c, 245.0)?.id, 'ez1')   // first wins even though both contain 245
})
test('zoneGate: price outside every band → null; non-finite → null', () => {
    assert.equal(_zoneGate(call(), 250), null)
    assert.equal(_zoneGate(call(), NaN), null)
    assert.equal(_zoneGate(call(), undefined), null)
})

// ── _isExpiring ───────────────────────────────────────────────────────────
test('isExpiring: far from valid_until → false', () => {
    assert.equal(_isExpiring(call(), Date.parse('2026-07-09T15:00:00Z')), false)
})
test('isExpiring: within threshold → true; already past → true', () => {
    assert.equal(_isExpiring(call(), Date.parse('2026-07-09T19:50:00Z')), true)
    assert.equal(_isExpiring(call(), Date.parse('2026-07-09T21:00:00Z')), true)
})
test('isExpiring: no / bad valid_until → false', () => {
    assert.equal(_isExpiring(call({ valid_until: null }), NOW), false)
    assert.equal(_isExpiring(call({ valid_until: 'not-a-date' }), NOW), false)
})

// ── _isPreActive (the lower-bound primary time gate) ──────────────────────────
test('isPreActive: before active_from → true; at/after → false', () => {
    const c = call({ active_from: '2026-07-09T16:00:00Z' })   // 1h after NOW (15:00Z)
    assert.equal(_isPreActive(c, NOW), true)
    assert.equal(_isPreActive(c, Date.parse('2026-07-09T16:00:00Z')), false)   // exactly at
    assert.equal(_isPreActive(c, Date.parse('2026-07-09T17:00:00Z')), false)   // after
})
test('isPreActive: no / bad active_from → false (never gated)', () => {
    assert.equal(_isPreActive(call(), NOW), false)                         // field absent
    assert.equal(_isPreActive(call({ active_from: null }), NOW), false)
    assert.equal(_isPreActive(call({ active_from: 'nope' }), NOW), false)
})

// ── _computeNextCheckAt: clamp both ends ──────────────────────────────────
test('computeNextCheckAt: clamps below min, above max, passes through in-range', () => {
    const cad = { min_gap_min: 5, max_gap_min: 60 }
    assert.equal(_computeNextCheckAt(NOW, 1,   cad), new Date(NOW + 5 * 60_000).toISOString())   // clamped up to 5
    assert.equal(_computeNextCheckAt(NOW, 999, cad), new Date(NOW + 60 * 60_000).toISOString())  // clamped down to 60
    assert.equal(_computeNextCheckAt(NOW, 20,  cad), new Date(NOW + 20 * 60_000).toISOString())  // in range
})
test('computeNextCheckAt: non-finite request → max gap', () => {
    assert.equal(_computeNextCheckAt(NOW, undefined, { min_gap_min: 5, max_gap_min: 60 }), new Date(NOW + 60 * 60_000).toISOString())
})

// ── _isPastExpiry ───────────────────────────────────────────────────────────
test('isPastExpiry: before valid_until → false; at/after → true; bad → false', () => {
    assert.equal(_isPastExpiry(call(), Date.parse('2026-07-09T19:59:00Z')), false)  // 1m before
    assert.equal(_isPastExpiry(call(), Date.parse('2026-07-09T20:00:00Z')), true)   // exactly at
    assert.equal(_isPastExpiry(call(), Date.parse('2026-07-09T21:00:00Z')), true)   // after
    assert.equal(_isPastExpiry(call({ valid_until: null }), NOW), false)
    assert.equal(_isPastExpiry(call({ valid_until: 'nope' }), NOW), false)
})

// ── _effectiveVerdict: two off-menu guards ────────────────────────────────────
test('effectiveVerdict: let_expire on a zone trip is downgraded (never kill a live call)', () => {
    assert.equal(_effectiveVerdict('let_expire', 'zone_trip', false), 'stand_aside')
})
test('effectiveVerdict: let_expire on an expiry review is honored', () => {
    assert.equal(_effectiveVerdict('let_expire', 'expiry_review', false), 'let_expire')
    assert.equal(_effectiveVerdict('let_expire', 'expiry_review', true),  'let_expire')
})
test('effectiveVerdict: PAST-expiry review that won\'t commit is forced to let_expire (hard cutoff)', () => {
    assert.equal(_effectiveVerdict('wait',        'expiry_review', true), 'let_expire')
    assert.equal(_effectiveVerdict('stand_aside', 'expiry_review', true), 'let_expire')
})
test('effectiveVerdict: within the pre-expiry window (not past), wait/stand_aside are preserved', () => {
    assert.equal(_effectiveVerdict('wait',        'expiry_review', false), 'wait')
    assert.equal(_effectiveVerdict('stand_aside', 'expiry_review', false), 'stand_aside')
})
test('effectiveVerdict: enter/edit always pass through', () => {
    assert.equal(_effectiveVerdict('enter', 'expiry_review', true), 'enter')
    assert.equal(_effectiveVerdict('edit',  'expiry_review', true), 'edit')
    assert.equal(_effectiveVerdict('enter', 'zone_trip',     false), 'enter')
})

// ── _nextStatus ───────────────────────────────────────────────────────────
test('nextStatus: verdict → status transitions', () => {
    assert.equal(_nextStatus('enter', 'zone_trip'), 'ready')
    assert.equal(_nextStatus('edit', 'expiry_review'), 'expiring')
    assert.equal(_nextStatus('let_expire', 'expiry_review'), 'expired')
    assert.equal(_nextStatus('wait', 'zone_trip'), 'watching')
    assert.equal(_nextStatus('stand_aside', 'scheduled'), 'waiting')
})

// ── _snapToReference ──────────────────────────────────────────────────────
test('snapToReference: long stop snaps to nearest level BELOW entry', () => {
    const refs = call().reference_levels
    assert.deepEqual(_snapToReference(245.0, refs, 'below', 248), { price: 245.2, ref: 'rl1' })
})
test('snapToReference: long TP snaps to nearest level ABOVE entry', () => {
    const refs = call().reference_levels
    assert.deepEqual(_snapToReference(251.0, refs, 'above', 248), { price: 252.0, ref: 'rl2' })
})
test('snapToReference: no level on the required side → keep price, ref null', () => {
    const refs = [{ id: 'rl1', price: 245 }]
    assert.deepEqual(_snapToReference(260, refs, 'above', 248), { price: 260, ref: null })
})

// ── _finalizeProposal ─────────────────────────────────────────────────────
test('finalizeProposal: snaps stop/TP to structure, clamps size, computes R:R (long)', () => {
    const p = { entry: 248.3, stop: 245.0, take_profit: [{ price: 251.8 }], size: 500, rationale: 'reclaim' }
    const out = _finalizeProposal(p, call(), call().entry_zones[0])
    assert.equal(out.stop, 245.2)
    assert.equal(out.stop_ref, 'rl1')
    assert.equal(out.take_profit[0].price, 252.0)
    assert.equal(out.take_profit[0].ref, 'rl2')
    assert.equal(out.size, 300)                                   // clamped to max_size
    assert.equal(out.rr, Math.round((Math.abs(252 - 248.3) / Math.abs(248.3 - 245.2)) * 100) / 100)
})
test('finalizeProposal: default size = max when none proposed', () => {
    const out = _finalizeProposal({ entry: 248, stop: 245, take_profit: [{ price: 252 }] }, call(), call().entry_zones[0])
    assert.equal(out.size, 300)
})
test('finalizeProposal: short inverts snap sides (stop above, TP below)', () => {
    const c = call({ bias: 'short', reference_levels: [
        { id: 'a', price: 250 }, { id: 'b', price: 245 },
    ] })
    const zone = { id: 'ez1', side: 'short' }
    const out = _finalizeProposal({ entry: 248, stop: 249.5, take_profit: [{ price: 246 }] }, c, zone)
    assert.equal(out.stop, 250)        // nearest ABOVE entry
    assert.equal(out.stop_ref, 'a')
    assert.equal(out.take_profit[0].price, 245)   // nearest BELOW entry
})
test('finalizeProposal: null proposal → null', () => {
    assert.equal(_finalizeProposal(null, call(), null), null)
})

// ── _applyAssessment ──────────────────────────────────────────────────────
test('applyAssessment: enter → ready, arms zone, clamps next check, fires card', () => {
    const raw = {
        verdict: 'enter', timeframe_used: '15min', next_check_min: 999,
        market: { score: 'supportive' }, price_action: { strength: 'strong' },
        proposal: { entry: 248.3, stop: 245, take_profit: [{ price: 252 }] },
        memo_update: 'reclaim confirmed',
    }
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), call().entry_zones[0], raw, NOW, 'zone_trip')
    assert.equal(set.status, 'ready')
    assert.equal(set['monitor_state.armed_zone_id'], 'ez1')
    assert.equal(set['monitor_state.chosen_timeframe'], '15min')
    assert.equal(set['monitor_state.check_count'], 3)                     // 2 → 3
    assert.equal(set['monitor_state.memo'], 'reclaim confirmed')
    assert.equal(set['monitor_state.next_check_at'], new Date(NOW + 60 * 60_000).toISOString())  // clamped to max
    assert.equal(fireCard, true)
    assert.equal(lastAssessment.proposal.stop, 245.2)                     // snapped
    assert.equal(lastAssessment.verdict, 'enter')
})
test('applyAssessment: wait carries the prior memo when no memo_update', () => {
    const raw = { verdict: 'wait', next_check_min: 10 }
    const { set, fireCard } = _applyAssessment(call(), call().entry_zones[0], raw, NOW, 'zone_trip')
    assert.equal(set.status, 'watching')
    assert.equal(set['monitor_state.memo'], 'prior note')   // carried across the wake
    assert.equal(fireCard, false)
})
test('applyAssessment: let_expire → expired, no proposal, fires the expiry card', () => {
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), null, { verdict: 'let_expire', next_check_min: 5 }, NOW, 'expiry_review')
    assert.equal(set.status, 'expired')
    assert.equal(fireCard, true)   // now notifies (expiry card) instead of expiring silently
    assert.equal(lastAssessment.proposal, undefined)
})
test('applyAssessment: edit → expiring + fires card + carries edit_proposal', () => {
    const raw = { verdict: 'edit', next_check_min: 30, edit_proposal: { why: 'roll', changes: {} } }
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), null, raw, NOW, 'expiry_review')
    assert.equal(set.status, 'expiring')
    assert.equal(fireCard, true)
    assert.deepEqual(lastAssessment.edit_proposal, { why: 'roll', changes: {} })
})
test('applyAssessment: off-menu verdict → treated as wait (watching on a zone trip, no card)', () => {
    const raw = { verdict: 'enter_now', next_check_min: 10 }   // typo'd / hallucinated verdict
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), call().entry_zones[0], raw, NOW, 'zone_trip')
    assert.equal(set.status, 'watching')
    assert.equal(fireCard, false)              // never mis-fire an entry card on a garbled verdict
    assert.equal(lastAssessment.verdict, 'wait')
})
test('applyAssessment: edit WITHOUT a usable edit_proposal → wait, no blank re-map card', () => {
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), null, { verdict: 'edit', next_check_min: 30 }, NOW, 'expiry_review')
    assert.equal(fireCard, false)              // don't fire an edit card with empty why/changes
    assert.notEqual(set.status, 'expiring')
    assert.equal(lastAssessment.verdict, 'wait')
})
test('applyAssessment: edit with an empty edit_proposal (blank why, no changes) → wait', () => {
    const raw = { verdict: 'edit', next_check_min: 30, edit_proposal: { why: '  ', changes: {} } }
    const { fireCard, lastAssessment } = _applyAssessment(call(), null, raw, NOW, 'expiry_review')
    assert.equal(fireCard, false)
    assert.equal(lastAssessment.verdict, 'wait')
})
test('hasEditProposal: true only with a non-empty why or at least one change', () => {
    assert.equal(_hasEditProposal({ edit_proposal: { why: 'roll the zone up' } }), true)
    assert.equal(_hasEditProposal({ edit_proposal: { changes: { valid_until: 'x' } } }), true)
    assert.equal(_hasEditProposal({ edit_proposal: { why: '', changes: {} } }), false)
    assert.equal(_hasEditProposal({ edit_proposal: {} }), false)
    assert.equal(_hasEditProposal({}), false)
    assert.equal(_hasEditProposal(null), false)
})

// ── adaptive timeframe (get_chart tool) ───────────────────────────────────────
test('validChartTf: only a rung in the call ladder is honored, else null', () => {
    const ladder = ['day', '1hr', '15min']
    assert.equal(_validChartTf('1hr', ladder), '1hr')
    assert.equal(_validChartTf('day', ladder), 'day')
    assert.equal(_validChartTf('5min', ladder), null)   // not laddered
    assert.equal(_validChartTf('4hr', ladder), null)
    assert.equal(_validChartTf('1hr', undefined), null) // no ladder
})
test('chartTool: builds one get_chart tool with timeframe enum locked to the ladder', () => {
    const [tool] = _chartTool(['day', '1hr', '15min'])
    assert.equal(tool.name, 'get_chart')
    assert.deepEqual(tool.input_schema.properties.timeframe.enum, ['day', '1hr', '15min'])
    assert.deepEqual(tool.input_schema.required, ['timeframe'])
})
test('chartTool: empty / missing ladder falls back to a single 15min rung', () => {
    assert.deepEqual(_chartTool([]) [0].input_schema.properties.timeframe.enum, ['15min'])
    assert.deepEqual(_chartTool(undefined)[0].input_schema.properties.timeframe.enum, ['15min'])
})

// ── structure tools (get_orderblocks / get_false_breaks) in the assess loop ────
test('structureTools: builds OB + false-break + cycle tools with timeframe enum locked to the ladder', () => {
    const tools = _structureTools(['day', '1hr'])
    assert.deepEqual(tools.map(t => t.name), ['get_orderblocks', 'get_false_breaks', 'get_cycle_analysis'])
    for (const t of tools) {
        assert.deepEqual(t.input_schema.properties.timeframe.enum, ['day', '1hr'])
        assert.deepEqual(t.input_schema.required, ['timeframe'])
    }
})
test('structureTools: empty / missing ladder falls back to a single 15min rung', () => {
    assert.deepEqual(_structureTools([])[0].input_schema.properties.timeframe.enum, ['15min'])
    assert.deepEqual(_structureTools(undefined)[1].input_schema.properties.timeframe.enum, ['15min'])
})

test('handleAssessToolUses: dispatches a structure read on a ladder-valid rung', async () => {
    const assistant = [{ type: 'tool_use', id: 'u1', name: 'get_orderblocks', input: { timeframe: '15min' } }]
    const seen = []
    const results = await _handleAssessToolUses(call(), assistant, ['15min'], {
        readStructure: async ({ symbol, timeframe, kind }) => { seen.push({ symbol, timeframe, kind }); return { text: 'OB READ' } },
        renderChart: async () => 'NOPE',
    })
    assert.deepEqual(seen, [{ symbol: 'TSLA', timeframe: '15min', kind: 'orderblocks' }])
    assert.equal(results[0].tool_use_id, 'u1')
    assert.equal(results[0].content, 'OB READ')
    assert.ok(!results[0].is_error)
})

test('handleAssessToolUses: an off-ladder rung errors back instead of rendering', async () => {
    const assistant = [{ type: 'tool_use', id: 'u2', name: 'get_false_breaks', input: { timeframe: '4hr' } }]
    let called = false
    const results = await _handleAssessToolUses(call(), assistant, ['15min'], {
        readStructure: async () => { called = true; return { text: 'x' } },
    })
    assert.equal(called, false)                       // never ran the vision read
    assert.equal(results[0].is_error, true)
    assert.match(results[0].content, /ladder rungs/)
})

test('handleAssessToolUses: get_chart still renders the overlaid chart image', async () => {
    const assistant = [{ type: 'tool_use', id: 'u3', name: 'get_chart', input: { timeframe: '15min' } }]
    const results = await _handleAssessToolUses(call(), assistant, ['15min'], {
        renderChart: async () => 'PNG',
        readStructure: async () => { throw new Error('should not be called for get_chart') },
    })
    assert.equal(results[0].content[0].type, 'image')
    assert.equal(results[0].content[0].source.data, 'PNG')
})

test('handleAssessToolUses: get_cycle_analysis runs a price read on the ladder rung', async () => {
    const assistant = [{ type: 'tool_use', id: 'u4', name: 'get_cycle_analysis', input: { timeframe: '15min' } }]
    const seen = []
    const results = await _handleAssessToolUses(call(), assistant, ['15min'], {
        getCycleAnalysis: async (sym, mode, cw, ly, tf) => { seen.push({ sym, mode, tf }); return 'CYCLE READ' },
    })
    assert.deepEqual(seen, [{ sym: 'TSLA', mode: 'price', tf: '15min' }])
    assert.equal(results[0].content, 'CYCLE READ')
    assert.ok(!results[0].is_error)
})
// ── institutional positioning tools (get_short_interest / options / derivatives) ──
test('institutionalTools: three asset-based positioning tools, NO timeframe required', () => {
    const tools = _institutionalTools()
    assert.deepEqual(tools.map(t => t.name), ['get_short_interest', 'get_options_context', 'get_derivatives_context'])
    for (const t of tools) {
        assert.deepEqual(t.input_schema.properties, {})          // no args — reads the call's own asset
        assert.equal(t.input_schema.required, undefined)          // no timeframe gate
    }
})

test('handleAssessToolUses: a positioning tool dispatches on the asset with NO timeframe (not ladder-gated)', async () => {
    const assistant = [{ type: 'tool_use', id: 'p1', name: 'get_short_interest', input: {} }]
    const seen = []
    const results = await _handleAssessToolUses(call(), assistant, ['15min'], {
        getShortInterest: async (sym) => { seen.push(sym); return 'SI: 12% float, 3 days to cover' },
    })
    assert.deepEqual(seen, ['TSLA'])                              // read the call's asset, no timeframe
    assert.equal(results[0].content, 'SI: 12% float, 3 days to cover')
    assert.ok(!results[0].is_error)                              // NOT rejected for a missing ladder rung
})

test('handleAssessToolUses: options + derivatives positioning reads route to their providers', async () => {
    const assistant = [
        { type: 'tool_use', id: 'p2', name: 'get_options_context', input: {} },
        { type: 'tool_use', id: 'p3', name: 'get_derivatives_context', input: {} },
    ]
    const results = await _handleAssessToolUses(call(), assistant, ['15min'], {
        getOptionsContext:     async () => 'PUT/CALL 0.8, IV 45%',
        getDerivativesContext: async () => 'funding +0.01%, OI up',
    })
    assert.equal(results[0].content, 'PUT/CALL 0.8, IV 45%')
    assert.equal(results[1].content, 'funding +0.01%, OI up')
})

test('applyAssessment: let_expire on a zone trip does NOT expire — call keeps watching, no card', () => {
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), call().entry_zones[0], { verdict: 'let_expire', next_check_min: 15 }, NOW, 'zone_trip')
    assert.equal(set.status, 'watching')          // downgraded to stand_aside → watching, not expired
    assert.equal(fireCard, false)                 // no misleading "thesis expired" card
    assert.equal(lastAssessment.verdict, 'stand_aside')
})
test('applyAssessment: PAST-expiry review still on wait → forced expired + fires the expiry card', () => {
    const PAST = Date.parse('2026-07-09T20:30:00Z')   // 30m past valid_until (20:00Z)
    const { set, fireCard, lastAssessment } = _applyAssessment(call(), null, { verdict: 'wait', next_check_min: 5 }, PAST, 'expiry_review')
    assert.equal(set.status, 'expired')           // hard cutoff — no infinite re-assessment loop
    assert.equal(fireCard, true)
    assert.equal(lastAssessment.verdict, 'let_expire')
})

// ── _scheduledPatch ───────────────────────────────────────────────────────
test('scheduledPatch: idle (no price) reschedules at max gap; failure retries at min gap', () => {
    assert.equal(_scheduledPatch(call(), NOW)['monitor_state.next_check_at'], new Date(NOW + 60 * 60_000).toISOString())
    assert.equal(_scheduledPatch(call(), NOW, true)['monitor_state.next_check_at'], new Date(NOW + 5 * 60_000).toISOString())
    assert.equal(_scheduledPatch(call(), NOW)['monitor_state.check_count'], 3)
})
test('scheduledPatch: proximity tightens the gap when a live price nears a zone', () => {
    const c = call({ cadence: { min_gap_min: 1, max_gap_min: 61 }, entry_zones: [{ id: 'b', lower: 100, upper: 110 }] })
    assert.equal(_scheduledPatch(c, NOW, false, 105)['monitor_state.next_check_at'], new Date(NOW + 1  * 60_000).toISOString()) // near → min
    assert.equal(_scheduledPatch(c, NOW, false, 0)['monitor_state.next_check_at'],   new Date(NOW + 61 * 60_000).toISOString()) // far → max
    assert.equal(_scheduledPatch(c, NOW, false)['monitor_state.next_check_at'],      new Date(NOW + 61 * 60_000).toISOString()) // no price → max
})

// ── _proximityGapMin: graded cadence by distance to the nearest zone ───────
test('proximityGapMin: near a band → min gap, far → max gap, graded between (breakout side symmetric)', () => {
    const c = call({ cadence: { min_gap_min: 1, max_gap_min: 61 },
        entry_zones: [{ id: 'b', lower: 100, upper: 110 }] })   // width 10 → NEAR=2 bands (20), FAR=10 bands (100)
    assert.equal(_proximityGapMin(c, 105, 1, 61), 1)    // inside the band → min
    assert.equal(_proximityGapMin(c, 90,  1, 61), 1)    // 1 band below → min
    assert.equal(_proximityGapMin(c, 80,  1, 61), 1)    // exactly 2 bands (NEAR) → min
    assert.equal(_proximityGapMin(c, 40,  1, 61), 31)   // 6 bands → midpoint
    assert.equal(_proximityGapMin(c, 0,   1, 61), 61)   // exactly 10 bands (FAR) → max
    assert.equal(_proximityGapMin(c, 130, 1, 61), 1)    // 2 bands ABOVE the band → min (approach-from-below/above symmetric)
    assert.equal(_proximityGapMin(c, 210, 1, 61), 61)   // 10 bands above → max
})
test('proximityGapMin: uses the NEAREST of multiple zones', () => {
    const c = call({ cadence: { min_gap_min: 1, max_gap_min: 61 }, entry_zones: [
        { id: 'far',  lower: 100, upper: 110 },   // above by 95 → far
        { id: 'near', lower: 195, upper: 200 },   // above by 5 (1 band) → near wins
    ] })
    assert.equal(_proximityGapMin(c, 205, 1, 61), 1)
})
test('proximityGapMin: non-finite price / no zones / zero-width band → max gap', () => {
    assert.equal(_proximityGapMin(call(), NaN, 1, 61), 61)
    assert.equal(_proximityGapMin(call({ entry_zones: [] }), 100, 1, 61), 61)
    assert.equal(_proximityGapMin(call({ entry_zones: [{ lower: 100, upper: 100 }] }), 100, 1, 61), 61)
})

// ── Out-of-zone momentum pulse (Tier 2) ───────────────────────────────────
test('nearestZoneWidth: nearest usable band width; null when none', () => {
    const c = call({ entry_zones: [{ lower: 100, upper: 110 }, { lower: 195, upper: 200 }] })
    assert.equal(_nearestZoneWidth(c, 205), 5)     // nearest band is [195,200]
    assert.equal(_nearestZoneWidth(c, 90),  10)    // nearest band is [100,110]
    assert.equal(_nearestZoneWidth(call({ entry_zones: [] }), 100), null)
    assert.equal(_nearestZoneWidth(call({ entry_zones: [{ lower: 100, upper: 100 }] }), 100), null) // zero width skipped
})
test('shouldPulse: trips only on a material, throttle-clear, out-of-zone move while waiting + seeded', () => {
    const base = { check_count: 2, memo: '', armed_zone_id: null, pulse_anchor_px: 100, last_pulse_at: null }
    const mk = (extra = {}, ms = {}) => call({ status: 'waiting', entry_zones: [{ id: 'z', lower: 100, upper: 110 }],
        monitor_state: { ...base, ...ms }, ...extra })
    assert.equal(_shouldPulse(mk(), 150, NOW), true)                        // 5 band-widths from anchor, outside → pulse
    assert.equal(_shouldPulse(mk(), 125, NOW), false)                       // 2.5 bands < 4 → no
    assert.equal(_shouldPulse(mk(), 105, NOW), false)                       // inside the band → Tier 1's job
    assert.equal(_shouldPulse(mk({ status: 'ready' }), 150, NOW), false)    // a card is pending → no
    assert.equal(_shouldPulse(mk({}, { pulse_anchor_px: undefined }), 150, NOW), false) // not seeded → no
    assert.equal(_shouldPulse(mk({}, { last_pulse_at: new Date(NOW - 5  * 60_000).toISOString() }), 150, NOW), false) // throttled (<20m)
    assert.equal(_shouldPulse(mk({}, { last_pulse_at: new Date(NOW - 25 * 60_000).toISOString() }), 150, NOW), true)  // throttle cleared
    assert.equal(_shouldPulse(mk(), NaN, NOW), false)                       // non-finite price
    assert.equal(_shouldPulse(mk({ entry_zones: [{ lower: 100, upper: 100 }] }), 150, NOW), false) // no yardstick
})

const pulseCall = (extra = {}) => call({ status: 'waiting', entry_zones: [{ id: 'z', lower: 100, upper: 110 }],
    monitor_state: { check_count: 2, memo: '', armed_zone_id: null, pulse_anchor_px: 100, last_pulse_at: null }, ...extra })

test('checkCall: first out-of-zone wake seeds the pulse anchor (no assess)', async () => {
    const db = fakeDb()
    let assessed = false
    const deps = { getPrice: async () => 270, assess: async () => { assessed = true; return {} }, onCard: async () => {}, isAssetOpen: () => true }
    const out = await _checkCall(db, call({ status: 'waiting' }), NOW, deps)   // call() has no pulse_anchor_px
    assert.equal(out.reason, 'scheduled')
    assert.equal(assessed, false)
    assert.equal(db.updates[0].set['monitor_state.pulse_anchor_px'], 270)      // seeded, no pulse this wake
})
test('checkCall: material out-of-zone move → momentum pulse; edit re-maps and fires a card', async () => {
    const db = fakeDb()
    let carded = null, assessArgs = null
    const deps = {
        getPrice: async () => 150,   // 5 band-widths above the zone → material
        assess:   async (c, zone, ctx) => { assessArgs = { zone, ctx }; return {
            verdict: 'edit', timeframe_used: '15min', next_check_min: 15, read: 'broke out above the range',
            edit_proposal: { why: 'clean breakout the plan did not map', changes: { entry_zones: [{ id: 'z2', lower: 148, upper: 152 }] } },
            memo_update: 're-mapped to the breakout' } },
        onCard:   async (c, a) => { carded = a },
        isAssetOpen: () => true,
    }
    const out = await _checkCall(db, pulseCall(), NOW, deps)
    assert.equal(out.reason, 'momentum_pulse')
    assert.equal(out.verdict, 'edit')
    assert.equal(assessArgs.zone, null)                        // pulse assesses with NO armed zone
    assert.equal(assessArgs.ctx.reason, 'momentum_pulse')
    assert.equal(db.updates[0].set.status, 'expiring')         // edit card flow
    assert.equal(db.updates[0].set['monitor_state.pulse_anchor_px'], 150)                 // re-anchored to the move
    assert.equal(db.updates[0].set['monitor_state.last_pulse_at'], new Date(NOW).toISOString())
    assert.equal(carded.verdict, 'edit')
})
test('checkCall: material move but pulse says noise → wait, no card, still re-anchored (throttle)', async () => {
    const db = fakeDb()
    let carded = false
    const deps = { getPrice: async () => 150, assess: async () => ({ verdict: 'wait', read: 'just noise', next_check_min: 15 }), onCard: async () => { carded = true }, isAssetOpen: () => true }
    const out = await _checkCall(db, pulseCall(), NOW, deps)
    assert.equal(out.reason, 'momentum_pulse')
    assert.equal(out.verdict, 'wait')
    assert.equal(out.fireCard, false)
    assert.equal(carded, false)
    assert.equal(db.updates[0].set['monitor_state.pulse_anchor_px'], 150)
    assert.equal(db.updates[0].set['monitor_state.last_pulse_at'], new Date(NOW).toISOString())
})
test('checkCall: a pulse returning enter is coerced to wait (no direct entry, no card)', async () => {
    const db = fakeDb()
    let carded = false
    const deps = { getPrice: async () => 150, assess: async () => ({ verdict: 'enter', proposal: { entry: 150, stop: 145, take_profit: [{ price: 160 }] }, next_check_min: 15 }), onCard: async () => { carded = true }, isAssetOpen: () => true }
    const out = await _checkCall(db, pulseCall(), NOW, deps)
    assert.equal(out.verdict, 'wait')                          // enter coerced away
    assert.notEqual(db.updates[0].set.status, 'ready')
    assert.equal(carded, false)
})
test('checkCall: sub-threshold out-of-zone move → cheap reschedule, no pulse', async () => {
    const db = fakeDb()
    let assessed = false
    const deps = { getPrice: async () => 125, assess: async () => { assessed = true; return {} }, onCard: async () => {}, isAssetOpen: () => true }
    const out = await _checkCall(db, pulseCall(), NOW, deps)
    assert.equal(out.reason, 'scheduled')
    assert.equal(assessed, false)
})

// ── _checkCall orchestration (injected IO, no DB/LLM) ─────────────────────
function fakeDb() {
    const updates = []
    return { updates, collection: () => ({ updateOne: async (q, u) => { updates.push({ id: q.id, set: u.$set, push: u.$push }) } }) }
}
const pushedEntry = (u) => u.push?.['monitor_state.timeline']?.$each?.[0]

test('checkCall: pre-active (future active_from) → skipped (no price, no assess), sleeps to active_from', async () => {
    const db = fakeDb()
    let priced = false, assessed = false
    const deps = {
        getPrice: async () => { priced = true; return 248.0 },
        assess:   async () => { assessed = true; return {} },
        onCard:   async () => {},
        isAssetOpen: () => true,
    }
    const activeFrom = new Date(NOW + 2 * 3600_000).toISOString()   // 2h out
    const out = await _checkCall(db, call({ active_from: activeFrom }), NOW, deps)
    assert.equal(out.reason, 'pre_active')
    assert.equal(priced, false)                                     // gate short-circuited price fetch
    assert.equal(assessed, false)                                   // and the LLM
    assert.equal(db.updates[0].set['monitor_state.next_check_at'], activeFrom)   // wakes exactly when live
    assert.match(pushedEntry(db.updates[0]).note, /Not live yet/i)
})

test('checkCall: past active_from → gate is transparent, normal path runs', async () => {
    const db = fakeDb()
    let assessed = false
    const deps = { getPrice: async () => 250, assess: async () => { assessed = true; return {} }, onCard: async () => {}, isAssetOpen: () => true }
    const out = await _checkCall(db, call({ active_from: new Date(NOW - 3600_000).toISOString() }), NOW, deps)
    assert.equal(out.reason, 'scheduled')                           // active_from already passed → not gated
    assert.equal(assessed, false)                                   // 250 in no zone → cheap path (unrelated to the gate)
})

test('checkCall: no zone + not expiring → cheap scheduled path, no assessment', async () => {
    const db = fakeDb()
    let assessed = false
    const deps = { getPrice: async () => 270, assess: async () => { assessed = true; return {} }, onCard: async () => {}, isAssetOpen: () => true }
    const out = await _checkCall(db, call(), NOW, deps)
    assert.equal(out.reason, 'scheduled')
    assert.equal(assessed, false)                                   // gate short-circuited the LLM
    assert.equal(db.updates[0].set['monitor_state.next_check_at'], new Date(NOW + 60 * 60_000).toISOString()) // 270 is >10 band-widths from every zone → max gap
})

test('checkCall: price in a zone → assessment runs, verdict persisted, card fired on enter', async () => {
    const db = fakeDb()
    let carded = null
    const deps = {
        getPrice: async () => 248.0,   // inside ez1
        assess:   async (c, zone) => ({ verdict: 'enter', timeframe_used: '15min', next_check_min: 20, proposal: { entry: 248, stop: 245, take_profit: [{ price: 252 }] }, memo_update: 'go' }),
        onCard:   async (c, a) => { carded = a },
        isAssetOpen: () => true,
    }
    const out = await _checkCall(db, call(), NOW, deps)
    assert.equal(out.reason, 'zone_trip')
    assert.equal(out.verdict, 'enter')
    assert.equal(db.updates[0].set.status, 'ready')
    assert.equal(db.updates[0].set['monitor_state.armed_zone_id'], 'ez1')
    assert.equal(carded.verdict, 'enter')
})

test('checkCall: failed assessment → retry-soon reschedule, no card', async () => {
    const db = fakeDb()
    let carded = false
    const deps = { getPrice: async () => 248.0, assess: async () => null, onCard: async () => { carded = true }, isAssetOpen: () => true }
    const out = await _checkCall(db, call(), NOW, deps)
    assert.equal(out.failed, true)
    assert.equal(carded, false)
    assert.equal(db.updates[0].set['monitor_state.next_check_at'], new Date(NOW + 5 * 60_000).toISOString())  // min gap
})

test('checkCall: near expiry runs assessment even with no zone tripped', async () => {
    const db = fakeDb()
    const expiringCall = call({ valid_until: new Date(NOW + 5 * 60_000).toISOString() })  // 5m from now
    const deps = { getPrice: async () => 250, assess: async () => ({ verdict: 'let_expire', next_check_min: 5 }), onCard: async () => {}, isAssetOpen: () => true }
    const out = await _checkCall(db, expiringCall, NOW, deps)
    assert.equal(out.reason, 'expiry_review')
    assert.equal(db.updates[0].set.status, 'expired')
})

test('checkCall: market CLOSED + not expiring → skipped (no price, no assess), rescheduled', async () => {
    const db = fakeDb()
    let priced = false, assessed = false
    const deps = {
        getPrice: async () => { priced = true; return 248.0 },
        assess:   async () => { assessed = true; return {} },
        onCard:   async () => {},
        isAssetOpen: () => false,   // market shut for this asset
    }
    const out = await _checkCall(db, call(), NOW, deps)
    assert.equal(out.reason, 'closed')
    assert.equal(priced, false)
    assert.equal(assessed, false)
    assert.equal(db.updates[0].set['monitor_state.next_check_at'], new Date(NOW + 60 * 60_000).toISOString())
})

test('checkCall: a watching call that leaves the zone resets to waiting', async () => {
    const db = fakeDb()
    const deps = { getPrice: async () => 250, assess: async () => ({}), onCard: async () => {}, isAssetOpen: () => true }
    await _checkCall(db, call({ status: 'watching' }), NOW, deps)   // 250 is in no zone → scheduled path
    assert.equal(db.updates[0].set.status, 'waiting')
})

test('checkCall: market CLOSED sleeps until the next open + clears stale watching', async () => {
    const db = fakeDb()
    const openMs = NOW + 3 * 3600_000
    const deps = { getPrice: async () => 248, assess: async () => ({}), onCard: async () => {}, isAssetOpen: () => false, nextOpenMs: () => openMs }
    const out = await _checkCall(db, call({ status: 'watching' }), NOW, deps)
    assert.equal(out.reason, 'closed')
    assert.equal(db.updates[0].set.status, 'waiting')                                            // stale watching cleared
    assert.equal(db.updates[0].set['monitor_state.next_check_at'], new Date(openMs).toISOString())  // sleeps to the open
})

test('checkCall: market CLOSED but EXPIRING → expiry review still runs', async () => {
    const db = fakeDb()
    const expiringCall = call({ valid_until: new Date(NOW + 5 * 60_000).toISOString() })
    const deps = {
        getPrice: async () => 250,
        assess:   async () => ({ verdict: 'let_expire', next_check_min: 5 }),
        onCard:   async () => {},
        isAssetOpen: () => false,
    }
    const out = await _checkCall(db, expiringCall, NOW, deps)
    assert.equal(out.reason, 'expiry_review')
    assert.equal(db.updates[0].set.status, 'expired')
})

// ── _zonesLabel + _timelineEntry (the live monitor journal) ────────────────
test('zonesLabel: joins bands and flags multi', () => {
    assert.deepEqual(_zonesLabel(call()), { text: '247.4–248.6, 244.8–245.2', multi: true })
    assert.equal(_zonesLabel(call({ entry_zones: [{ lower: 100, upper: 101 }] })).multi, false)
    assert.equal(_zonesLabel(call({ entry_zones: [] })).text, '(no zones)')
})

test('timelineEntry: closed wake → holding note, no price, deterministic at', () => {
    const e = _timelineEntry('closed', { nowMs: NOW, call: call(), nextAt: new Date(NOW + 3600_000).toISOString() })
    assert.equal(e.reason, 'closed')
    assert.equal(e.price, null)
    assert.equal(e.verdict, null)
    assert.equal(e.at, new Date(NOW).toISOString())
    assert.match(e.note, /closed/i)
})

test('timelineEntry: scheduled heartbeat → price, zones and gap in the note', () => {
    const e = _timelineEntry('scheduled', { nowMs: NOW, price: 250, call: call(), nextAt: new Date(NOW + 30 * 60_000).toISOString() })
    assert.equal(e.price, 250)
    assert.match(e.note, /250/)
    assert.match(e.note, /247.4–248.6/)
    assert.match(e.note, /30m/)
})

test('timelineEntry: assessment uses the model read + carries verdict/axes', () => {
    const raw = { verdict: 'wait', read: 'coiling under the zone, no trigger yet',
        market: { read: 'calm', score: 'neutral' }, patterns_seen: [{ id: 'p1', present: true, note: 'flag' }] }
    const e = _timelineEntry('zone_trip', { nowMs: NOW, price: 248, zone: call().entry_zones[0], call: call(), raw, nextAt: new Date(NOW + 15 * 60_000).toISOString(), fetched: 'chart 15min' })
    assert.equal(e.verdict, 'wait')
    assert.equal(e.note, 'coiling under the zone, no trigger yet')
    assert.equal(e.zone_id, 'ez1')
    assert.equal(e.fetched, 'chart 15min')
    assert.equal(e.axes.market.score, 'neutral')
    assert.equal(e.axes.patterns_seen.length, 1)
})

test('timelineEntry: assessment with no read → verdict fallback note', () => {
    const e = _timelineEntry('zone_trip', { nowMs: NOW, price: 248, zone: call().entry_zones[0], call: call(), raw: { verdict: 'stand_aside' }, nextAt: null })
    assert.match(e.note, /standing aside/i)
})

test('timelineEntry: failed assessment → honest retry note, no verdict', () => {
    // Default/io failure: the read itself didn't complete.
    const io = _timelineEntry('zone_trip', { nowMs: NOW, price: 248, call: call(), failed: true, nextAt: null })
    assert.match(io.note, /didn't complete — retrying/i)
    assert.equal(io.verdict, null)
    // Unparseable-reply failure (truncated/malformed): honest that the reply was bad, not a fetch failure.
    const bad = _timelineEntry('zone_trip', { nowMs: NOW, price: 248, call: call(), failed: true, failReason: 'truncated', nextAt: null })
    assert.match(bad.note, /reply came back malformed — retrying/i)
    assert.equal(bad.verdict, null)
})

// ── _checkCall appends a journal entry on EVERY wake ──────────────────────
test('checkCall: scheduled heartbeat appends a capped journal entry', async () => {
    const db = fakeDb()
    const deps = { getPrice: async () => 250, assess: async () => ({}), onCard: async () => {}, isAssetOpen: () => true }
    await _checkCall(db, call(), NOW, deps)
    const entry = pushedEntry(db.updates[0])
    assert.ok(entry)
    assert.equal(entry.reason, 'scheduled')
    assert.equal(entry.price, 250)
    assert.equal(db.updates[0].push['monitor_state.timeline'].$slice, -80)   // append-only, capped (TIMELINE_MAX)
})

test('checkCall: assessment wake appends an entry with the verdict + read', async () => {
    const db = fakeDb()
    const deps = { getPrice: async () => 248, assess: async () => ({ verdict: 'wait', read: 'not yet', next_check_min: 15 }), onCard: async () => {}, isAssetOpen: () => true }
    await _checkCall(db, call(), NOW, deps)
    const entry = pushedEntry(db.updates[0])
    assert.equal(entry.reason, 'zone_trip')
    assert.equal(entry.verdict, 'wait')
    assert.equal(entry.note, 'not yet')
    assert.ok(entry.fetched)
})

test('checkCall: closed wake appends a holding entry', async () => {
    const db = fakeDb()
    const deps = { getPrice: async () => 248, assess: async () => ({}), onCard: async () => {}, isAssetOpen: () => false, nextOpenMs: () => NOW + 3600_000 }
    await _checkCall(db, call(), NOW, deps)
    assert.equal(pushedEntry(db.updates[0]).reason, 'closed')
})

// ── _withTimeout: a hung check can't wedge the loop ────────────────────────
test('withTimeout: rejects a hung promise after ms (loop self-heals)', async () => {
    await assert.rejects(_withTimeout(new Promise(() => {}), 20), /timed out/)
})
test('withTimeout: passes a fast resolve straight through', async () => {
    assert.equal(await _withTimeout(Promise.resolve('ok'), 1000), 'ok')
})
test('withTimeout: a rejecting check surfaces its own error', async () => {
    await assert.rejects(_withTimeout(Promise.reject(new Error('boom')), 1000), /boom/)
})

// ── _thinkingConfig: reasoning-effort → adaptive thinking ─────────────────
test('thinkingConfig: off / undefined / invalid → null (no thinking, zero cost)', () => {
    assert.equal(_thinkingConfig('off'), null)
    assert.equal(_thinkingConfig(undefined), null)
    assert.equal(_thinkingConfig('bogus'), null)
})
test('thinkingConfig: low/high → adaptive thinking with matching effort (never budget_tokens)', () => {
    assert.deepEqual(_thinkingConfig('low'),  { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } })
    assert.deepEqual(_thinkingConfig('high'), { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
    assert.ok(!('budget_tokens' in _thinkingConfig('high').thinking))
})

// ── _assessText: find the text block even past a thinking block ────────────
test('assessText: returns the text block when it is first (no thinking)', () => {
    assert.equal(_assessText({ content: [{ type: 'text', text: '{"verdict":"wait"}' }] }), '{"verdict":"wait"}')
})
test('assessText: skips a leading thinking block to find the JSON text', () => {
    const msg = { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '{"verdict":"enter"}' }] }
    assert.equal(_assessText(msg), '{"verdict":"enter"}')
})
test('assessText: no text block / malformed → empty string (safe for _extractJSON)', () => {
    assert.equal(_assessText({ content: [{ type: 'thinking', thinking: 'x' }] }), '')
    assert.equal(_assessText({}), '')
    assert.equal(_assessText(null), '')
})

// ── _formatHeadlines: real news → the block the news axis is scored from ───
test('formatHeadlines: dates + orders as given, prefixes [YYYY-MM-DD]', () => {
    const arts = [
        { datetime: Date.parse('2026-07-11T14:00:00Z') / 1000, headline: 'TSLA beats on deliveries' },
        { datetime: Date.parse('2026-07-10T09:30:00Z') / 1000, headline: 'Analyst upgrade' },
    ]
    assert.equal(_formatHeadlines(arts), '[2026-07-11] TSLA beats on deliveries\n[2026-07-10] Analyst upgrade')
})
test('formatHeadlines: no articles / null → empty string (caller stamps the unsourced line)', () => {
    assert.equal(_formatHeadlines([]), '')
    assert.equal(_formatHeadlines(null), '')
    assert.equal(_formatHeadlines(undefined), '')
})
test('formatHeadlines: drops entries with no headline, keeps the rest', () => {
    const arts = [
        { datetime: 1_800_000_000, headline: '' },
        { datetime: 1_800_000_000, headline: 'Real one' },
        { datetime: 1_800_000_000 },
    ]
    assert.equal(_formatHeadlines(arts), '[2027-01-15] Real one')
})
test('formatHeadlines: NaN/missing datetime → placeholder date, still included', () => {
    assert.equal(_formatHeadlines([{ datetime: NaN, headline: 'Undated' }]), '[????-??-??] Undated')
})
test('formatHeadlines: caps at the 12 newest given (no 13th row)', () => {
    const arts = Array.from({ length: 20 }, (_, i) => ({ datetime: 1_800_000_000, headline: `H${i}` }))
    const lines = _formatHeadlines(arts).split('\n')
    assert.equal(lines.length, 12)
    assert.ok(lines[0].endsWith('H0'))
    assert.ok(lines[11].endsWith('H11'))
})

// ── _marketBlock: sensitivity-gated live broad-market framing ──────────────
test('marketBlock: low/absent sensitivity → "not material" (ignores any market text)', () => {
    assert.match(_marketBlock({ market_sensitivity: { level: 'low', drivers: [] } }, 'SPY: $500 (-2%)'), /not material/)
    assert.match(_marketBlock({}, ''), /not material/)                       // absent → immaterial
    assert.match(_marketBlock({ market_sensitivity: { level: 'bogus' } }, 'x'), /not material/)
})
test('marketBlock: sensitive + live read → presents level, drivers, and the quotes', () => {
    const call = { market_sensitivity: { level: 'high', drivers: ['QQQ', 'SMH'] } }
    const out = _marketBlock(call, 'SPY: $500.00 (0.40%)\nQQQ: $440.00 (0.60%)\n^VIX: $14.00 (-3.00%)')
    assert.match(out, /high-sensitivity/)
    assert.match(out, /drivers: QQQ, SMH/)
    assert.match(out, /\^VIX: \$14\.00/)
})
test('marketBlock: sensitive but read failed (empty) → explicit unavailable', () => {
    assert.match(_marketBlock({ market_sensitivity: { level: 'medium', drivers: [] } }, ''), /unavailable/)
})

// ── Slice 2: browse-confirm second pass (pure pieces) ──────────────────────
test('isMarketSensitive: high/medium true, low/absent/garbage false', () => {
    assert.equal(_isMarketSensitive({ market_sensitivity: { level: 'high' } }), true)
    assert.equal(_isMarketSensitive({ market_sensitivity: { level: 'medium' } }), true)
    assert.equal(_isMarketSensitive({ market_sensitivity: { level: 'low' } }), false)
    assert.equal(_isMarketSensitive({}), false)
    assert.equal(_isMarketSensitive(null), false)
})
test('applyEntryConfirmation: confirm=false downgrades enter→wait, carries reason, drops proposal', () => {
    const raw = { verdict: 'enter', read: 'go', proposal: { entry: 100 }, next_check_min: 20 }
    const out = _applyEntryConfirmation(raw, { confirm: false, reason: 'SPY -1.8%, VIX spiking' })
    assert.equal(out.verdict, 'wait')
    assert.equal(out.proposal, undefined)
    assert.match(out.read, /Stood aside/)
    assert.match(out.memo_update, /SPY -1\.8%/)
    assert.equal(out.next_check_min, 20)            // untouched fields preserved
})
test('applyEntryConfirmation: confirm=false with only backdrop → uses backdrop as reason', () => {
    const out = _applyEntryConfirmation({ verdict: 'enter' }, { confirm: false, backdrop: 'broad risk-off' })
    assert.match(out.memo_update, /broad risk-off/)
})
test('applyEntryConfirmation: fail-open — confirm=true, missing, or unparseable keeps the enter', () => {
    const raw = { verdict: 'enter', proposal: { entry: 100 } }
    assert.deepEqual(_applyEntryConfirmation(raw, { confirm: true }), raw)
    assert.deepEqual(_applyEntryConfirmation(raw, null), raw)             // browse failed → keep enter
    assert.deepEqual(_applyEntryConfirmation(raw, {}), raw)               // no confirm field → keep
    assert.deepEqual(_applyEntryConfirmation(raw, { confirm: 'yes' }), raw) // non-false truthy → keep
})
test('allText: joins every text block, skips tool_use / web_search_tool_result blocks', () => {
    const msg = { content: [
        { type: 'text', text: 'searching…' },
        { type: 'server_tool_use', id: 't1', name: 'web_search', input: { query: 'SPY today' } },
        { type: 'web_search_tool_result', tool_use_id: 't1', content: [] },
        { type: 'text', text: '{"confirm":false,"reason":"risk-off"}' },
    ] }
    assert.equal(_allText(msg), 'searching…\n{"confirm":false,"reason":"risk-off"}')
    assert.equal(_allText({}), '')
})

// ── _formatEventRisk: frozen scheduled catalysts → the block Hermes weighs ──
test('formatEventRisk: earnings + macro formatted with when + impact', () => {
    const events = [
        { type: 'earnings', label: 'TSLA earnings', date: '2026-07-15', when: 'pre_market', impact: 'high' },
        { type: 'fomc', label: 'FOMC Rate Decision', date: '2026-07-29', when: 'timed', time: '2:00p', impact: 'high' },
    ]
    assert.equal(
        _formatEventRisk(events),
        '2026-07-15 — TSLA earnings (pre_market, high impact)\n2026-07-29 — FOMC Rate Decision (2:00p, high impact)',
    )
})
test('formatEventRisk: none / null → empty string (caller stamps the "(none)" line)', () => {
    assert.equal(_formatEventRisk([]), '')
    assert.equal(_formatEventRisk(null), '')
    assert.equal(_formatEventRisk(undefined), '')
})
test('formatEventRisk: drops rows missing date or label', () => {
    const events = [
        { type: 'macro', label: 'CPI', date: '' },
        { type: 'macro', date: '2026-07-20' },
        { type: 'earnings', label: 'AAPL earnings', date: '2026-07-18', when: 'after_hours', impact: 'high' },
    ]
    assert.equal(_formatEventRisk(events), '2026-07-18 — AAPL earnings (after_hours, high impact)')
})
test('formatEventRisk: timed event with no time → falls back to "timed"', () => {
    assert.equal(_formatEventRisk([{ label: 'PPI', date: '2026-07-16', when: 'timed', impact: 'medium' }]), '2026-07-16 — PPI (timed, medium impact)')
})

// ── Phase 5 slice 1: position lifecycle reconcile ──────────────────────────
function posCall(status, extra = {}) {
    return {
        id: 'call_TSLA_x', asset: 'TSLA', status, linked_idea_id: 'idea1',
        cadence: { min_gap_min: 5, max_gap_min: 15 },
        monitor_state: { check_count: 3 },
        position_state: {
            linked_idea_id: 'idea1',
            entry: { fill_price: null, intended: 248.3, fill_at: null, size: 220, direction: 'long', account_id: 'p1' },
            stop:  { current: 245.2, initial: 245.2, ref: 'rl1' },
            targets: [], taken: [], phase: 'running', outcome: null,
        },
        ...extra,
    }
}

test('rMultiple: signed by direction; null unless finite + risk>0', () => {
    assert.equal(_rMultiple(100, 110, 95, 'long'), 2)     // +10 / 5
    assert.equal(_rMultiple(100, 90, 105, 'short'), 2)    // short fell: (100-90)/5
    assert.equal(_rMultiple(100, 110, 100, 'long'), null) // zero risk
    assert.equal(_rMultiple(100, null, 95, 'long'), null) // non-finite exit
})

test('reconcile: confirmed + idea still looking → idle reschedule (no promotion)', () => {
    const { set, entry } = _reconcilePosition(posCall('confirmed'), { id: 'idea1', status: 'looking' }, NOW)
    assert.equal(set.status, undefined)                  // no status change
    assert.equal(entry, null)
    assert.equal(set['monitor_state.check_count'], 4)
    assert.ok(set['monitor_state.next_check_at'] > new Date(NOW).toISOString())
})

test('reconcile: idea long, not yet promoted (no fill_at) → promote, stamp fill, open journal', () => {
    const idea = { id: 'idea1', status: 'long', direction: 'long', quantity: 220, entryTriggeredAt: NOW }
    const { set, entry } = _reconcilePosition(posCall('long'), idea, NOW)
    assert.equal(set.status, undefined)                          // P3b: converged status stays 'long', not overwritten
    assert.equal(set['position_state.entry.fill_price'], 248.3)  // best-effort = intended (slice 1)
    assert.ok(set['position_state.entry.fill_at'] != null)       // promotion is RECORDED by fill_at
    assert.equal(set['position_state.entry.size'], 220)
    assert.equal(set['position_state.phase'], 'running')
    assert.equal(entry.reason, 'entry')
    assert.equal(entry.phase, 'in_position')
    assert.match(entry.note, /Filled TSLA at 248.3/)
})

test('reconcile: promote sources the REAL fill from the trades ledger (not intended)', () => {
    const idea  = { id: 'idea1', status: 'long', direction: 'long', quantity: 220, entryTriggeredAt: NOW }
    const { set } = _reconcilePosition(posCall('confirmed'), idea, NOW, { entry: { price: 249.1 } })
    assert.equal(set['position_state.entry.fill_price'], 249.1)   // ledger fill, not intended 248.3
})

test('reconcile: close sources exit price + realized P&L + R from the ledger', () => {
    const ps = posCall('in_position')
    ps.position_state.entry.fill_price = 248
    ps.position_state.stop.initial = 245
    const idea  = { id: 'idea1', status: 'closed', closedReason: 'tp', closedAt: NOW }
    const trade = { entry: { price: 248 }, exit: { price: 251, realizedPnl: 300, reason: 'tp' } }
    const { set, entry } = _reconcilePosition(ps, idea, NOW, trade)
    assert.equal(set.status, 'closed')
    const o = set['position_state.outcome']
    assert.equal(o.exit_price, 251)
    assert.equal(o.pnl, 300)
    assert.equal(o.r_multiple, 1)          // (251-248)/(248-245)
    assert.match(entry.note, /\+1R/)
})

test('reconcile: confirmed + idea already closed → straight to closed with outcome', () => {
    const idea = { id: 'idea1', status: 'closed', closedReason: 'stop', realizedPnl: -110, closedAt: NOW }
    const { set, entry } = _reconcilePosition(posCall('confirmed'), idea, NOW)
    assert.equal(set.status, 'closed')
    assert.equal(set['position_state.outcome'].reason, 'stop')
    assert.equal(set['position_state.outcome'].pnl, -110)
    assert.equal(entry.reason, 'close')
})

test('reconcile: in_position + idea closed → outcome + close journal (reason from idea)', () => {
    const idea = { id: 'idea1', status: 'closed', closedReason: 'tp', realizedPnl: 330, closedAt: NOW }
    const ps = posCall('in_position')
    ps.position_state.entry.fill_price = 248.3
    const { set, entry } = _reconcilePosition(ps, idea, NOW)
    assert.equal(set.status, 'closed')
    assert.equal(set['position_state.outcome'].reason, 'tp')
    assert.equal(set['position_state.outcome'].pnl, 330)
    assert.equal(entry.next_check_at, null)
    assert.match(entry.note, /closed on TSLA — tp/)
})

test('reconcile: idea long, already promoted (fill_at set) → manage (routes to the brain)', () => {
    const ps = posCall('long')
    ps.position_state.entry.fill_at = new Date(NOW).toISOString()
    const rec = _reconcilePosition(ps, { id: 'idea1', status: 'long' }, NOW)
    assert.equal(rec.manage, true)
    assert.equal(rec.set, undefined)
})

test('reconcile: linked idea not found → idle reschedule', () => {
    const { set, entry } = _reconcilePosition(posCall('confirmed'), null, NOW)
    assert.equal(set.status, undefined)
    assert.equal(entry, null)
    assert.equal(set['monitor_state.check_count'], 4)
})

test('_checkPosition: reads the (self) call via deps.getIdea and persists the reconcile', async () => {
    const updates = []
    const db = { collection: () => ({ updateOne: async (_q, u) => updates.push(u) }) }
    const deps = { getIdea: async () => ({ id: 'idea1', status: 'long', direction: 'long', quantity: 220, entryTriggeredAt: NOW }) }
    const res = await _checkPosition(db, posCall('long'), NOW, deps)
    assert.equal(res.status, 'long')                                     // converged status unchanged by promote
    assert.ok(updates[0].$set['position_state.entry.fill_at'] != null)   // promotion stamped
    assert.ok(updates[0].$push['monitor_state.timeline'])                // journal entry appended
})

// ── P2: re-entry offer at a stop-out ──────────────────────────────────────
test('isStopOut: stop / adverse-broker close only (tp + manual do not offer re-entry)', () => {
    assert.equal(_isStopOut({ reason: 'stop' }), true)
    assert.equal(_isStopOut({ reason: 'tp' }), false)
    assert.equal(_isStopOut({ reason: 'manual' }), false)
    assert.equal(_isStopOut({ reason: 'broker', r_multiple: -0.8 }), true)   // unlabeled adverse close
    assert.equal(_isStopOut({ reason: 'broker', r_multiple: 1.2 }), false)
    assert.equal(_isStopOut(null), false)
})
test('_checkPosition: stop-out with thesis intact → re-entry card fired + marker set', async () => {
    const updates = []
    const db = { collection: () => ({ updateOne: async (_q, u) => updates.push(u) }) }
    let reentryArgs = null, seenOutcome = null
    const deps = {
        getIdea:       async () => ({ id: 'idea1', status: 'closed', closedReason: 'stop', realizedPnl: -110, closedAt: NOW }),
        assessReentry: async (c, outcome) => { seenOutcome = outcome; return { thesis_alive: true, why: 'structure intact, just a stop run', read: 'stopped but the trend holds' } },
        onReentry:     async (c, read, outcome) => { reentryArgs = { read, outcome } },
    }
    const res = await _checkPosition(db, posCall('in_position'), NOW, deps)
    assert.equal(res.status, 'closed')
    assert.equal(seenOutcome.reason, 'stop')
    const u = updates.find(x => x.$set['position_state.reentry'])
    assert.equal(u.$set['position_state.reentry'].offered, true)
    assert.match(u.$push['monitor_state.timeline'].$each[0].note, /thesis still looks intact/)
    assert.equal(reentryArgs.read.thesis_alive, true)
})
test('_checkPosition: stop-out with thesis broken → no card, journals standing down', async () => {
    const updates = []
    const db = { collection: () => ({ updateOne: async (_q, u) => updates.push(u) }) }
    let carded = false
    const deps = {
        getIdea:       async () => ({ id: 'idea1', status: 'closed', closedReason: 'stop', realizedPnl: -110, closedAt: NOW }),
        assessReentry: async () => ({ thesis_alive: false, why: 'lost the range and the trend' }),
        onReentry:     async () => { carded = true },
    }
    await _checkPosition(db, posCall('in_position'), NOW, deps)
    assert.equal(carded, false)
    const u = updates.find(x => x.$set['position_state.reentry'])
    assert.equal(u.$set['position_state.reentry'].offered, false)
    assert.match(u.$push['monitor_state.timeline'].$each[0].note, /standing down/)
})
test('_checkPosition: TP close → no re-entry offer (trade worked)', async () => {
    const updates = []
    const db = { collection: () => ({ updateOne: async (_q, u) => updates.push(u) }) }
    let assessed = false
    const deps = {
        getIdea:       async () => ({ id: 'idea1', status: 'closed', closedReason: 'tp', realizedPnl: 330, closedAt: NOW }),
        assessReentry: async () => { assessed = true; return { thesis_alive: true } },
        onReentry:     async () => {},
    }
    const res = await _checkPosition(db, posCall('in_position'), NOW, deps)
    assert.equal(res.status, 'closed')
    assert.equal(assessed, false)                                            // TP → _isStopOut false → never assessed
    assert.equal(updates.find(x => x.$set['position_state.reentry']), undefined)
})
test('_checkPosition: stop-out but re-entry read fails → no card, leaves it closed', async () => {
    const updates = []
    const db = { collection: () => ({ updateOne: async (_q, u) => updates.push(u) }) }
    let carded = false
    const deps = {
        getIdea:       async () => ({ id: 'idea1', status: 'closed', closedReason: 'stop', closedAt: NOW }),
        assessReentry: async () => { throw new Error('llm down') },
        onReentry:     async () => { carded = true },
    }
    await _checkPosition(db, posCall('in_position'), NOW, deps)
    assert.equal(carded, false)
    const u = updates.find(x => x.$set['position_state.reentry'])
    assert.equal(u.$set['position_state.reentry'].offered, false)
    assert.match(u.$push['monitor_state.timeline'].$each[0].note, /couldn't assess/)
})

// ── Phase 5 slice 2: in-position management brain ──────────────────────────
function mgmtCall(psExtra = {}, extra = {}) {
    return {
        id: 'call_TSLA_x', asset: 'TSLA', trade_type: 'day', linked_idea_id: 'idea1',
        cadence: { min_gap_min: 1, max_gap_min: 15 },
        reference_levels: [
            { id: 'rl1', kind: 'support', price: 246 },
            { id: 'rl2', kind: 'entry',   price: 248 },
            { id: 'rl3', kind: 'target',  price: 252 },
            { id: 'rl4', kind: 'target',  price: 256 },
        ],
        monitor_state: { check_count: 5 }, status: 'in_position',
        position_state: {
            entry: { fill_price: 248, intended: 248, fill_at: new Date(NOW - 60 * 60_000).toISOString(), size: 100, direction: 'long' },
            stop:  { current: 245, initial: 245, ref: 'rl1' },   // risk 3 -> adverse band 0.75
            targets: [{ id: 'tg1', price: 252, ref: 'rl3', hit_at: null }, { id: 'tg2', price: 256, ref: 'rl4', hit_at: null }],
            taken: [], metrics: { r_multiple_now: null, mae: null, mfe: null }, phase: 'running',
            memo: '', pending_action: null, last_management: null, outcome: null,
            ...psExtra,
        },
        ...extra,
    }
}

test('computeMetrics: R + carried mae/mfe extremes', () => {
    const m1 = _computeMetrics(mgmtCall().position_state, 251, NOW)
    assert.equal(m1.r_multiple_now, 1)          // (251-248)/3
    assert.equal(m1.mae, 0); assert.equal(m1.mfe, 1)
    const m2 = _computeMetrics(mgmtCall({ metrics: { mae: 0, mfe: 1 } }).position_state, 246, NOW)
    assert.equal(m2.r_multiple_now, -0.67)      // (246-248)/3
    assert.equal(m2.mae, -0.67); assert.equal(m2.mfe, 1)   // adverse deepens, favorable holds
})

test('positionGate: adverse > scale_out > breakeven; else null', () => {
    assert.equal(_positionGate(mgmtCall().position_state, 245.5).flag, 'adverse')     // <= stop+band
    assert.equal(_positionGate(mgmtCall().position_state, 252).flag, 'scale_out')     // target touched
    assert.equal(_positionGate(mgmtCall().position_state, 251.5).flag, 'breakeven')   // >=+1R, stop unprotected
    assert.equal(_positionGate(mgmtCall().position_state, 249).flag, null)            // mid-range -> hold
})
test('positionGate: breakeven suppressed once stop is at/above entry', () => {
    assert.equal(_positionGate(mgmtCall({ stop: { current: 248, initial: 245 } }).position_state, 251.5).flag, null)
})

test('reviewDue: stale/never -> due; recent -> not due', () => {
    assert.equal(_reviewDue(mgmtCall().position_state, NOW, { max_gap_min: 15 }), true)   // fill 60m ago, no mgmt
    const recent = mgmtCall({ last_management: { at: new Date(NOW - 5 * 60_000).toISOString() } }).position_state
    assert.equal(_reviewDue(recent, NOW, { max_gap_min: 15 }), false)
})

test('finalizePositionProposal: snaps stop/tp, clamps size, handles cancel/exit', () => {
    const refs = mgmtCall().reference_levels
    const ms = _finalizePositionProposal('move_stop', { new_stop: 247.3, reason: 'trail' }, refs, true, 251)
    assert.equal(ms.new_stop, 248); assert.equal(ms.ref, 'rl2')      // nearest ref below price
    assert.equal(_finalizePositionProposal('take_partial', { size_pct: 150 }, refs, true, 251).size_pct, 100)
    assert.equal(_finalizePositionProposal('take_partial', {}, refs, true, 251).size_pct, 50)
    const lr = _finalizePositionProposal('let_run', { new_tp: 257 }, refs, true, 255)
    assert.equal(lr.new_tp, 256); assert.equal(lr.ref, 'rl4')
    assert.deepEqual(_finalizePositionProposal('let_run', { cancel_tp: true }, refs, true, 255), { cancel_tp: true, reason: null })
    assert.deepEqual(_finalizePositionProposal('exit_now', { reason: 'thesis broke' }, refs, true, 249), { reason: 'thesis broke' })
})

const M = () => _computeMetrics(mgmtCall().position_state, 251, NOW)   // dummy metrics for apply()

test('applyPositionAssessment: hold -> no card, no pending write', () => {
    const { set, entry, fireCard } = _applyPositionAssessment(mgmtCall(), mgmtCall().position_state, { verdict: 'hold', read: 'working - holding' }, 251, M(), NOW, 'review')
    assert.equal(fireCard, false)
    assert.equal('position_state.pending_action' in set, false)
    assert.equal(entry.verdict, 'hold')
    assert.match(entry.note, /holding/i)
})
test('applyPositionAssessment: move_stop -> sets pending_action + fires card', () => {
    const { set, fireCard, card } = _applyPositionAssessment(mgmtCall(), mgmtCall().position_state, { verdict: 'move_stop', proposal: { new_stop: 247.3 }, read: 'trailing up' }, 251, M(), NOW, 'breakeven')
    assert.equal(fireCard, true)
    assert.equal(set['position_state.pending_action'].verdict, 'move_stop')
    assert.equal(set['position_state.pending_action'].severity, 3)
    assert.equal(set['position_state.pending_action'].proposal.new_stop, 248)
    assert.equal(card.verdict, 'move_stop')
})
test('applyPositionAssessment: exit_now ESCALATES over a pending take_partial', () => {
    const ps = mgmtCall({ pending_action: { verdict: 'take_partial', severity: 2, proposal: {} } }).position_state
    const { set, fireCard } = _applyPositionAssessment(mgmtCall(), ps, { verdict: 'exit_now', proposal: { reason: 'broke' } }, 244, M(), NOW, 'adverse')
    assert.equal(fireCard, true)
    assert.equal(set['position_state.pending_action'].verdict, 'exit_now')
})
test('applyPositionAssessment: lower-severity action does NOT replace a pending card (anti-spam)', () => {
    const ps = mgmtCall({ pending_action: { verdict: 'move_stop', severity: 3, proposal: {} } }).position_state
    const { set, fireCard } = _applyPositionAssessment(mgmtCall(), ps, { verdict: 'take_partial', proposal: { size_pct: 50 } }, 252, M(), NOW, 'scale_out')
    assert.equal(fireCard, false)
    assert.equal('position_state.pending_action' in set, false)   // pending stays as-is
})
test('applyPositionAssessment: hold does NOT clear a pending card', () => {
    const ps = mgmtCall({ pending_action: { verdict: 'exit_now', severity: 4, proposal: {} } }).position_state
    const { set, fireCard } = _applyPositionAssessment(mgmtCall(), ps, { verdict: 'hold', read: 'still ok' }, 249, M(), NOW, 'review')
    assert.equal(fireCard, false)
    assert.equal('position_state.pending_action' in set, false)   // persisted pending untouched
})

test('_checkPosition: cheap hold (no flag, review not due) -> metrics only, NO LLM, NO journal', async () => {
    let assessed = 0
    const updates = []
    const db = { collection: () => ({ updateOne: async (_q, u) => updates.push(u) }) }
    const deps = {
        getIdea: async () => ({ id: 'idea1', status: 'long' }),
        getPrice: async () => 249,
        assessPosition: async () => { assessed++; return null },
        onManageCard: async () => {},
    }
    const call = mgmtCall({ last_management: { at: new Date(NOW - 60_000).toISOString() } })
    const res = await _checkPosition(db, call, NOW, deps)
    assert.equal(res.reason, 'in_position_idle')
    assert.equal(assessed, 0)                                   // gate skipped the LLM
    assert.ok(updates[0].$set['position_state.metrics.r_multiple_now'] != null)
    assert.equal(updates[0].$push, undefined)                   // no journal spam on a cheap hold
})

test('_checkPosition: gate trip -> assessment runs, card fired, journal appended', async () => {
    let carded = 0
    const updates = []
    const db = { collection: () => ({ updateOne: async (_q, u) => updates.push(u) }) }
    const deps = {
        getIdea: async () => ({ id: 'idea1', status: 'long' }),
        getPrice: async () => 251.5,                            // breakeven flag
        assessPosition: async () => ({ verdict: 'move_stop', proposal: { new_stop: 247.3 }, read: 'to breakeven', next_check_min: 5 }),
        onManageCard: async () => { carded++ },
    }
    const res = await _checkPosition(db, mgmtCall(), NOW, deps)
    assert.equal(res.verdict, 'move_stop')
    assert.equal(res.fireCard, true)
    assert.equal(carded, 1)
    assert.equal(updates[0].$set['position_state.pending_action'].verdict, 'move_stop')
    assert.ok(updates[0].$push['monitor_state.timeline'])       // journal continued
})
