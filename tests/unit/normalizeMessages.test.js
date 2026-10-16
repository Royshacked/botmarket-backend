import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMessages, openingTurn, cleanReply, cachedBlock } from '../../services/agentUtils.js'

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

// ── openingTurn: how a headless run opens a desk ─────────────────────────────
//
// Every caller hands a desk `messages`. A headless run (a research run, a quick read, an industry
// assessment) opens on one sentence, and this is its one spelling — the parallel `userPrompt`
// argument it replaced set a trap: normalizeMessages does not read it, so a caller that forgot the
// special case reached the provider with zero messages.

test('opening turn: one sentence becomes the first user message, trimmed', () => {
    assert.deepEqual(openingTurn('  cover NVDA '), [{ role: 'user', content: 'cover NVDA' }])
})

test('opening turn: a blank or non-string opening is no conversation', () => {
    for (const empty of ['   ', '', null, undefined, 42, {}]) {
        assert.deepEqual(openingTurn(empty), [], String(empty))
    }
})

test('opening turn: survives normalizeMessages unchanged — the desk reads it like any history', () => {
    assert.deepEqual(normalizeMessages(openingTurn('cover NVDA'), 8), [{ role: 'user', content: 'cover NVDA' }])
})

// ── cleanReply: one list of tags for every desk ──────────────────────────────

test('clean reply: every registered emit block is removed, whichever desk wrote it', () => {
    // Each desk used to hand-list what it strips; a tag it did not expect survived as raw markup.
    const raw = 'Here is the plan.\n<phase>2</phase><route>research NVDA</route><scan_list>{"a":1}</scan_list><suggest>["x"]</suggest>'
    assert.equal(cleanReply(raw), 'Here is the plan.')
})

test('clean reply: <ticker> is UNWRAPPED, not removed — its text is prose', () => {
    assert.equal(cleanReply('Buy <ticker>NVDA</ticker> on the dip.'), 'Buy NVDA on the dip.')
})

test('clean reply: empty and missing input are an empty reply', () => {
    assert.equal(cleanReply(null), '')
    assert.equal(cleanReply(undefined), '')
    assert.equal(cleanReply('  plain  '), 'plain')
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
