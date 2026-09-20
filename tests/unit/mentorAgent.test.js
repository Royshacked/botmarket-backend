import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    mergeCoverage, _mergeSetupDraft, _parseMentorResponse, _parseCandidates, emptyMentorState,
    _buildProblemsSection, mentorAgentService,
} from '../../services/agents/mentor.agent.service.js'
import { normalizeSetup } from '../../services/setup.schema.js'
import { MENTOR_TOOLS } from '../../services/agents/mentor.agent.service.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

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
        { label: 'Break of the shelf', pitch: 'Momentum.', setup: { ...SETUP, trade_mode: 'discretionary', entry_zones: [{ lower: 241, upper: 242, quantity: 100 }] } },
    ] })}</setups>`
    const { candidates } = _parseCandidates(raw)
    assert.equal(candidates.length, 2)
    assert.ok(candidates.every(c => Number.isFinite(c.setup.rr)), 'every card shows an rr')
    assert.deepEqual(candidates.map(c => c.setup.trade_mode), ['smc', 'discretionary'])
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

// ─── The Argus hand-off ───────────────────────────────────────────────────────
// Mentor is the destination for a scanned name now. Two things have to be true: it opens ON that
// name, and the LENS Argus recommends reaches the user as a recommendation rather than as a
// decision Mentor quietly made for them.

const seedOf = async (seed) => {
    let blocks = null
    await mentorAgentService.chatStream({
        messages: [{ role: 'user', content: 'hi' }], seed,
        _run: async ({ systemPrompt }) => { blocks = systemPrompt; return '' },
    })
    return blocks.map(b => b.text).join('\n')
}

test('a handed-over name reaches the prompt with Argus\'s read', async () => {
    const text = await seedOf({ ticker: 'NVDA', direction: 'long', thesis: 'AI leader', analysis: 'clean base' })
    assert.match(text, /NVDA/)
    assert.match(text, /AI leader/)
    assert.match(text, /clean base/)
})

test('the recommended lens is named AND framed as a recommendation', async () => {
    // The failure this guards is silent: a model handed a field called `recommended_mode` reads it
    // as an instruction, adopts the lens, and the user never learns a choice was made. Mentor's
    // whole contract is that it works on what the user brought and hands the decision back.
    const text = await seedOf({ ticker: 'NVDA', recommended_mode: 'institutional' })
    assert.match(text, /institutional/)
    assert.match(text, /recommendation, not a decision/i)
    assert.match(text, /use theirs/i, 'the user can override it')
})

test('a hand-off with no lens asks instead of assuming one', async () => {
    const text = await seedOf({ ticker: 'NVDA', thesis: 'momentum' })
    assert.match(text, /ask which lens/i)
    assert.doesNotMatch(text, /recommends the/i)
})

test('no seed leaves the prompt exactly as it was', async () => {
    // The ordinary path — a user who opened Mentor themselves must not be told a name was handed over.
    const text = await seedOf(null)
    assert.doesNotMatch(text, /ARGUS HANDED YOU/)
})

// ─── The guided build ─────────────────────────────────────────────────────────
// A name and no plan climbs a ladder (prompts/mentor_system_prompt.md, "The guided build"). The
// ladder is prompt, not code — the server tracks no step — so what CAN be held here is the contract
// around it: the rungs exist in order, the detour rule and the two grounding rules are stated, the
// candidate offer is no longer the default answer to "no plan", and the tools the rungs name are
// wired. The prose assertions are deliberately few and anchored on the bold rule names, which is
// the level a rewrite of the section would have to preserve on purpose.

const PROMPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../prompts/mentor_system_prompt.md'), 'utf8')

test('the ladder has its eight rungs, in the order a trader settles a trade', () => {
    const section = PROMPT.slice(PROMPT.indexOf('## The guided build'), PROMPT.indexOf('## Size comes from the user'))
    assert.ok(section.length > 0, 'the guided build section sits before sizing')
    const rungs = [...section.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm)].map(m => m[1].replace(/\.$/, ''))
    assert.deepEqual(rungs, [
        'The name', 'Direction', 'Horizon', 'The lens', 'The deep read, under that lens',
        'The scenarios', 'R:R, then the wider one', 'Size and account',
    ])
})

test('the ladder is a checklist, not a script — the detour rule and its two grounding rules are stated', () => {
    for (const rule of ['The detour rule.', 'One rung per turn, as a rule.', '"Go all the way" lifts the pauses, not the rungs.', 'Tools, not memory.', 'Live before levels.']) {
        assert.ok(PROMPT.includes(`**${rule}**`), `missing rule: ${rule}`)
    }
    // The detour returns to the first UNSETTLED rung, read off the worksheet — never to a remembered position.
    assert.match(PROMPT, /return to the FIRST unsettled rung/)
    assert.match(PROMPT, /read it\s+and go to the first blank/)
})

test('"go all the way" runs the ladder in one turn without dropping a rung, and names the calls it made', () => {
    const para = PROMPT.slice(PROMPT.indexOf('**"Go all the way"'), PROMPT.indexOf('**Tools, not memory.**'))
    assert.ok(para.length > 0, 'the paragraph sits between the pacing rule and the grounding rules')
    assert.match(para, /Every rung still\s+happens, in order/)
    assert.match(para, /RECORD the call instead of asking/)
    assert.match(para, /naming, in one line, the calls you made/)
    assert.match(para, /ready except for size/, 'size is never invented, even unpaced')
    assert.match(para, /no trade/, 'the unpaced run may still refuse')
    // The tool loop caps a turn at DEFAULT_MAX_CONTINUATIONS = 10 rounds (providers/anthropic.provider.js)
    // and THROWS past it; the prompt tells the model how to land short of the cap instead.
    assert.match(para, /about ten rounds of tools/)
    assert.match(para, /pick up from the first\s+unsettled rung next turn/)
})

test('horizon and lens are settled WITH the user; direction is Mentor\'s read they may overrule', () => {
    assert.match(PROMPT, /\*\*Horizon\.\*\* The trader's, not yours/)
    assert.match(PROMPT, /\*\*The lens\.\*\* Propose one[\s\S]{0,200}Wait for the yes/)
    assert.match(PROMPT, /\*\*Direction\.\*\* Your read[\s\S]{0,300}Theirs to\s+accept or overrule/)
})

test('candidates are an explicit ask now — the guided build ends in one setup', () => {
    assert.match(PROMPT, /## Offering candidates — only when they ask for options/)
    assert.match(PROMPT, /The guided build does not reach for it on its own/)
    assert.doesNotMatch(PROMPT, /When the user has no setup, offer a few/, 'the old default-to-candidates invariant is gone')
})

test('scenario count is Mentor\'s in the guided build — same premise at two levels is allowed, padding is not', () => {
    assert.match(PROMPT, /if they are all pullbacks, they are all pullbacks/)
    assert.doesNotMatch(PROMPT, /Most setups have exactly one\./)
    assert.match(PROMPT, /never pad to two because a pair reads balanced/)
})

test('the two tools the ladder added are declared after the kit and before the sidecar', () => {
    const names = MENTOR_TOOLS.map(t => t.name)
    const kitEnd = names.indexOf('get_key_levels')   // SMC_TOOLS closes the shared kit
    assert.ok(kitEnd > 0)
    assert.deepEqual(names.slice(kitEnd + 1), ['get_news', 'get_analyst_actions', 'consult'])
})

test('the two tools are WIRED — a declared tool with no handler is a call that silently fails', async () => {
    let handlers = null
    const seen = []
    await mentorAgentService.chatStream({
        messages: [{ role: 'user', content: 'hi' }],
        _run: async ({ toolHandlers }) => { handlers = toolHandlers; return '' },
        _newsHandlers: () => ({ get_news: async (args) => { seen.push(['news', args]); return 'headlines' } }),
        _analystActions: async (symbols, limit) => { seen.push(['analyst', symbols, limit]); return [{ symbol: 'NVDA' }] },
    })
    for (const t of MENTOR_TOOLS) {
        if (t.name === 'consult' || t.name === 'web_search') continue   // built by runAgentStream / server-side
        assert.equal(typeof handlers[t.name], 'function', `${t.name} is declared but has no handler`)
    }
    assert.equal(await handlers.get_news({ category: 'companies', subject: 'NVDA' }), 'headlines')
    assert.deepEqual(await handlers.get_analyst_actions({ symbols: ['NVDA'], limit: 5 }), [{ symbol: 'NVDA' }])
    // A missing `symbols` reaches the provider as an empty list, never as undefined.
    await handlers.get_analyst_actions({})
    assert.deepEqual(seen[2], ['analyst', [], undefined])
})

test('a provider failure on the new tools comes back as a tool error, not a thrown stream', async () => {
    let handlers = null
    await mentorAgentService.chatStream({
        messages: [{ role: 'user', content: 'hi' }],
        _run: async ({ toolHandlers }) => { handlers = toolHandlers; return '' },
        _analystActions: async () => { throw new Error('FMP down') },
    })
    const out = await handlers.get_analyst_actions({ symbols: ['NVDA'] })
    assert.match(JSON.stringify(out), /Could not fetch analyst actions: FMP down/)
})
