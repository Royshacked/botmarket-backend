import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TOOLS, _parseStrategyResponse, _coverageBySector, _buildTurnContext, _buildMessages } from '../../services/agents/strategy.agent.service.js'
import { ALL_EMIT_TAGS } from '../../services/llmStream.util.js'
import { SECTORS } from '../../services/entity/vocabulary.js'

// Pythia's agent seams (pure). The stream itself is contract-tested with the other desks.

// ── the emit tag must be registered or it leaks ──────────────────────────────
test('<tilt> is in the shared emit-tag registry', () => {
    // Not cosmetic: buildTagCaptures suppresses only registered tags, so an unregistered one streams
    // raw JSON into the user's chat. This is the exact bug the Axl <open> tag hit.
    assert.ok(ALL_EMIT_TAGS.includes('tilt'))
})

// ── draft extraction ─────────────────────────────────────────────────────────
test('a published turn yields the reply and the parsed draft, block stripped', () => {
    const raw = `<phase>5</phase>Here is the view.\n<tilt>{"benchmark":"SPX","tilts":[{"sector":"Energy","stance":"under","active_bp":-150}]}</tilt>`
    const { reply, tilt } = _parseStrategyResponse(raw)
    assert.equal(reply, 'Here is the view.')
    assert.equal(tilt.tilts[0].sector, 'Energy')
})

test('a discussion turn emits nothing, and that is normal', () => {
    const { reply, tilt } = _parseStrategyResponse('Financials look stretched, but I would not act yet.')
    assert.equal(tilt, null)
    assert.match(reply, /^Financials/)
})

test('a malformed or empty block is null, never a half-built view', () => {
    assert.equal(_parseStrategyResponse('<tilt>{not json}</tilt>').tilt, null)
    assert.equal(_parseStrategyResponse('<tilt>{"tilts":[]}</tilt>').tilt, null, 'a table with no rows is not a view')
    assert.equal(_parseStrategyResponse('<tilt>{"benchmark":"SPX"}</tilt>').tilt, null)
    assert.equal(_parseStrategyResponse('<tilt>[1,2]</tilt>').tilt, null)
    assert.equal(_parseStrategyResponse(null).tilt, null)
})

// ── the bottom-up cross-check ────────────────────────────────────────────────
const BOOK = [
    { userId: 'u1', symbol: 'NVDA', sector: 'Technology' },
    { userId: 'u2', symbol: 'AMD',  sector: 'Technology' },
    { userId: 'u1', symbol: 'XOM',  sector: 'Energy' },
]

test('the cross-check reads the WHOLE institution’s book, not one user’s', async () => {
    // A house view is a broadcast, so "what does our research think" spans every analyst. The read
    // is coverage's owner-blind sweep for exactly that reason.
    let asked = null
    const out = await _coverageBySector({ listActiveBySector: async (s) => { asked = s; return BOOK } })
    assert.deepEqual(asked, SECTORS, 'it asks about every sector')
    assert.match(out, /Technology\s+2 names — NVDA, AMD/)
    assert.match(out, /Energy\s+1 name — XOM/)
})

test('sectors with NO coverage are named — silence would read as agreement', async () => {
    const out = await _coverageBySector({ listActiveBySector: async () => BOOK })
    assert.match(out, /No coverage at all in: .*Utilities/)
    assert.match(out, /has no bottom-up support/)
})

test('an empty book says so rather than implying our analysts agree', async () => {
    const out = await _coverageBySector({ listActiveBySector: async () => [] })
    assert.match(out, /coverage book is empty/)
    assert.match(out, /rather than implying our analysts agree/)
})

// ── the turn context ─────────────────────────────────────────────────────────
test('the published view rides the TURN context, not the system prompt', () => {
    // A volatile block in the system tail sits ahead of the whole conversation in the cache prefix,
    // so the history breakpoint can never hit. This is the measured fix, not a style choice.
    const ctx = _buildTurnContext({ current_tilt: { id: 'tilt1', tilts: [{ sector: 'Energy' }] } })
    assert.match(ctx, /CURRENT PUBLISHED VIEW/)
    assert.match(ctx, /reaffirmed stance keeps its original clock/)
    assert.match(ctx, /tilt1/)
    assert.equal(_buildTurnContext({}), null, 'no published view → nothing attached')
    assert.equal(_buildTurnContext(undefined), null)
})

// ── the tool surface ─────────────────────────────────────────────────────────
test('the desk gets the top-down reads and NOT the stock-picking ones', () => {
    const names = TOOLS.map(t => t.name)
    for (const t of ['get_macro_snapshot', 'get_sector_snapshot', 'get_priced_in', 'get_coverage_by_sector']) {
        assert.ok(names.includes(t), `missing ${t}`)
    }
    // Pythia does not pick names or size positions — giving it these would invite it to.
    for (const t of ['compute_valuation', 'get_fundamentals', 'screen_candidates', 'check_broker_symbol', 'get_trading_context']) {
        assert.ok(!names.includes(t), `${t} belongs to another desk`)
    }
})

test('the argument-free tools come from the SHARED registry with an empty schema', () => {
    // They used to be hand-rolled objects on this array, which bypassed the one place tool schemas
    // live — and therefore the orphan/snapshot guards that watch it.
    for (const t of TOOLS.filter(t => ['get_priced_in', 'get_coverage_by_sector'].includes(t.name))) {
        assert.equal(t.input_schema.type, 'object')
        assert.deepEqual(t.input_schema.properties, {}, `${t.name} should take no arguments`)
    }
})

// ── message assembly ─────────────────────────────────────────────────────────
test('a first turn becomes ONE user message — an empty array is a 400 at the API', () => {
    // normalizeMessages takes (messages, maxCount) and does NOT append userPrompt. Passing it as the
    // second argument yields [] silently, and the failure only surfaces as
    // "messages: at least one message is required" once the request is already in flight.
    assert.deepEqual(_buildMessages({ userPrompt: 'Publish the house view.' }),
        [{ role: 'user', content: 'Publish the house view.' }])
    assert.deepEqual(_buildMessages({ messages: [], userPrompt: 'go' }), [{ role: 'user', content: 'go' }])
})

test('a continuing conversation is trimmed and coalesced, not replaced by the prompt', () => {
    const msgs = [
        { role: 'user', content: 'what is your read on energy?' },
        { role: 'assistant', content: 'Underweight.' },
    ]
    const out = _buildMessages({ messages: msgs, userPrompt: 'ignored when history exists' })
    assert.equal(out.length, 2)
    assert.equal(out[0].content, 'what is your read on energy?')
})

test('nothing to say yields an empty array rather than a phantom turn', () => {
    assert.deepEqual(_buildMessages({}), [])
})
