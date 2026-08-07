import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseStreamBody, parseClientTime, parseIdeaAccounts, parseChatMessages } from '../../api/_shared/parse.util.js'

// The shared agent-stream body parser. Kairos and Mentor each carried a copy of this and had
// drifted; these lock the ONE behaviour both endpoints now answer with.

const msgs = (...contents) => contents.map((content, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant', content,
}))

// ── the conversation ─────────────────────────────────────────────────────────

test('a valid conversation passes through validated and UNCAPPED', () => {
    // The cap is the agent's (normalizeMessages → trimHistory, which trims on a high-water mark so
    // the cached prompt prefix stays byte-stable). A slice() here would be the per-turn sliding
    // window that design exists to avoid, so the parser must hand over every turn it was given.
    const twenty = msgs(...Array.from({ length: 20 }, (_, i) => `turn ${i}`))
    const out = parseStreamBody({ messages: twenty })
    assert.equal(out.error, undefined)
    assert.equal(out.messages.length, 20)
    assert.equal(out.messages[0].content, 'turn 0')
})

test('content is trimmed and the roles are validated', () => {
    const out = parseStreamBody({ messages: [{ role: 'user', content: '  hi  ' }] })
    assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }])

    assert.match(parseStreamBody({ messages: [{ role: 'system', content: 'x' }] }).error, /role must be user or assistant/)
    assert.match(parseStreamBody({ messages: [{ role: 'user', content: '   ' }] }).error, /non-empty string/)
    assert.match(parseStreamBody({ messages: 'nope' }).error, /messages must be an array/)
})

test('an empty messages array falls back to userPrompt, or errors with nothing to fall back to', () => {
    assert.equal(parseStreamBody({ messages: [], userPrompt: '  ask  ' }).userPrompt, 'ask')
    assert.match(parseStreamBody({ messages: [] }).error, /non-empty array/)
    assert.match(parseStreamBody({}).error, /must include messages or userPrompt/)
})

test('userPrompt alone is a valid turn', () => {
    const out = parseStreamBody({ userPrompt: 'long NVDA' })
    assert.equal(out.userPrompt, 'long NVDA')
    assert.equal(out.messages, undefined)
})

// ── chat state ───────────────────────────────────────────────────────────────

test('chatState must be a plain object; absent and null both mean "none"', () => {
    assert.deepEqual(parseStreamBody({ userPrompt: 'x', chatState: { draft: {} } }).chatState, { draft: {} })
    assert.equal(parseStreamBody({ userPrompt: 'x' }).chatState, null)
    assert.equal(parseStreamBody({ userPrompt: 'x', chatState: null }).chatState, null)
    assert.match(parseStreamBody({ userPrompt: 'x', chatState: [] }).error, /chatState must be an object/)
    assert.match(parseStreamBody({ userPrompt: 'x', chatState: 'no' }).error, /chatState must be an object/)
})

// ── accounts ─────────────────────────────────────────────────────────────────

test('an account without an id is DROPPED, not rendered', () => {
    // The drift this replaced: Kairos kept any object, Mentor kept only those carrying an `id`.
    // Mentor was right — `_finalizeCall` filters `id != null` before it binds, so an id-less
    // account reached Kairos's prompt as a venue the desk could discuss and Generate then dropped
    // in silence. The prompt must describe exactly what Generate will bind.
    const out = parseStreamBody({
        userPrompt: 'x',
        accounts: [{ id: 'a1', broker: 'ctrader' }, { broker: 'ctrader' }, null, 'nope'],
    })
    assert.deepEqual(out.accounts, [{ id: 'a1', broker: 'ctrader' }])
})

test('mainAccountId is normalized to a string, and absent stays null', () => {
    // It arrives as a number or a string depending on the broker; every consumer compares as string.
    assert.equal(parseStreamBody({ userPrompt: 'x', mainAccountId: 12345 }).mainAccountId, '12345')
    assert.equal(parseStreamBody({ userPrompt: 'x', mainAccountId: 'a1' }).mainAccountId, 'a1')
    assert.equal(parseStreamBody({ userPrompt: 'x' }).mainAccountId, null)
})

// ── client clock ─────────────────────────────────────────────────────────────

test('parseClientTime validates each field independently', () => {
    assert.deepEqual(parseClientTime({ clientNow: 1_700_000_000_000, clientTz: 'Asia/Jerusalem' }),
        { clientNow: 1_700_000_000_000, clientTz: 'Asia/Jerusalem' })
    // A bad half is dropped, never fatal — half a clock still beats none.
    assert.deepEqual(parseClientTime({ clientNow: 'nope', clientTz: 'UTC' }), { clientTz: 'UTC' })
    assert.deepEqual(parseClientTime({ clientNow: 1_700_000_000_000, clientTz: '  ' }), { clientNow: 1_700_000_000_000 })
})

test('parseClientTime returns null when nothing usable survives', () => {
    // null is load-bearing: buildTimeSection reads it as "timezone unknown, ASK rather than guess",
    // which is what stops a scheduled entry firing on the wrong side of the world.
    assert.equal(parseClientTime({}), null)
    assert.equal(parseClientTime(null), null)
    assert.equal(parseClientTime({ clientNow: -1, clientTz: '' }), null)
    assert.equal(parseClientTime({ clientNow: 0 }), null)
})

// ── the pieces it composes ───────────────────────────────────────────────────

test('parseIdeaAccounts and parseChatMessages tolerate junk input', () => {
    assert.deepEqual(parseIdeaAccounts(null), [])
    assert.deepEqual(parseIdeaAccounts('nope'), [])
    assert.match(parseChatMessages([]).error, /non-empty array/)
    assert.match(parseChatMessages([null]).error, /must be an object with role and content/)
})
