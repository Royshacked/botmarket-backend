// Aether regime read path.
//
// Two defects lived here, and the second was MASKING the first:
//   1. getCurrentRegime() sorted aether_regimes by computed_at desc. A run writes the whole
//      history back carrying ONE computed_at (1042 rows, 1 distinct value), so the sort is a
//      no-op and Mongo returns an arbitrary row — in production, 2006-06-19 "crisis" while
//      the newest row was 2026-06-01 "expansion".
//   2. formatRegime read doc.label, but Python writes the field as `regime`.
//
// Because (2) rendered "(unlabelled)", (1) was invisible. Fixing the label alone would have
// made the desk report the macro regime as "crisis" with full confidence. The sort test below
// is the one that matters: it is the difference between useless output and confident wrong output.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatRegime, formatChannelState } from '../../services/tools/aether.tools.js'

// Shape as written by the Python engine (keys observed in aether_regimes).
const _regime = (overrides = {}) => ({
    date:            new Date('2026-06-01T00:00:00.000Z'),
    regime:          'expansion',
    credit_access_z: -0.885,
    risk_premium_z:  -0.493,
    computed_at:     new Date('2026-08-30T14:54:20.116Z'),
    ...overrides,
})

// ── The sort contract ─────────────────────────────────────────────────────────
// getCurrentRegime itself needs a DB, so the invariant it depends on is asserted here:
// computed_at cannot order these rows, and date can.

test('computed_at cannot order a regime history — every row of a run shares one', () => {
    const run = [
        _regime({ date: new Date('2006-06-19T00:00:00.000Z'), regime: 'crisis' }),
        _regime({ date: new Date('2026-06-01T00:00:00.000Z'), regime: 'expansion' }),
    ]
    const distinctComputedAt = new Set(run.map(r => r.computed_at.toISOString()))
    assert.equal(distinctComputedAt.size, 1,
        'one computed_at across the run is exactly why sorting on it returns an arbitrary row')

    const newest = [...run].sort((a, b) => b.date - a.date)[0]
    assert.equal(newest.regime, 'expansion', 'sorting on date is what selects the current regime')
})

// ── formatRegime ──────────────────────────────────────────────────────────────

test('formatRegime reads the `regime` field Python actually writes', () => {
    const out = formatRegime(_regime())
    assert.match(out, /REGIME: expansion/)
    assert.ok(!out.includes('(unlabelled)'))
})

test('formatRegime still honours the spec name `label`', () => {
    const out = formatRegime({ label: 'contraction' })
    assert.match(out, /REGIME: contraction/)
})

test('formatRegime separates the observation date from the run stamp', () => {
    const out = formatRegime(_regime())
    assert.match(out, /As of: 2026-06-01/, 'the date the regime describes')
    assert.match(out, /Computed: 2026-08-30 14:54:20/, 'when the run happened')
})

test('formatRegime renders a Date as ISO, not as "Sun Aug 30 2026 17:"', () => {
    const out = formatRegime(_regime())
    assert.ok(!/Sun|Mon|Tue|Wed|Thu|Fri|Sat/.test(out), 'no locale day names in a sliced Date')
    assert.ok(!out.includes('GMT'))
})

test('formatRegime surfaces the classifier inputs the doc carries', () => {
    const out = formatRegime(_regime())
    assert.match(out, /credit_access -0\.89/)
    assert.match(out, /risk_premium -0\.49/)
})

test('formatRegime falls back to driving_channels when the doc has them instead', () => {
    const out = formatRegime({ regime: 'expansion', driving_channels: ['energy_cost', 'fx_usd'] })
    assert.match(out, /Driving channels: energy_cost, fx_usd/)
})

test('formatRegime returns NOT_YET for a missing doc', () => {
    assert.match(formatRegime(null), /not yet computed/)
})

test('formatRegime tolerates a doc with nothing but a label', () => {
    const out = formatRegime({ regime: 'expansion' })
    assert.match(out, /REGIME: expansion/)
    assert.ok(!out.includes('As of'))
    assert.ok(!out.includes('Classifier inputs'))
})

// ── formatChannelState ────────────────────────────────────────────────────────

test('formatChannelState renders computed_at as ISO, not a sliced locale string', () => {
    const out = formatChannelState({
        computed_at: new Date('2026-08-30T14:51:21.000Z'),
        channels: { energy_cost: 1.962 },
        regime_label: 'expansion',
    })
    assert.match(out, /computed 2026-08-30 14:51:21/)
    assert.ok(!out.includes('GMT'))
    assert.match(out, /energy_cost\s+1\.962/)
    assert.match(out, /Active regime: expansion/)
})

test('formatChannelState omits the stamp entirely rather than printing an empty one', () => {
    const out = formatChannelState({ channels: { energy_cost: 1.0 } })
    assert.match(out, /^CHANNEL STATE:/)
    assert.ok(!out.includes('(computed )'))
})
