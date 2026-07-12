import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMessages } from '../../services/agentUtils.js'

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
