import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEmitBlock, mergeDraft, makePhaseCapture, runAgentStream } from '../../services/agentIO.js'

// The agent I/O protocol. Every streaming agent repeated these mechanics verbatim — three
// identical parse functions, two character-for-character identical draft merges, and five
// hand-rolled phase closures whose bounds had drifted apart.

// ─── parseEmitBlock ───────────────────────────────────────────────────────────

test('pulls the block out and parses it', () => {
    assert.deepEqual(parseEmitBlock('prose <call>{"asset":"NVDA"}</call> more', 'call'), { asset: 'NVDA' })
})

test('a tag is matched EXACTLY — <setups> must never be read as <setup>', () => {
    // The two share a prefix. A loose match would parse the candidate OFFER as a worksheet and
    // hand the client a bogus single artifact.
    const raw = '<setups>{"candidates":[]}</setups>'
    assert.equal(parseEmitBlock(raw, 'setup'), null)
    assert.deepEqual(parseEmitBlock(raw, 'setups'), { candidates: [] })
})

test('malformed JSON returns null rather than a half-parsed draft', () => {
    // The client replaces its worksheet wholesale, so a partial object would wipe settled fields.
    assert.equal(parseEmitBlock('<call>{ "asset": </call>', 'call'), null)
    assert.equal(parseEmitBlock('<call>not json at all</call>', 'call'), null)
})

test('an absent block is null, not an error — most turns emit nothing', () => {
    assert.equal(parseEmitBlock('just talking', 'call'), null)
    assert.equal(parseEmitBlock('', 'call'), null)
    assert.equal(parseEmitBlock(null, 'call'), null)
    assert.equal(parseEmitBlock(undefined, 'call'), null)
})

test('a malformed block never throws — the turn still has a usable reply', () => {
    assert.doesNotThrow(() => parseEmitBlock('<call>{{{</call>', 'call'))
})

test('the FIRST block wins when a model emits two', () => {
    const raw = '<call>{"n":1}</call> then <call>{"n":2}</call>'
    assert.deepEqual(parseEmitBlock(raw, 'call'), { n: 1 })
})

test('a block spanning newlines parses — models pretty-print their JSON', () => {
    assert.deepEqual(parseEmitBlock('<call>\n{\n  "asset": "TSLA"\n}\n</call>', 'call'), { asset: 'TSLA' })
})

test('an unclosed block is treated as absent', () => {
    // A truncated reply (stop_reason=max_tokens) leaves the opening tag with no close.
    assert.equal(parseEmitBlock('<call>{"asset":"NVDA"}', 'call'), null)
})

// ─── mergeDraft ───────────────────────────────────────────────────────────────

test('an omitted field carries forward from the prior draft', () => {
    // The "make it $1k" turn: the model narrates "everything else stands" and emits one field.
    const merged = mergeDraft({ asset: 'NVDA', zones: [1], thesis: 'sweep' }, { thesis: 'reclaim' })
    assert.equal(merged.asset, 'NVDA')
    assert.deepEqual(merged.zones, [1])
    assert.equal(merged.thesis, 'reclaim')
})

test('a re-emitted array replaces wholesale, so the model can still DROP an item', () => {
    assert.deepEqual(mergeDraft({ zones: [1, 2, 3] }, { zones: [9] }).zones, [9])
})

test('an explicit null clears a field — only omission is protected', () => {
    assert.equal(mergeDraft({ valid_until: 'x' }, { valid_until: null }).valid_until, null)
})

test('no new artifact this turn → null, so the caller keeps what it has', () => {
    assert.equal(mergeDraft({ asset: 'NVDA' }, null), null)
    assert.equal(mergeDraft(null, null), null)
    assert.equal(mergeDraft(null, undefined), null)
})

test('a first artifact with no prior draft passes straight through', () => {
    const next = { asset: 'NVDA' }
    assert.deepEqual(mergeDraft(null, next), next)
})

test('a malformed prior draft is discarded, not merged into', () => {
    // An array or primitive spread into an object would produce indexed garbage keys.
    assert.deepEqual(mergeDraft([], { asset: 'NVDA' }), { asset: 'NVDA' })
    assert.deepEqual(mergeDraft('nope', { asset: 'NVDA' }), { asset: 'NVDA' })
})

test('the inputs are not mutated', () => {
    const prev = { a: 1 }, next = { b: 2 }
    mergeDraft(prev, next)
    assert.deepEqual(prev, { a: 1 })
    assert.deepEqual(next, { b: 2 })
})

// ─── makePhaseCapture ─────────────────────────────────────────────────────────

test('captures a valid phase and forwards it', () => {
    const seen = []
    const p = makePhaseCapture(7, n => seen.push(n))
    p.capture('3')
    assert.equal(p.get(), 3)
    assert.deepEqual(seen, [3])
})

test('an out-of-range phase is ignored, not forwarded', () => {
    // Bounds differ per agent (1–5, 1–6, 1–7) and hand-rolling the closure is how they drifted.
    const seen = []
    const p = makePhaseCapture(5, n => seen.push(n))
    p.capture('9')
    p.capture('0')
    p.capture('-1')
    assert.equal(p.get(), null)
    assert.deepEqual(seen, [])
})

test('a non-numeric phase is ignored', () => {
    const p = makePhaseCapture(7, () => {})
    for (const bad of ['', 'three', null, undefined, {}]) p.capture(bad)
    assert.equal(p.get(), null)
})

test('the LAST valid phase wins across a multi-phase turn', () => {
    // Kairos threads several phases through one reply.
    const p = makePhaseCapture(7, () => {})
    p.capture('2'); p.capture('4'); p.capture('99')
    assert.equal(p.get(), 4, 'an invalid trailing value must not clear a good one')
})

test('works with no onPhase callback', () => {
    const p = makePhaseCapture(5)
    assert.doesNotThrow(() => p.capture('2'))
    assert.equal(p.get(), 2)
})

// ─── runAgentStream ───────────────────────────────────────────────────────────

test('passes the standard argument bag through to the provider', async () => {
    let got = null
    const streamFn = async (args) => { got = args; return 'raw reply' }
    const raw = await runAgentStream({
        log: '[t]', requestedModel: 'm', userId: null,
        messages: [{ role: 'user', content: 'hi' }],
        systemPrompt: 'sys', tools: ['T'], toolHandlers: { a: 1 },
        reasoningEffort: 'low', signal: 'SIG', onToken: 'TOK', tagCaptures: 'TAGS',
        onToolStart: 'TS', onReasoning: 'RS',
        _resolve: () => ({ model: 'resolved', streamFn, provider: 'p', onUsage: undefined }),
    })
    assert.equal(raw, 'raw reply')
    assert.equal(got.promptOrMessages[0].content, 'hi')
    assert.equal(got.systemPrompt, 'sys')
    assert.deepEqual(got.tools, ['T'])
    assert.equal(got.reasoningEffort, 'low')
    assert.equal(got.signal, 'SIG')
    assert.equal(got.tagCaptures, 'TAGS')
})

// ─── the reasoning sidecar, wired at the choke point ──────────────────────────
//
// The sidecar is auto-wired HERE rather than per desk, so these tests are what stop it silently
// regressing to eight hand-wired copies — the exact shape the tools registry was built to end.

const CONSULT_TOOL_DECL = { name: 'consult', description: 'x', input_schema: {} }

// Run one turn and hand back everything the seams saw.
async function runWith({ tools = [], toolHandlers = {}, onReasoning } = {}) {
    let got = null
    let consultOpts = null
    await runAgentStream({
        log: '[t]', requestedModel: 'm', userId: 'u1',
        messages: [{ role: 'user', content: 'hi' }],
        systemPrompt: 'sys', tools, toolHandlers, onReasoning,
        _resolve: () => ({ model: 'resolved', streamFn: async (a) => { got = a; return 'raw' }, provider: 'p' }),
        _makeConsult: (opts) => { consultOpts = opts; return async () => 'advice' },
    })
    return { got, consultOpts }
}

test('declaring the consult tool is the ONLY thing a desk does to get the sidecar', async () => {
    // The point of the whole design: no handler, no callback, no controller line. If this ever
    // needs a second edit at the desk, the per-desk plaster is back.
    const { got, consultOpts } = await runWith({ tools: [CONSULT_TOOL_DECL] })
    assert.equal(typeof got.toolHandlers.consult, 'function')
    assert.equal(consultOpts.userId, 'u1', 'the handler must be built for THIS user')
})

test('a desk that never declared the tool gets no consult handler', async () => {
    // Otherwise every desk silently carries a tool it never asked for, and the reach-rate ledger
    // the rollout is gated on stops meaning anything.
    const { got } = await runWith({ tools: [{ name: 'get_candles' }] })
    assert.equal(got.toolHandlers.consult, undefined)
})

test('a desk that supplies its own consult handler keeps it', async () => {
    const mine = async () => 'mine'
    const { got } = await runWith({ tools: [CONSULT_TOOL_DECL], toolHandlers: { consult: mine } })
    assert.equal(got.toolHandlers.consult, mine)
})

test('the two thinkers reach one callback under different labels', async () => {
    // Same event, different source — a second event type would mean new wiring in all five layers
    // it crosses. The desk's own thinking must keep the default label so nothing else has to change.
    const seen = []
    const { got, consultOpts } = await runWith({
        tools: [CONSULT_TOOL_DECL],
        onReasoning: (text, source) => seen.push([text, source]),
    })
    got.onReasoning('desk thought')
    consultOpts.onReasoning('sidecar thought')
    assert.deepEqual(seen, [['desk thought', 'desk'], ['sidecar thought', 'consult']])
})

test('no onReasoning stays undefined rather than becoming a no-op wrapper', async () => {
    // The provider skips the thinking plumbing entirely on undefined; a wrapper would defeat that.
    const { got, consultOpts } = await runWith({ tools: [CONSULT_TOOL_DECL] })
    assert.equal(got.onReasoning, undefined)
    assert.equal(consultOpts.onReasoning, undefined)
})
