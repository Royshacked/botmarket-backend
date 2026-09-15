// ARCHIVED with archive/services/kairosNotify.service.js — not run by `npm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCallReady, buildCallExpiry } from '../services/kairosNotify.service.js'

// ── buildCallReady ──────────────────────────────────────────────────────────
test('call ready: entry_confirm card attributed to the Kairos bot, reads userId, embeds proposal', () => {
    const call = { id: 'call_1', userId: 'u2', asset: 'AAPL', bias: 'long' }
    const c = buildCallReady(call, { proposal: { entry: 190, stop: 187 } })
    assert.equal(c.type, 'entry_confirm')
    assert.equal(c.botId, 'kairos')
    assert.equal(c.userId, 'u2')             // the envelope owner field, one name for every kind
    assert.deepEqual(c.payload, { kind: 'call', callId: 'call_1', asset: 'AAPL', direction: 'long' })
    assert.match(c.content, /ready to enter \(entry 190, stop 187\)/)
})

test('call ready: no assessment proposal → clean copy, no price bits', () => {
    const c = buildCallReady({ id: 'call_2', userId: 'u2', asset: 'AAPL' }, null)
    assert.match(c.content, /is ready to enter\. Open the call/)
    assert.doesNotMatch(c.content, /entry/)
})

test('call ready: proposal with an unresolved (null) stop → no price bits, never "stop null"', () => {
    const c = buildCallReady({ id: 'call_5', userId: 'u2', asset: 'AAPL' }, { proposal: { entry: 190, stop: null } })
    assert.match(c.content, /is ready to enter\. Open the call/)
    assert.doesNotMatch(c.content, /stop null/)
    assert.doesNotMatch(c.content, /entry 190/)
})

// ── buildCallExpiry ─────────────────────────────────────────────────────────
test('call expiry (edit): call_expiry card, kind edit, carries why', () => {
    const c = buildCallExpiry({ id: 'call_3', userId: 'u3', asset: 'TSLA' }, 'edit', 'levels drifted')
    assert.equal(c.type, 'call_expiry')
    assert.equal(c.botId, 'kairos')
    assert.deepEqual(c.payload, { callId: 'call_3', asset: 'TSLA', kind: 'edit', why: 'levels drifted' })
    assert.match(c.content, /thesis is expiring/)
})

test('call expiry (expired): terminal card offers edit/delete, null why', () => {
    const c = buildCallExpiry({ id: 'call_4', userId: 'u3', asset: 'TSLA' }, 'expired')
    assert.equal(c.payload.kind, 'expired')
    assert.equal(c.payload.why, null)
    assert.match(c.content, /thesis expired\. Edit to re-map it or delete/)
})

