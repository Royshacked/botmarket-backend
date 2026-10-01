import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatChannelExposures, readChannelExposures, _setExposureIO } from '../../api/strategy/channelExposures.service.js'
import { TOOLS } from '../../services/agents/strategy.agent.service.js'
import { TILT_BASES, normalizeTilt } from '../../api/strategy/tilt.service.js'

// Pythia's Phase-3 evidence: which buckets move with which channel. The properties worth defending:
// only significant betas are offered as exposures, a measured zero and an unmeasured pair are never
// confused, and a fund is named by the buckets it stands for.

const universe = { funds: [
    { symbol: 'XLU', buckets: [{ bucket: 'Utilities' }] },
    { symbol: 'IYT', buckets: [{ bucket: 'General Transportation' }, { bucket: 'Integrated Freight & Logistics' }, { bucket: 'Railroads' }, { bucket: 'Trucking' }] },
    { symbol: 'XLE', buckets: [{ bucket: 'Energy' }] },
] }
const latest = { channels: { discount_rate: { z: 4.0 }, energy_cost: { z: 1.5 } } }
const b = (symbol, channel_id, beta, t_stat, over = {}) =>
    ({ symbol, channel_id, beta, t_stat, significant: Math.abs(t_stat) >= 3, status: 'measured', ...over })
const betas = [
    b('XLU', 'discount_rate', -0.0127, -7.7),
    b('IYT', 'discount_rate', 0.001, 0.4),                  // measured, no exposure
    b('XLE', 'energy_cost', 0.0461, 21.7),
    b('IYT', 'energy_cost', -0.012, -3.4),
    { symbol: 'XLU', channel_id: 'energy_cost', status: 'unmeasured' },
]

test('only significant betas are offered as exposures, most certain first', () => {
    const text = formatChannelExposures({ betas, universe, latest })
    const energy = text.slice(text.indexOf('energy_cost'))
    assert.ok(energy.indexOf('XLE') < energy.indexOf('IYT'), 'ranked by |t|')
    const rate = text.slice(text.indexOf('discount_rate'), text.indexOf('energy_cost  ('))
    assert.doesNotMatch(rate, /IYT/, 'an insignificant beta is not listed as an exposure')
})

test('measured zero and unmeasured are counted apart, never as a zero beta', () => {
    const text = formatChannelExposures({ betas, universe, latest })
    assert.match(text, /discount_rate.*1 fund\(s\) measurably exposed, 1 measured with no exposure/)
    assert.match(text, /energy_cost.*2 fund\(s\) measurably exposed, 0 measured with no exposure, 1 unmeasured/)
})

test('the channel reading most unusual today comes first', () => {
    const text = formatChannelExposures({ betas, universe, latest })
    assert.ok(text.indexOf('discount_rate  (z now +4.00)') < text.indexOf('energy_cost  (z now +1.50)'))
})

test('a fund is named by what it stands for, and a long list is shortened', () => {
    const text = formatChannelExposures({ betas, universe, latest })
    assert.match(text, /XLU .*Utilities/)
    assert.match(text, /IYT .*General Transportation, Integrated Freight & Logistics, Railroads \(\+1\)/)
})

test('"at today\'s z" is beta times the current reading', () => {
    // XLU: -0.0127 x 4.0 = -5.08% -> printed to one decimal
    const line = formatChannelExposures({ betas, universe, latest }).split('\n').find(l => l.includes('XLU'))
    assert.match(line, /-1\.27% per 1z/)
    assert.match(line, /at today's z\s+-5\.1%/)
})

test('a fund outside the published universe is still shown, as held by an open stance', () => {
    const text = formatChannelExposures({ betas: [b('XOP', 'energy_cost', 0.05, 15)], universe, latest })
    assert.match(text, /XOP .*held by an open stance/)
})

test('narrowing to one channel shows only that channel, and an unknown id says so', () => {
    const one = formatChannelExposures({ betas, universe, latest }, { channel: 'energy_cost' })
    assert.doesNotMatch(one, /discount_rate {2}\(/)
    assert.match(formatChannelExposures({ betas, universe, latest }, { channel: 'nope' }), /No exposures recorded for channel "nope"/)
})

test('no betas at all forbids asserting a measured exposure', () => {
    for (const empty of [{}, { betas: [] }, undefined]) {
        assert.match(formatChannelExposures(empty), /not available.*Do not assert.*rate_sensitivity/)
    }
})

test('the read goes through the injectable seam', async () => {
    _setExposureIO({ betas: async () => betas, universe: async () => universe, latest: async () => latest })
    const r = await readChannelExposures()
    assert.equal(r.betas.length, betas.length)
})

// ── the desk side ────────────────────────────────────────────────────────────
test('the desk carries the tool, with an optional channel filter, ahead of consult', () => {
    const names = TOOLS.map(t => t.name)
    const tool = TOOLS.find(t => t.name === 'get_channel_exposures')
    assert.ok(tool)
    assert.equal(tool.input_schema.properties.channel.type, 'string')
    assert.deepEqual(tool.input_schema.required ?? [], [])
    assert.equal(names.at(-1), 'consult')
})

test('`channels` is a basis a row can publish with', () => {
    assert.ok(TILT_BASES.includes('channels'))
    const t = normalizeTilt({ tilts: [{ bucket: 'Utilities', stance: 'under', active_bp: -100, basis: 'channels' }] })
    assert.equal(t.tilts[0].basis, 'channels')
})
