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
