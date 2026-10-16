import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseDeskTurn, parseClientTime, parseIdeaAccounts, parseChatMessages } from '../../api/_shared/parse.util.js'

// THE desk-turn body parser — one for every streaming desk (makeDeskStream). Three parse styles
// used to live in the controllers; these lock the ONE behaviour they all answer with now.

const msgs = (...contents) => contents.map((content, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant', content,
}))
const turn = (extra = {}) => parseDeskTurn({ messages: msgs('hi'), ...extra })

// ── the conversation ─────────────────────────────────────────────────────────

test('a valid conversation passes through validated and UNCAPPED', () => {
    // The cap is the agent's (normalizeMessages → trimHistory, which trims on a high-water mark so
    // the cached prompt prefix stays byte-stable). A slice() here would be the per-turn sliding
    // window that design exists to avoid, so the parser must hand over every turn it was given.
    const twenty = msgs(...Array.from({ length: 20 }, (_, i) => `turn ${i}`))
    const out = parseDeskTurn({ messages: twenty })
    assert.equal(out.error, undefined)
    assert.equal(out.messages.length, 20)
    assert.equal(out.messages[0].content, 'turn 0')
})

test('content is trimmed and the roles are validated', () => {
    const out = parseDeskTurn({ messages: [{ role: 'user', content: '  hi  ' }] })
    assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }])

    assert.match(parseDeskTurn({ messages: [{ role: 'system', content: 'x' }] }).error, /role must be user or assistant/)
    assert.match(parseDeskTurn({ messages: [{ role: 'user', content: '   ' }] }).error, /non-empty string/)
    assert.match(parseDeskTurn({ messages: 'nope' }).error, /messages must be an array/)
})

// There is no second "prompt" field any more: a headless run opens a desk with openingTurn(text) as
// its messages, and every client sends the whole history.
test('the conversation is required — an empty, absent or prompt-only body is a 400', () => {
    assert.match(parseDeskTurn({ messages: [] }).error, /non-empty array/)
    assert.match(parseDeskTurn({}).error, /must be an array/)
    assert.match(parseDeskTurn(undefined).error, /must be an array/)
    assert.match(parseDeskTurn({ userPrompt: 'long NVDA' }).error, /must be an array/)
})

// ── chat state ───────────────────────────────────────────────────────────────

test('chatState must be a plain object; absent and null both mean "none"', () => {
    assert.deepEqual(turn({ chatState: { draft: {} } }).chatState, { draft: {} })
    assert.equal(turn().chatState, null)
    assert.equal(turn({ chatState: null }).chatState, null)
    assert.match(turn({ chatState: [] }).error, /chatState must be an object/)
    assert.match(turn({ chatState: 'no' }).error, /chatState must be an object/)
})

// ── accounts ─────────────────────────────────────────────────────────────────

test('an account without an id is DROPPED, not rendered', () => {
    // An id-less account would reach the prompt as a venue the desk could discuss and then be
    // dropped in silence when it binds. The prompt must describe exactly what will bind.
    const out = turn({ accounts: [{ id: 'a1', broker: 'ctrader' }, { broker: 'ctrader' }, null, 'nope'] })
    assert.deepEqual(out.accounts, [{ id: 'a1', broker: 'ctrader' }])
})

test('mainAccountId is normalized to a string, and absent stays null', () => {
    // It arrives as a number or a string depending on the broker; every consumer compares as string.
    assert.equal(turn({ mainAccountId: 12345 }).mainAccountId, '12345')
    assert.equal(turn({ mainAccountId: 'a1' }).mainAccountId, 'a1')
    assert.equal(turn().mainAccountId, null)
})

// ── model ────────────────────────────────────────────────────────────────────

test('the model is a non-empty string or undefined — the agent resolves the default', () => {
    assert.equal(turn({ model: 'claude-sonnet-5' }).model, 'claude-sonnet-5')
    assert.equal(turn().model, undefined)
    assert.equal(turn({ model: '' }).model, undefined)
    assert.equal(turn({ model: { evil: true } }).model, undefined)
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
