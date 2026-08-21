import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMessages, buildDeskMessages, cachedBlock } from '../../services/agentUtils.js'

// ── coalescing (Kairos threads one reply across several assistant bubbles) ──
test('normalize: coalesces consecutive assistant turns into one (phase-threaded reply)', () => {
    const out = normalizeMessages([
        { role: 'user', content: 'build AXON' },
        { role: 'assistant', content: 'Phase 1 recap' },   // split display bubbles →
        { role: 'assistant', content: 'zones 555-575' },    //   several assistant msgs in a row
        { role: 'assistant', content: 'stop 538' },
    ], 20)
    assert.equal(out.length, 2)
    assert.equal(out[0].role, 'user')
    assert.deepEqual(out[1], { role: 'assistant', content: 'Phase 1 recap\n\nzones 555-575\n\nstop 538' })
})

test('normalize: alternating turns pass through unchanged (other agents)', () => {
    const msgs = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'more' },
        { role: 'assistant', content: 'ok' },
    ]
    assert.deepEqual(normalizeMessages(msgs, 20), msgs)
})

test('normalize: coalesces user runs too, and trims each part', () => {
    const out = normalizeMessages([
        { role: 'user', content: '  first  ' },
        { role: 'user', content: 'second' },
    ], 20)
    assert.deepEqual(out, [{ role: 'user', content: 'first\n\nsecond' }])
})

test('normalize: slice(-maxCount) counts a coalesced run as ONE turn', () => {
    // 3 assistant bubbles collapse to 1 turn, so maxCount=2 keeps [user, assistant] — not a cut mid-run.
    const out = normalizeMessages([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
    ], 2)
    assert.deepEqual(out, [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a\n\nb' },
    ])
})

test('normalize: drops empty/whitespace + non-chat roles before coalescing', () => {
    const out = normalizeMessages([
        { role: 'user', content: 'q' },
        { role: 'phase', phase: 2 },           // not a chat role — dropped
        { role: 'assistant', content: '   ' },  // empty — dropped (so no stray merge)
        { role: 'assistant', content: 'real' },
    ], 20)
    assert.deepEqual(out, [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'real' },
    ])
})

test('normalize: non-array → empty', () => {
    assert.deepEqual(normalizeMessages(null, 5), [])
    assert.deepEqual(normalizeMessages(undefined, 5), [])
})

// ── buildDeskMessages: the opening turn vs a continuing one ──────────────────
//
// THE TRAP it exists to close: normalizeMessages does NOT append userPrompt. Handing it one yields
// an empty array — every filter drops it — and the provider then rejects the request with "at least
// one message is required", which reads as an API fault rather than a caller mistake. Three desks
// each carried their own copy of this branch, and each carried the warning comment with it.

test('desk messages: an opening turn becomes the first user message', () => {
    assert.deepEqual(buildDeskMessages({ messages: [], userPrompt: 'cover NVDA', max: 8 }),
        [{ role: 'user', content: 'cover NVDA' }])
    assert.deepEqual(buildDeskMessages({ messages: null, userPrompt: 'cover NVDA', max: 8 }),
        [{ role: 'user', content: 'cover NVDA' }])
})

test('desk messages: a continuing conversation is trimmed, and the prompt is NOT re-appended', () => {
    // The prompt is already the last message on a continuing turn — the client sent it. Appending it
    // again would double the user's own words back at the model.
    const out = buildDeskMessages({
        messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
        userPrompt: 'c', max: 8,
    })
    assert.deepEqual(out.map(m => m.content), ['a', 'b', 'c'])
})

test('desk messages: `max` belongs to the caller — desks do not agree on how much history they need', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))
    assert.ok(buildDeskMessages({ messages: many, max: 4 }).length <= 4)
    assert.ok(buildDeskMessages({ messages: many, max: 12 }).length > 4)
})

test('desk messages: a whitespace-only prompt is no prompt', () => {
    // Two of the three copies used String(userPrompt) and would have opened a conversation on '   '.
    // normalizeMessages drops such a message on every LATER turn, so trimming here makes the first
    // turn agree with all the others rather than being the one that lets it through.
    for (const empty of ['   ', '', null, undefined, 42, {}]) {
        assert.deepEqual(buildDeskMessages({ messages: [], userPrompt: empty, max: 8 }), [], String(empty))
    }
})

// ── cachedBlock: the breakpoint nothing can typo ─────────────────────────────

test('cachedBlock: carries the ephemeral breakpoint, and the text untouched', () => {
    // A block that silently LOSES its breakpoint still works perfectly — it just re-sends the whole
    // prompt uncached on every turn, forever, and the only signal is the bill. Which is why the
    // spelling is in one place and asserted here rather than hand-copied at seven sites.
    assert.deepEqual(cachedBlock('SYSTEM PROMPT'),
        { type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } })
})

// ── reception's depth: the cliff Axl fell off ────────────────────────────────
// The trim is a HIGH-WATER MARK (keep × 3), so `keep` sets two things at once: how much survives a
// trim, and how long a thread runs before one happens. At 12 that meant a reception chat ran to 36
// messages and then dropped to the last 6 turns in a single step — the shallowest floor in the app,
// on the desk most likely to run long. Pinned at Axl's real number so a "tidy it down" edit has to
// argue with the reason.
test('normalize: Axl keeps 20 messages and does not trim until 60', () => {
    const thread = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))

    // Below the ceiling nothing is dropped — that is what keeps the cached prefix byte-stable.
    assert.equal(normalizeMessages(thread(59), 20).length, 59)

    const trimmed = normalizeMessages(thread(61), 20)
    assert.ok(trimmed.length <= 20)
    assert.ok(trimmed.length >= 19)
    // The API rejects a history opening on an assistant turn, and slicing an odd total to an even
    // count lands on one — on exactly the turns the user is speaking.
    assert.equal(trimmed[0].role, 'user')
    assert.equal(trimmed.at(-1).content, 'm60')
})
