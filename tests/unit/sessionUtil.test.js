import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    toTimelineMessage, segmentOf, cutContent, toContextMessages, capSealed, sessionTitle,
    MAX_CONTENT_CHARS, MAX_SEALED_MESSAGES, isScope,
} from '../../services/session.util.js'

// The unified chat's pure helpers (services/session.util.js). The rule they carry: the SESSION is the
// whole chat the user sees; a CONTEXT is one agent's own memory — and segmentOf is the line between them.

const msg = (agent, role, content, extra = {}) => ({ agent, role, kind: 'msg', content, ...extra })

// ── a timeline message ──────────────────────────────────────────────────────

test('a valid message is normalized: agent, role, kind, text, ref, to, timestamp', () => {
    const { message } = toTimelineMessage(msg('mentor', 'user', 'long NVDA'), 1000)
    assert.deepEqual(message, { agent: 'mentor', role: 'user', kind: 'msg', content: 'long NVDA', ref: null, to: null, at: 1000 })
})

test('an unknown agent, role or kind is refused', () => {
    assert.match(toTimelineMessage(msg('kairos', 'user', 'x')).error, /invalid agent/)
    assert.match(toTimelineMessage(msg('axl', 'system', 'x')).error, /role/)
    assert.match(toTimelineMessage({ ...msg('axl', 'user', 'x'), kind: 'nope' }).error, /invalid kind/)
    assert.match(toTimelineMessage(null).error, /object/)
})

test('a hand-off must name who receives it; `to` is dropped on anything else', () => {
    assert.match(toTimelineMessage({ agent: 'portfolio', role: 'assistant', kind: 'handoff', content: 'scan' }).error, /receiving agent/)
    const ok = toTimelineMessage({ agent: 'portfolio', role: 'assistant', kind: 'handoff', content: 'scan', to: 'scanner' })
    assert.equal(ok.message.to, 'scanner')
    assert.equal(toTimelineMessage(msg('axl', 'user', 'hi', { to: 'mentor' })).message.to, null)
})

test('an empty ordinary turn is refused; a card or seal line may carry no text', () => {
    assert.match(toTimelineMessage(msg('axl', 'user', '   ')).error, /non-empty/)
    assert.equal(toTimelineMessage({ agent: 'mentor', role: 'assistant', kind: 'sealed', content: '', ref: { kind: 'setup', id: 's1' } }).error, undefined)
})

test('an over-long message is CUT with a marker, never refused — the user’s words still land', () => {
    const long = 'x'.repeat(MAX_CONTENT_CHARS + 500)
    const out = cutContent(long)
    assert.equal(out.length, MAX_CONTENT_CHARS)
    assert.match(out, /cut: message too long/)
    assert.equal(cutContent('short'), 'short')
    assert.equal(cutContent(42), '')
})

// ── the segment — one agent's context ───────────────────────────────────────

test('an agent’s segment is its own turns and the hand-offs addressed to it — never another agent’s', () => {
    const timeline = [
        msg('axl', 'user', 'I want to invest'),
        msg('axl', 'assistant', 'Atlas, then'),
        msg('portfolio', 'user', 'growth, mid-cap'),
        msg('portfolio', 'assistant', 'mandate drafted'),
        { agent: 'portfolio', role: 'assistant', kind: 'handoff', content: 'Scan semis', to: 'scanner' },
        msg('scanner', 'assistant', '8 names'),
        { agent: 'scanner', role: 'assistant', kind: 'handoff', content: 'Cover these', to: 'analyst' },
        { agent: 'mentor', role: 'assistant', kind: 'card', content: 'AMD setup filled' },
    ]
    assert.deepEqual(segmentOf(timeline, 'scanner').map(m => m.content), ['Scan semis', '8 names', 'Cover these'])
    assert.deepEqual(segmentOf(timeline, 'portfolio').map(m => m.content), ['growth, mid-cap', 'mandate drafted', 'Scan semis'])
    assert.deepEqual(segmentOf(timeline, 'analyst').map(m => m.content), ['Cover these'])
    // A background card is shown to the user; it is not part of any agent's conversation.
    assert.deepEqual(segmentOf(timeline, 'mentor'), [])
    assert.deepEqual(segmentOf(null, 'axl'), [])
})

// ── sealing ─────────────────────────────────────────────────────────────────

test('sealed messages keep role + text + time, and only real turns', () => {
    const out = toContextMessages([
        { role: 'user', content: 'hi', at: 5 }, { role: 'system', content: 'x' }, { role: 'assistant', content: '  ' }, null,
        { role: 'assistant', content: 'yo' },
    ], 9)
    assert.deepEqual(out, [{ role: 'user', content: 'hi', at: 5 }, { role: 'assistant', content: 'yo', at: 9 }])
})

test('a sealed context keeps its newest messages', () => {
    const many = Array.from({ length: MAX_SEALED_MESSAGES + 5 }, (_, i) => ({ i }))
    const kept = capSealed(many)
    assert.equal(kept.length, MAX_SEALED_MESSAGES)
    assert.equal(kept[0].i, 5)
})

// ── titles and scopes ───────────────────────────────────────────────────────

test('a session is titled by its first user message, cut for a list row', () => {
    assert.equal(sessionTitle([{ role: 'assistant', content: 'Hi' }, { role: 'user', content: '  trade NVDA  ' }]), 'trade NVDA')
    assert.equal(sessionTitle([{ role: 'user', content: 'y'.repeat(200) }]).length, 80)
    assert.equal(sessionTitle([]), 'Untitled')
})

test('the scopes are the one chat and the two admin desks', () => {
    for (const s of ['main', 'strategy', 'aether']) assert.equal(isScope(s), true)
    for (const s of ['', 'mentor', null, undefined]) assert.equal(isScope(s), false)
})
