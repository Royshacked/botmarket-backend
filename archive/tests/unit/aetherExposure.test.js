// Aether exposure read path — Node reads what the Python engine actually writes.
//
// Two defects lived here and both are regression-guarded below:
//   1. Node queried { ticker } but ExposureRecord.to_mongo() emits `entity` and no
//      `ticker` key at all, so getExposure() returned null for every document.
//   2. Python writes one FLAT doc per (entity, channel_id); the formatter expected a
//      single doc carrying a `channels` map, so even a matched row rendered empty —
//      and `lag_profile`, a distribution object, rendered as "[object Object]".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleExposure } from '../../api/aether/aether.service.js'
import { formatExposure } from '../../services/tools/aether.tools.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Shape mirrors ExposureRecord.to_mongo() in aether-engine/src/aether_engine/exposure/schema.py.

const _row = (overrides = {}) => ({
    entity:             'AAL',
    channel_id:         'energy_cost',
    confidence:         0.82,
    exposure_order:     1,
    contract_structure: 'spot',
    source_ref:         '10-K FY2025 p.42',
    notes:              null,
    reviewed:           true,
    elasticity:         -0.42,
    lag_profile:        { p10_weeks: 2, median_weeks: 4, p90_weeks: 8 },
    hedge_coverage:     0.60,
    pass_through:       0.35,
    ...overrides,
})

const _edge = (overrides = {}) => ({
    from_entity:      'XOM',
    to_entity:        'AAL',
    weight:           0.30,
    substitutability: 0.20,
    channel_ids:      ['energy_cost'],
    source_ref:       'supplier disclosure',
    confidence:       0.60,
    notes:            null,
    ...overrides,
})

// ── assembleExposure ──────────────────────────────────────────────────────────

test('assembleExposure folds flat per-channel rows into a channels map', () => {
    const doc = assembleExposure('AAL', [
        _row(),
        _row({ channel_id: 'fx_usd', elasticity: 0.18, confidence: 0.55 }),
    ])

    assert.equal(doc.ticker, 'AAL')
    assert.deepEqual(Object.keys(doc.channels).sort(), ['energy_cost', 'fx_usd'])
    assert.equal(doc.channels.energy_cost.elasticity, -0.42)
    assert.equal(doc.channels.fx_usd.confidence, 0.55)
})

test('assembleExposure strips the entity key off each channel entry', () => {
    const doc = assembleExposure('AAL', [_row()])
    assert.ok(!('entity' in doc.channels.energy_cost), 'entity must not leak into the channel entry')
    assert.ok(!('channel_id' in doc.channels.energy_cost), 'channel_id is the map key, not a field')
})

test('assembleExposure attaches supply edges and defaults them to an empty array', () => {
    assert.deepEqual(assembleExposure('AAL', [_row()]).supply_graph, [])
    assert.equal(assembleExposure('AAL', [_row()], [_edge()]).supply_graph.length, 1)
})

test('assembleExposure returns null when the ticker has no exposure rows', () => {
    assert.equal(assembleExposure('NOPE', []), null)
    assert.equal(assembleExposure('NOPE', null), null)
})

test('assembleExposure returns null when rows carry no channel_id', () => {
    assert.equal(assembleExposure('AAL', [_row({ channel_id: null })]), null)
})

// ── formatExposure ────────────────────────────────────────────────────────────

test('formatExposure renders lag_profile as a distribution, never [object Object]', () => {
    const out = formatExposure('AAL', assembleExposure('AAL', [_row()]))
    assert.ok(!out.includes('[object Object]'), 'lag_profile must not stringify as an object')
    assert.match(out, /lag 2–4–8w/)
})

// The get_name_exposure tool spec promises elasticity, lag_profile, hedge_coverage,
// pass_through and confidence — the formatter must actually render each one.
test('formatExposure renders every field the tool spec advertises', () => {
    const out = formatExposure('AAL', assembleExposure('AAL', [_row()]))
    assert.match(out, /energy_cost/)
    assert.match(out, /elasticity -0\.420/)
    assert.match(out, /lag 2–4–8w/)
    assert.match(out, /hedged 0\.60/)
    assert.match(out, /pass-through 0\.35/)
    assert.match(out, /conf 0\.82/)
})

test('formatExposure reports the supply-edge count when edges exist', () => {
    const withEdges = formatExposure('AAL', assembleExposure('AAL', [_row()], [_edge()]))
    assert.match(withEdges, /Supply-graph edges into AAL: 1/)

    const noEdges = formatExposure('AAL', assembleExposure('AAL', [_row()]))
    assert.ok(!noEdges.includes('Supply-graph edges'), 'omit the line when there are no edges')
})

test('formatExposure falls back to NOT_YET for a missing or channel-less record', () => {
    assert.match(formatExposure('AAL', null), /not yet computed/)
    assert.match(formatExposure('AAL', { ticker: 'AAL', channels: {} }), /not yet computed/)
})

test('formatExposure tolerates channels with partial fields', () => {
    const sparse = assembleExposure('AAL', [
        { entity: 'AAL', channel_id: 'freight_logistics', confidence: 0.4 },
    ])
    const out = formatExposure('AAL', sparse)
    assert.match(out, /freight_logistics/)
    assert.match(out, /conf 0\.40/)
    assert.ok(!out.includes('elasticity'), 'absent elasticity must be omitted, not printed as undefined')
})
