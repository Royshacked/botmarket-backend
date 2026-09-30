import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatChannelState, readChannelState, _setChannelIO, STALE_DAYS } from '../../api/strategy/channelState.service.js'

// Pythia's read of the channels Python writes. No arithmetic lives on this side — the one property
// worth defending is that the text never passes an old or absent read off as a current one.

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-30T12:00:00.000Z')

const doc = (over = {}) => ({
    _id: 'latest',
    computed_at: new Date(NOW - DAY),
    week: new Date('2026-09-25T00:00:00.000Z'),
    regime: 'expansion',
    channels: {
        energy_cost:     { z: 1.66, z_4w: 1.49, z_13w: 0.9, pct: 0.83, as_of: new Date('2026-09-29'), description: 'Energy input cost pressure', sign_convention: 1 },
        discount_rate:   { z: 3.99, z_4w: 2.28, z_13w: 1.1, pct: 1.0,  as_of: new Date('2026-09-28'), description: 'Real yields', sign_convention: 1 },
        consumer_credit: { z: 1.83, z_4w: 1.77, z_13w: null, pct: 0.9, as_of: new Date('2026-07-01'), description: 'Household leverage', sign_convention: 1 },
        demographic_labor: { z: 0.96, z_4w: 1.05, z_13w: 1.0, pct: 0.74, as_of: new Date('2026-08-01'), description: 'Prime-age participation', sign_convention: -1 },
    },
    missing: { geopolitical_risk: 'manual only' },
    ...over,
})

test('the most unusual channel comes first — that is what a regime has to explain', () => {
    const text = formatChannelState(doc(), NOW)
    const order = ['discount_rate', 'consumer_credit', 'energy_cost', 'demographic_labor'].map(id => text.indexOf(id))
    assert.deepEqual(order, [...order].sort((a, b) => a - b))
})

test('every line carries its own date, because monthly series lag by weeks', () => {
    const text = formatChannelState(doc(), NOW)
    assert.match(text, /consumer_credit.*as of 2026-07-01/)
    assert.match(text, /energy_cost.*as of 2026-09-29/)
})

test('a missing lookback prints a dash, never a zero', () => {
    const line = formatChannelState(doc(), NOW).split('\n').find(l => l.includes('consumer_credit'))
    assert.match(line, /13w\s+—/)
})

test('an inverted channel says so', () => {
    assert.match(formatChannelState(doc(), NOW), /demographic_labor.*sign inverted/)
})

test('the regime and what was not measured are both stated', () => {
    const text = formatChannelState(doc(), NOW)
    assert.match(text, /Regime \(VIX \+ credit spread\): expansion/)
    assert.match(text, /Not measured: geopolitical_risk \(manual only\)/)
})

test('a STALE read is headed as stale, not passed off as current', () => {
    // The archived engine served June's state in September and nothing said so.
    const old = formatChannelState(doc({ computed_at: new Date(NOW - (STALE_DAYS + 1) * DAY) }), NOW)
    assert.match(old, /^⚠ STALE CHANNEL STATE — computed 9 days ago/)
    const fresh = formatChannelState(doc(), NOW)
    assert.doesNotMatch(fresh, /STALE/)
})

test('an unknown computation time is treated as stale', () => {
    assert.match(formatChannelState(doc({ computed_at: undefined }), NOW), /STALE CHANNEL STATE — computed at an unknown time/)
})

test('no document says it is unavailable and forbids inventing readings', () => {
    for (const empty of [null, undefined, {}, { channels: {} }]) {
        assert.match(formatChannelState(empty, NOW), /not available.*Do not infer channel readings/)
    }
})

test('it states the limit: readings, not sector evidence', () => {
    assert.match(formatChannelState(doc(), NOW), /READINGS, not forecasts, and not yet evidence about any sector/)
})

test('the read goes through the injectable seam', async () => {
    _setChannelIO({ latest: async () => doc() })
    assert.equal((await readChannelState()).regime, 'expansion')
})
