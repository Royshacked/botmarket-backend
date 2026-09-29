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
    entry_legs: [{ price: 238.6, quantity: 100 }],
    stop_legs:  [{ price: 234.8, quantity: 100 }],
    target_legs:    [{ price: 246.0, quantity: 100 }],
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
    assert.deepEqual(merged.entry_legs, SETUP.entry_legs)
})

test('a re-emitted array replaces wholesale, so the model can still DROP a leg', () => {
    const merged = _mergeSetupDraft(SETUP, { entry_legs: [{ price: 231, quantity: 50 }] })
    assert.equal(merged.entry_legs.length, 1)
    assert.equal(merged.entry_legs[0].price, 231)
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
    assert.ok(!reply.includes('entry_legs'), 'raw JSON must never reach the user')
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
        { label: 'Break of the shelf', pitch: 'Momentum.', setup: { ...SETUP, trade_mode: 'discretionary', entry_legs: [{ price: 242, quantity: 100 }] } },
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
        { id: 's1', name: 'pullback', entry_legs: [{ price: 201, quantity: 60 }],
          stop_legs: [{ price: 194 }], validity: { lower: 196, upper: 210 } },
        { id: 's2', name: 'breakout', entry_legs: [{ price: 209, quantity: 100 }],
          stop_legs: [{ price: 204 }], validity: { lower: 200, upper: 220 } },  // below ITS stop
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

// ─── The build, as the prompt states it ───────────────────────────────────────
// The FLOW is server state now (services/mentorBuild.util.js), so what the prompt still has to
// carry is the part a model must hold: the stages in order, the claim/settle distinction, which
// stops belong to the user, and the grounding rules. The prose assertions are deliberately few and
// anchored on the bold rule names, which is the level a rewrite would have to preserve on purpose.

const PROMPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../prompts/mentor_system_prompt.md'), 'utf8')

test('the five stages are named in the order they settle', () => {
    assert.match(PROMPT, /\*\*opening\*\*[^\n]*→ \*\*spans\*\*[^\n]*→ \*\*entries\*\*[\s\S]{0,60}→ \*\*sizing\*\* → \*\*summary\*\*/)
})

test('the ledger rules are stated: a claim is not a settlement, settled is settled, talk is free', () => {
    for (const rule of ['A CLAIM is not a SETTLEMENT.', 'Settled is settled.', 'Talking never moves it.', 'Always soft.']) {
        assert.ok(PROMPT.includes(`**${rule}**`), `missing rule: ${rule}`)
    }
    // Reopening is the only way a settled value changes, and it cascades.
    assert.match(PROMPT, /unsettle[\s\S]{0,120}reopens every stage below it/)
})

test('three stops belong to the user and two gates can be waived', () => {
    assert.match(PROMPT, /Three stages are the user's and are never skipped: the opening, sizing, and the summary/)
    assert.match(PROMPT, /spans and entries — are theirs too, unless they waived them/)
    // A waived gate is still REPORTED, or the user agreed to something they never heard.
    assert.match(PROMPT, /A call the user never heard is one they\s+never made/)
})

test('the opening turn answers all three at once, cheapest tools first, and asks the waiver ONCE', () => {
    const section = PROMPT.slice(PROMPT.indexOf('## The opening turn'), PROMPT.indexOf('## The stages after the opening'))
    assert.ok(section.length > 0, 'the opening turn sits before the later stages')
    assert.match(section, /Whatever arrived is\s+a CLAIM/)
    assert.match(section, /direction, horizon and lens/)
    assert.match(section, /Read it, cheapest first/)
    assert.match(section, /Only on a real conflict[\s\S]{0,120}`consult`/)
    assert.match(section, /Never fetch twice in one build/)
    assert.match(section, /asked \*\*once, here\*\* — never later/)
    // The worksheet is what carries the ledger between turns (mentor.agent.service.js).
    assert.match(section, /Emit the worksheet on this turn/)
})

test('the later stages keep the decisions that are theirs and not the model\'s', () => {
    const section = PROMPT.slice(PROMPT.indexOf('## The stages after the opening'))
    assert.match(section, /Up to\s+\*\*four\*\* candidates/, 'spans are capped')
    // The rejects travel with the candidates — they are what makes the gate a choice.
    assert.match(section, /What you DISCARDED travels with them, one clause each/)
    // The spans stage is about WHERE, and says so; the mechanics are the next stage's.
    assert.match(section, /a stage about WHERE, not how/)
    assert.match(section, /<spans>/, 'the candidates have an emit contract')
    assert.match(section, /`get_chart` with `show_to_user: true`[\s\S]{0,60}`levels`/, 'and are drawn')
    // The field that changes what the broker does, and the default that cannot add risk.
    assert.match(section, /`alternatives` \(the default\) means the first trigger to fire takes the WHOLE\s+position/)
    assert.match(section, /Never let a list of entries imply scaling/)
    assert.match(section, /the shares\s+must add to 100/)
    // Tested on THIS ticker, and the evidence is counted rather than felt.
    assert.match(section, /does it work on THIS ticker/)
    assert.match(section, /it is a measurement, not a feeling/)
    assert.match(section, /The stop is a \*\*price\*\*/)
    assert.match(section, /Management — break-even, trailing — is NOT\s+authored/)
    assert.match(section, /Never choose it for them/, 'sizing stays the user\'s')
    // The money is computed and read out, never derived by the model on a live account.
    assert.match(section, /the gain and the loss both in dollars and as a\s+percent of the account\*\*/)
    assert.match(section, /computed for you and handed to you in the turn\s+context/)
    assert.match(section, /never recompute them/)
    assert.match(section, /marked ESTIMATED/)

    // And the five sizing units live where sizing does.
    const sizing = PROMPT.slice(PROMPT.indexOf('## Size comes from the user'))
    assert.match(sizing, /Ask which unit they think in, and take any of the five/)
    assert.match(sizing, /record it and let the server size it/)
    assert.match(sizing, /"size":\{"unit":"risk_pct","value":1\}/, 'the op has a shape the model can copy')
    assert.match(sizing, /Do not\s+do this arithmetic yourself on a live account/)
    assert.match(sizing, /Size the TRADE, not the leg/)
    assert.match(sizing, /the user picks it in the account menu/)
})

test('the <build> tag contract is stated, including that settle is never the model\'s own', () => {
    const section = PROMPT.slice(PROMPT.indexOf('`<build>` moves the LEDGER'))
    assert.match(section, /never shown to them/)
    // Unconditional, like <asset>: a tag emitted only "when something happened" is skipped on the
    // turn something happened, and the user is then asked the same question twice (live run,
    // 2026-09-29).
    assert.match(section, /END EVERY RESPONSE WITH ONE/)
    assert.match(section, /<build>\{\}<\/build>/)
    assert.match(section, /`settle` is the user's confirmation — \*\*never your own\*\*/)
    assert.match(section, /A settlement out of order is REFUSED/)
})

test('the grounding rules survived the flow moving into the server', () => {
    for (const rule of ['Tools, not memory.', 'Live before levels.']) {
        assert.ok(PROMPT.includes(`**${rule}**`), `missing rule: ${rule}`)
    }
})

test('a brought plan asks only for what is missing, and is never offered the waiver', () => {
    const section = PROMPT.slice(PROMPT.indexOf('### When the plan is already theirs'), PROMPT.indexOf('## `scenarios[]`'))
    assert.match(section, /you ask only for what is genuinely missing/)
    assert.match(section, /almost always the SIZE/)
    assert.match(section, /You do not offer the waiver/)
})

test('candidates are an explicit ask now — a walked build ends in one setup', () => {
    assert.match(PROMPT, /## Offering candidates — only when they ask for options/)
    assert.match(PROMPT, /A walked build does not reach for it on its own/)
    assert.doesNotMatch(PROMPT, /When the user has no setup, offer a few/, 'the old default-to-candidates invariant is gone')
})

test('scenario count is Mentor\'s on a walked build — same premise at two levels is allowed, padding is not', () => {
    assert.match(PROMPT, /if they are all pullbacks, they are all\s+pullbacks/)
    assert.doesNotMatch(PROMPT, /Most setups have exactly one\./)
    assert.match(PROMPT, /never pad to two because a pair reads balanced/)
})

test('nothing in the prompt still points at the deleted ladder', () => {
    assert.doesNotMatch(PROMPT, /guided build/i)
    assert.doesNotMatch(PROMPT, /rung [0-9]/i)
    assert.doesNotMatch(PROMPT, /the ladder/i)
})

test('Mentor’s own additions are declared after the kit, with the sidecar last', () => {
    const names = MENTOR_TOOLS.map(t => t.name)
    const kitEnd = names.indexOf('get_key_levels')   // SMC_TOOLS closes the shared kit
    assert.ok(kitEnd > 0)
    // `flip_test` sits between the ladder's two tools and the sidecar: `consult` is contractually
    // last at every desk (agentToolsRegistry.test.js), and everything here is past the tools cache
    // breakpoint inside TRADING_TOOLS, so the cached prefix is untouched either way.
    assert.deepEqual(names.slice(kitEnd + 1), ['get_news', 'get_analyst_actions', 'flip_test', 'consult'])
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


// ─── The challenge record is the SERVER's ─────────────────────────────────────
//
// Phase 3 of docs/design/mentor-challenge.md. Provenance authored by the party it vouches for is
// worth less than none: a desk that can write `stands` onto its own plan has produced a confirm-time
// reassurance with nothing behind it. So the flip handler reports the verdict to the server and the
// server is the only writer.

const A_WORKSHEET = (extra = '') => `<setup>{
    "asset": "NVDA", "direction": "long", "type": "swing",
    "conditions": [{ "id": "c1", "text": "holds above the 4hr VWAP" }],
    "scenarios": [{ "id": "s1", "entry_legs": [{ "price": 238.6, "quantity": 100 }],
                    "stop_legs": [{ "price": 234.8 }], "target_legs": [{ "price": 246 }] }]${extra}
}</setup>`

const runWithFlip = ({ verdict = null, emit = '', chatState } = {}) => mentorAgentService.chatStream({
    messages: [{ role: 'user', content: 'attack it' }],
    ...(chatState ? { chatState } : {}),
    _flipHandler: ({ onVerdict }) => async () => { if (verdict) onVerdict(verdict); return 'VERDICT: neither …' },
    _run: async ({ toolHandlers }) => {
        await toolHandlers.flip_test({ symbol: 'NVDA', direction: 'long' })
        return A_WORKSHEET(emit)
    },
})

test('a flip verdict is stamped onto the worksheet by the server', async () => {
    const out = await runWithFlip({ verdict: 'two_sided' })
    assert.equal(out.setup.challenges.length, 1)
    assert.equal(out.setup.challenges[0].pass, 'flip')
    assert.equal(out.setup.challenges[0].verdict, 'two_sided')
    assert.match(out.setup.challenges[0].at, /^\d{4}-\d{2}-\d{2}T/, 'stamped here, because this is the layer that knows the turn happened')
})

test('a verdict the model made up is discarded', async () => {
    // No flip ran, and the emit claims one came back clean. The field is server-owned, so the claim
    // simply does not survive normalisation.
    const out = await mentorAgentService.chatStream({
        messages: [{ role: 'user', content: 'hi' }],
        _run: async () => A_WORKSHEET(', "challenges": [{ "pass": "flip", "verdict": "stands", "at": "2026-09-26T10:00:00Z" }]'),
    })
    assert.deepEqual(out.setup.challenges, [])
})

test('a real verdict is not overwritten by the model\u2019s version of it', async () => {
    const out = await runWithFlip({ verdict: 'reversed', emit: ', "challenges": [{ "pass": "flip", "verdict": "stands" }]' })
    assert.deepEqual(out.setup.challenges.map(c => c.verdict), ['reversed'])
})

test('the record carries forward across turns, and does not double-count', async () => {
    const prior = { draft: { challenges: [{ pass: 'flip', verdict: 'stands', at: '2026-09-26T09:00:00Z' }] } }

    // A turn with no flip test keeps what the server already recorded.
    const quiet = await mentorAgentService.chatStream({
        messages: [{ role: 'user', content: 'hi' }], chatState: prior,
        _run: async () => A_WORKSHEET(),
    })
    assert.deepEqual(quiet.setup.challenges.map(c => c.verdict), ['stands'])

    // A turn WITH one appends, so a plan attacked twice on two different maps reads as a history.
    const again = await runWithFlip({ verdict: 'two_sided', chatState: prior })
    assert.deepEqual(again.setup.challenges.map(c => c.verdict), ['stands', 'two_sided'])
})

// ─── What the live builds taught the prompt (2026-09-29) ─────────────────────

test('a shut market is spoken as a CLOSE, not as a live price', () => {
    // Observed: "the market is closed" in one sentence and "NVDA is at 228.86" in the next.
    assert.match(PROMPT, /\*\*And SAY which price it is\.\*\*/)
    assert.match(PROMPT, /never \*"NVDA is at 228\.86"\*/)
    assert.match(PROMPT, /A number in the present tense is a\s+number somebody may act on/)
})

test('an earnings date inside the horizon is DECIDED, and the plan says the same thing', () => {
    assert.match(PROMPT, /exactly two honest\s+answers: be out before it, or hold through it/)
    assert.match(PROMPT, /`valid_until` ahead of the date/)
    assert.match(PROMPT, /deciding nothing is how a\s+plan ends up straddling/)
})

test('the earnings DATE comes from get_earnings, not from a window that may exclude it', () => {
    // The live flip-flop: the calendar was asked about a window ending before the date, and the
    // empty answer was read as evidence the date was wrong.
    assert.match(PROMPT, /\*\*`get_earnings` for the date\*\*/)
    assert.match(PROMPT, /It is not evidence the date is wrong/)
})

test('the model is told that some answers arrive already settled, by a press', () => {
    assert.match(PROMPT, /Some answers arrive as a PRESS, already recorded/)
    assert.match(PROMPT, /The `<build>` tag is for the answers that arrive as WORDS/)
})

test('the document has one H1, and the beats are subsections of the opening turn', () => {
    const h1s = [...PROMPT.matchAll(/^# (?!#)(.+)$/gm)].map(m => m[1])
    assert.deepEqual(h1s, ['Mentor — Trade Assistant'], 'a stray H1 reads as a second document')
    assert.match(PROMPT, /### Beat one/)
    assert.match(PROMPT, /### Beat two/)
})

// ─── The deeper read (2026-09-29): contradictions between old and new sections ──
// Eight edits in one day left sections that each read correctly and disagreed with each other.

test('a user with no name is sent to ARGUS, the scanning desk', () => {
    // Roy corrected this in the first minute of the design conversation; the prompt still said Axl.
    assert.match(PROMPT, /\*\*send them to Argus\*\*, the scanning desk/)
    assert.doesNotMatch(PROMPT, /point them back to Axl/)
})

test('"levels, not bands" no longer contradicts the trigger entry', () => {
    const section = PROMPT.slice(PROMPT.indexOf('## Levels, not bands'), PROMPT.indexOf('### Name the way in'))
    assert.match(section, /The one entry that is\s+not a level is the TRIGGER entry/)
    assert.match(section, /an entry that is a trigger as/)
})

test('scale-in is legs inside one scenario; rival scenarios are alternatives', () => {
    // The old line said both at once: "multiple entry levels = scale-in ... whichever price
    // reaches first acts", which describes alternatives while calling it scaling in.
    const section = PROMPT.slice(PROMPT.indexOf('## Levels, not bands'), PROMPT.indexOf('### Name the way in'))
    assert.match(section, /Two entry legs inside ONE scenario are a scale-in/)
    assert.match(section, /BOTH are meant to fill/)
    assert.match(section, /two\s+scenarios, which are RIVALS/)
    assert.doesNotMatch(section, /Multiple entry levels = scale-in/)
})

test('the Generate gate knows about trigger entries and server-side sizing', () => {
    const gate = PROMPT.slice(PROMPT.indexOf('## Ready to Generate'))
    assert.match(gate, /an\s+entry \(a price, or a trigger in words\)/)
    assert.match(gate, /a size THE USER CHOSE/)
    assert.match(gate, /they give the unit and the number, it gives the quantity/)
    assert.doesNotMatch(gate, /a quantity THE USER GAVE\s+YOU/)
})

test('"the tag is the move" is scoped to answers that arrive as words', () => {
    assert.match(PROMPT, /When the answer comes in WORDS, the tag is the move/)
    assert.match(PROMPT, /When they PRESSED instead, it is already recorded/)
})

test('the ledger section counts its own rules correctly', () => {
    const intro = PROMPT.slice(PROMPT.indexOf('things about the ledger'), PROMPT.indexOf('Three stages are the user'))
    const bullets = (intro.match(/^- \*\*/gm) ?? []).length
    assert.match(PROMPT, new RegExp(`${['', 'One', 'Two', 'Three', 'Four', 'Five'][bullets]} things about the ledger`))
})
