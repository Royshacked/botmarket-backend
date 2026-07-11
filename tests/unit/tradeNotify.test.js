import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIdeaEntryConfirm, buildCallReady, buildCallExpiry } from '../../services/tradeNotify.service.js'

// ── buildIdeaEntryConfirm ───────────────────────────────────────────────────
test('idea entry-confirm: entry_confirm card attributed to the Idea bot with ideaId', () => {
    const idea = { id: 'idea_1', userId: 'u1', asset: 'NQ', direction: 'long' }
    const c = buildIdeaEntryConfirm(idea)
    assert.equal(c.type, 'entry_confirm')
    assert.equal(c.botId, 'idea')
    assert.equal(c.userId, 'u1')
    assert.deepEqual(c.payload, { kind: 'idea', ideaId: 'idea_1', asset: 'NQ', direction: 'long' })
    assert.match(c.content, /Entry triggered — LONG NQ/)
})

test('idea entry-confirm: no userId → wrapper would no-op (builder still yields null userId)', () => {
    const c = buildIdeaEntryConfirm({ id: 'idea_2', asset: 'ES', direction: 'short' })
    assert.equal(c.userId, null)   // _post short-circuits on a null userId
})

// ── buildCallReady ──────────────────────────────────────────────────────────
test('call ready: entry_confirm card attributed to the Kairos bot, reads user_id, embeds proposal', () => {
    const call = { id: 'call_1', user_id: 'u2', asset: 'AAPL', bias: 'long' }
    const c = buildCallReady(call, { proposal: { entry: 190, stop: 187 } })
    assert.equal(c.type, 'entry_confirm')
    assert.equal(c.botId, 'kairos')
    assert.equal(c.userId, 'u2')             // sourced from call.user_id, not userId
    assert.deepEqual(c.payload, { kind: 'call', callId: 'call_1', asset: 'AAPL', direction: 'long' })
    assert.match(c.content, /ready to enter \(entry 190, stop 187\)/)
})

test('call ready: no assessment proposal → clean copy, no price bits', () => {
    const c = buildCallReady({ id: 'call_2', user_id: 'u2', asset: 'AAPL' }, null)
    assert.match(c.content, /is ready to enter\. Open the call/)
    assert.doesNotMatch(c.content, /entry/)
})

test('call ready: proposal with an unresolved (null) stop → no price bits, never "stop null"', () => {
    const c = buildCallReady({ id: 'call_5', user_id: 'u2', asset: 'AAPL' }, { proposal: { entry: 190, stop: null } })
    assert.match(c.content, /is ready to enter\. Open the call/)
    assert.doesNotMatch(c.content, /stop null/)
    assert.doesNotMatch(c.content, /entry 190/)
})

// ── buildCallExpiry ─────────────────────────────────────────────────────────
test('call expiry (edit): call_expiry card, kind edit, carries why', () => {
    const c = buildCallExpiry({ id: 'call_3', user_id: 'u3', asset: 'TSLA' }, 'edit', 'levels drifted')
    assert.equal(c.type, 'call_expiry')
    assert.equal(c.botId, 'kairos')
    assert.deepEqual(c.payload, { callId: 'call_3', asset: 'TSLA', kind: 'edit', why: 'levels drifted' })
    assert.match(c.content, /thesis is expiring/)
})

test('call expiry (expired): terminal card offers edit/delete, null why', () => {
    const c = buildCallExpiry({ id: 'call_4', user_id: 'u3', asset: 'TSLA' }, 'expired')
    assert.equal(c.payload.kind, 'expired')
    assert.equal(c.payload.why, null)
    assert.match(c.content, /thesis expired\. Edit to re-map it or delete/)
})
