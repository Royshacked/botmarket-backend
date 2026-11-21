import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { profileRow, ROW_SCALE } from '../../services/hotlistBehaviour.service.js'
import { SCALES, VERSION, scaleProfile } from '../../services/stockProfile.engine.js'
import { _buildProteusSection, _buildPullbackSection, _buildTurnContext } from '../../services/agents/mentor.agent.service.js'

// How a Hotlist name trades (Proteus v2 — docs/design/proteus-v2.md §5): the opened row's bottom lines on the horizon's
// scale; and the trader's technical read and its noise check (mentor.agent.service).

const DAY = 86_400
function walk(n, { drift = 0.0003, vol = 0.012, seed = 7 } = {}) {
    let s = seed, p = 100
    const t0 = Date.parse('2016-01-04T21:00:00Z') / 1000, out = []
    for (let i = 0; i < n; i++) {
        s = (s * 1664525 + 1013904223) >>> 0
        p *= Math.exp(drift + (s / 2 ** 32 - 0.5) * vol * 3.4)
        out.push({ timestamp: t0 + i * DAY, open: p, high: p * 1.004, low: p * 0.996, close: p, volume: 1e6 })
    }
    return out
}
const SWING = scaleProfile(walk(2500), SCALES.swing)
const entry = (scales) => ({ symbol: 'NVDA', version: VERSION, scales, built: Object.fromEntries(Object.keys(scales).map(k => [k, '2026-11-20T21:00:00.000Z'])) })

test('the row horizons map onto the profile scales', () => {
    assert.deepEqual({ ...ROW_SCALE }, { intraday: 'day', day: 'day', week: 'short', swing: 'swing', long_term: 'long' }, 'This week holds ~a week: the short term swing (v2)')
})

test('an opened row: the bottom lines on its scale, its date; the scale asked is the horizon\'s', async () => {
    const asked = []
    const r = await profileRow('nvda', 'week', { profile: async (sym, scale) => { asked.push([sym, scale]); return entry({ short: SWING }) } })
    assert.deepEqual(asked, [['NVDA', 'short']])
    assert.equal(r.symbol, 'NVDA')
    assert.equal(r.horizon, 'week')
    assert.equal(r.computed_at, '2026-11-20T21:00:00.000Z')
    assert.ok(r.headline?.text, 'a headline')
    assert.ok(Array.isArray(r.lines) && r.lines.length >= 2)
    assert.equal(r.lines[0][0], 'Bottom line', 'what it adds up to, first')
    assert.equal(r.lines[1][0], 'Risk')
    assert.equal(r.lines[2][0], 'Moves')
    assert.match(r.lines[2][1], /σ \d+\.\d% a month/)
})

test('opening a row: every failure is a reason, never a throw', async () => {
    assert.equal((await profileRow('not a ticker!', 'swing', { profile: async () => { throw new Error('no') } })).reason, 'bad_symbol')
    const unavailable = Object.assign(new Error('fmp 429'), { code: 'DAILY_UNAVAILABLE' })
    assert.equal((await profileRow('NVDA', 'swing', { profile: async () => { throw unavailable } })).reason, 'unavailable')
    assert.equal((await profileRow('NVDA', 'swing', { profile: async () => { throw new Error('no price history') } })).reason, 'no_history')
    const short = scaleProfile(walk(80), SCALES.swing)
    assert.equal((await profileRow('NVDA', 'swing', { profile: async () => entry({ swing: short }) })).reason, 'too_short')
    assert.equal((await profileRow('NVDA', 'long_term', { profile: async () => entry({ swing: SWING }) })).reason, 'unavailable', 'the scale not in the entry')
    assert.equal((await profileRow('NVDA', 'nonsense', { profile: async (s, scale) => entry({ [scale]: SWING }) })).horizon, 'swing', 'an unknown horizon reads as a swing')
})

// ── the trader ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("the trader's technical read: the scale, the date, the lines; how to weigh it; no internal name", () => {
    const s = _buildProteusSection({ symbol: 'NVDA', at: '2026-11-20T21:00:00Z', scale: 'swing', read: ['σ (its usual move in a month): 10.0%', '- long: stop 1.8σ'] })
    assert.match(s, /THE TECHNICAL READ on NVDA — the swing scale, measured 2026-11-20/)
    assert.match(s, /\n {2}- σ \(its usual move in a month\): 10\.0%\n/)
    assert.match(s, /\n {4}- long: stop 1\.8σ\n/, 'a sub-line keeps its indent')
    assert.match(s, /get_levels_for/)
    assert.match(s, /not support and not an edge/)
    assert.doesNotMatch(s, /Proteus|technical analyst/)
    assert.equal(_buildProteusSection(null), '')
    assert.equal(_buildProteusSection({ symbol: 'KO', read: [] }), '')
})

const NOISE = { scale: 'swing', side: 'long', stop_pct: 0.09, stop_sig: 1.8 }

test('the noise check: a stop closer to the entry than the noise → the line with its prices; else nothing', () => {
    const facts = { timeframe: 'day', side: 'long', close: 100, stop: 95 }
    const s = _buildPullbackSection(facts, NOISE, null)
    assert.match(s, /ITS NOISE \(checked: the structure stop 95 is 5% from the entry 100 — inside it\)/)
    assert.match(s, /reaches ~9% \(1\.8σ of its usual move\): from 100 that is 91/)
    assert.match(s, /never move it on your own/)
    // The worksheet's stop and entry win over the structure's.
    const draft = { scenarios: [{ entry_legs: [{ price: 98 }], stop_legs: [{ price: 93 }] }] }
    assert.match(_buildPullbackSection(facts, NOISE, draft), /the worksheet's stop 93 is 5.1% from the entry 98/)
    assert.equal(_buildPullbackSection({ ...facts, stop: 90 }, NOISE, null), '', 'a stop past the noise: nothing to say')
    assert.equal(_buildPullbackSection({ ...facts, timeframe: 'week' }, NOISE, null), '', "another scale's noise")
    assert.equal(_buildPullbackSection({ ...facts, timeframe: 'hour' }, NOISE, null), '', 'the hour chart is the day scale')
    assert.equal(_buildPullbackSection({ ...facts, side: 'short' }, NOISE, null), '', "the long side's noise says nothing of a short")
    assert.equal(_buildPullbackSection(facts, null, null), '')
    assert.equal(_buildPullbackSection({ timeframe: 'day', close: 100 }, NOISE, null), '', 'no stop yet')
})

test('the noise check, short: mirrored — a stop over the entry, closer than the rallies reach', () => {
    const noise = { ...NOISE, side: 'short' }
    const s = _buildPullbackSection({ timeframe: 'day', side: 'short', close: 100, stop: 104 }, noise, null)
    assert.match(s, /4% from the entry 100 — inside it/)
    assert.match(s, /rally inside a fall/)
    assert.match(s, /from 100 that is 109/)
    assert.match(s, /stop goes over 109/)
    assert.equal(_buildPullbackSection({ timeframe: 'day', side: 'short', close: 100, stop: 110 }, noise, null), '')
})

test("the noise check rides the turn's context beside the risk read", () => {
    const facts = { timeframe: 'day', side: 'long', close: 100, stop: 95 }
    assert.match(_buildTurnContext({ active_asset: 'KO' }, null, [], { thesisFacts: facts, pullback: NOISE }), /ITS NOISE/)
    assert.doesNotMatch(_buildTurnContext({ active_asset: 'KO' }, null, [], { thesisFacts: facts }), /ITS NOISE/)
})

test("the trader's prompt: the stop is checked against its noise, offered as a choice, never moved on his own", () => {
    const prompt = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8')
    assert.match(prompt, /Check the stop against ITS NOISE/)
    assert.match(prompt, /never move it on your own/)
    assert.match(prompt, /`get_levels_for`/)
    assert.doesNotMatch(prompt, /technical analyst|<route>technicals|PROTEUS'S READ/)
})
