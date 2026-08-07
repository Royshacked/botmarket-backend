import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    mergeCoverage, _mergeSetupDraft, _parseMentorResponse, _parseCandidates, emptyMentorState,
    _buildProblemsSection,
} from '../../services/agents/mentor.agent.service.js'
import { normalizeSetup } from '../../services/setup.schema.js'

// Mentor's pure seams: the cumulative coverage tag, draft carry-forward, and emit-block
// extraction. All model-output handling — so every test here is really "what happens when the
// model emits something slightly wrong", which is the normal case, not the exception.

const ZONES = {
    entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
    stop_zones:  [{ lower: 234.8, upper: 235.9, quantity: 100 }],
    tp_zones:    [{ lower: 246.0, upper: 247.2, quantity: 100 }],
}
const SETUP = { asset: 'NVDA', direction: 'long', type: 'swing', trade_mode: 'smc', timeframe: '1hr', ...ZONES }

// ─── Coverage ─────────────────────────────────────────────────────────────────

test('coverage unions with the prior set — a forgetful turn cannot un-read a dimension', () => {
    assert.deepEqual(mergeCoverage(['markets'], 'technicals'), ['markets', 'technicals'])
    assert.deepEqual(mergeCoverage(['markets', 'company'], 'markets'), ['markets', 'company'])
})

test('coverage parses the comma-separated tag body, trimmed and case-insensitive', () => {
    assert.deepEqual(mergeCoverage([], ' Markets , TECHNICALS '), ['markets', 'technicals'])
})

test('coverage accepts an array as well as the raw tag body', () => {
    assert.deepEqual(mergeCoverage([], ['company', 'markets']), ['company', 'markets'])
})

test('unknown dimensions are dropped rather than shown as progress', () => {
    assert.deepEqual(mergeCoverage([], 'markets,astrology,vibes'), ['markets'])
})

test('an empty or junk emit leaves prior coverage intact', () => {
    for (const bad of ['', null, undefined, '   ', ',,,']) {
        assert.deepEqual(mergeCoverage(['markets'], bad), ['markets'], String(bad))
    }
})

test('a fresh state starts with no coverage and no draft', () => {
    assert.deepEqual(emptyMentorState(), { active_asset: '', draft: null, coverage: [] })
})

// ─── Draft carry-forward ──────────────────────────────────────────────────────

test('an omitted field carries forward from the prior draft', () => {
    // The "make it $1k" turn: the model narrates "everything else stands" and emits one field.
    const merged = _mergeSetupDraft({ ...SETUP, thesis: 'sweep and reclaim' }, { timeframe: '15min' })
    assert.equal(merged.timeframe, '15min')
    assert.equal(merged.thesis, 'sweep and reclaim', 'the settled thesis survives a thin emit')
    assert.deepEqual(merged.entry_zones, SETUP.entry_zones)
})

test('a re-emitted array replaces wholesale, so the model can still DROP a zone', () => {
    const merged = _mergeSetupDraft(SETUP, { entry_zones: [{ lower: 230, upper: 231, quantity: 50 }] })
    assert.equal(merged.entry_zones.length, 1)
    assert.equal(merged.entry_zones[0].lower, 230)
})

test('an explicit null clears a field — only omission is protected', () => {
    assert.equal(_mergeSetupDraft({ ...SETUP, valid_until: '2026-08-08T20:00:00Z' }, { valid_until: null }).valid_until, null)
})

test('no setup this turn → null, so the client keeps its existing draft untouched', () => {
    assert.equal(_mergeSetupDraft(SETUP, null), null)
    assert.equal(_mergeSetupDraft(null, null), null)
})

test('a first setup with no prior draft passes straight through', () => {
    assert.deepEqual(_mergeSetupDraft(null, SETUP), SETUP)
    assert.deepEqual(_mergeSetupDraft([], SETUP), SETUP, 'a malformed prior draft is discarded, not merged')
})

// ─── Emit-block extraction ────────────────────────────────────────────────────

test('the setup block is parsed and stripped from the visible reply', () => {
    const raw = `Zones are placed.\n<setup>${JSON.stringify(SETUP)}</setup>`
    const { reply, setup } = _parseMentorResponse(raw)
    assert.equal(reply, 'Zones are placed.')
    assert.equal(setup.asset, 'NVDA')
    assert.ok(!reply.includes('entry_zones'), 'raw JSON must never reach the user')
})

test('<setups> is NOT matched as a <setup> despite the shared prefix', () => {
    // The tags differ by one trailing char; a sloppy regex would parse the candidate offer as a
    // worksheet and hand the client a bogus single setup.
    const raw = `<setups>${JSON.stringify({ candidates: [{ label: 'A', setup: SETUP }] })}</setups>`
    const { setup, setups } = _parseMentorResponse(raw)
    assert.equal(setup, null, 'the offer block must not be read as a worksheet')
    assert.equal(setups.candidates.length, 1)
})

test('both blocks are stripped from the reply even when only one parses', () => {
    const raw = `Here are two options.\n<setups>{ not json </setups>`
    const { reply, setups } = _parseMentorResponse(raw)
    assert.equal(reply, 'Here are two options.')
    assert.equal(setups, null)
})

test('malformed JSON degrades to null rather than throwing mid-stream', () => {
    const { reply, setup } = _parseMentorResponse('Thinking.\n<setup>{ "asset": "NVDA" </setup>')
    assert.equal(setup, null)
    assert.equal(reply, 'Thinking.')
})

test('a turn with no blocks returns the reply unchanged', () => {
    const { reply, setup, setups } = _parseMentorResponse('What horizon are you thinking?')
    assert.equal(reply, 'What horizon are you thinking?')
    assert.equal(setup, null)
    assert.equal(setups, null)
})

// ─── Candidates ───────────────────────────────────────────────────────────────

test('candidates are normalised so the cards are comparable, with rr computed per option', () => {
    const raw = `<setups>${JSON.stringify({ candidates: [
        { label: 'Sweep and reclaim', pitch: 'Best risk.', setup: SETUP },
        { label: 'Break of the shelf', pitch: 'Momentum.', setup: { ...SETUP, trade_mode: 'classical', entry_zones: [{ lower: 241, upper: 242, quantity: 100 }] } },
    ] })}</setups>`
    const { candidates } = _parseCandidates(raw)
    assert.equal(candidates.length, 2)
    assert.ok(candidates.every(c => Number.isFinite(c.setup.rr)), 'every card shows an rr')
    assert.deepEqual(candidates.map(c => c.setup.trade_mode), ['smc', 'classical'])
    // The worse fill must produce the worse rr — that's the whole point of showing them together.
    assert.ok(candidates[0].setup.rr > candidates[1].setup.rr)
})

test('a candidate whose setup will not normalise is dropped, not rendered blank', () => {
    const raw = `<setups>${JSON.stringify({ candidates: [{ label: 'Broken', setup: null }, { label: 'Good', setup: SETUP }] })}</setups>`
    assert.deepEqual(_parseCandidates(raw).candidates.map(c => c.label), ['Good'])
})

test('a label falls back to the lens rather than rendering an unlabelled card', () => {
    const raw = `<setups>${JSON.stringify({ candidates: [{ setup: SETUP }] })}</setups>`
    assert.equal(_parseCandidates(raw).candidates[0].label, 'smc')
})

test('an offer with no usable candidates is null, not an empty picker', () => {
    assert.equal(_parseCandidates(`<setups>${JSON.stringify({ candidates: [] })}</setups>`), null)
    assert.equal(_parseCandidates(`<setups>${JSON.stringify({ candidates: 'two' })}</setups>`), null)
    assert.equal(_parseCandidates('no block here'), null)
})

// ─── The gate speaks to the AGENT, not only to the user ───────────────────────
// Live runs: with two scenarios the model got the validity ordering right on one and wrong on the
// other about every other build. The panel showed the refusal; the model never saw it, so the next
// turn re-emitted the same contradiction. It is fed back into the prompt now.

const INCOHERENT = normalizeSetup({
    asset: 'NVDA', direction: 'long', type: 'swing', timeframe: '1hr',
    conditions: [{ id: 'c1', text: 'CHoCH up on the 15m' }],
    scenarios: [
        { id: 's1', name: 'pullback', entry_zones: [{ lower: 199, upper: 201, quantity: 60 }],
          stop_zones: [{ lower: 194, upper: 195 }], validity: { lower: 196, upper: 210 } },
        { id: 's2', name: 'breakout', entry_zones: [{ lower: 208, upper: 209, quantity: 100 }],
          stop_zones: [{ lower: 204, upper: 205 }], validity: { lower: 200, upper: 220 } },  // below ITS stop
    ],
})

test('a contradiction in the emitted plan is handed back to the agent, naming the scenario', () => {
    const block = _buildProblemsSection(INCOHERENT)
    assert.match(block, /DOES NOT ADD UP/)
    assert.match(block, /breakout: validity floor sits below the stop/)
    assert.doesNotMatch(block, /pullback:/, 'the coherent premise is not nagged about')
    assert.match(block, /Generate refuses/, 'it must say what the consequence is, or the model can ignore it')
})

test('a coherent plan adds nothing — no standing nag in the prompt', () => {
    const fine = normalizeSetup({ ...INCOHERENT, scenarios: [INCOHERENT.scenarios[0]] })
    assert.equal(_buildProblemsSection(fine), '')
    assert.equal(_buildProblemsSection(null), '')
})

test('MISSING fields are never fed back — an unfinished setup is the normal state of a chat', () => {
    // Reciting the gaps every turn pushes the agent to fill them by guessing instead of asking.
    const bare = normalizeSetup({ asset: 'NVDA', direction: 'long' })
    assert.equal(_buildProblemsSection(bare), '')
})
