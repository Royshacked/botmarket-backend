import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIdeaEntryConfirm, buildCallReady, buildCallExpiry, buildOrdersReady } from '../../services/tradeNotify.service.js'

// ── buildIdeaEntryConfirm ───────────────────────────────────────────────────
test('idea entry-confirm: entry_confirm card attributed to the Idea bot with ideaId', () => {
    const idea = { id: 'idea_1', userId: 'u1', asset: 'NQ', direction: 'long' }
    const c = buildIdeaEntryConfirm(idea)
    assert.equal(c.type, 'entry_confirm')
    assert.equal(c.botId, 'idea')
    assert.equal(c.userId, 'u1')
    assert.deepEqual(c.payload, { kind: 'idea', ideaId: 'idea_1', asset: 'NQ', direction: 'long', note: null })
    assert.match(c.content, /Entry triggered — LONG NQ/)
})

test('idea entry-confirm: note marks WHY it surfaced (payload + lead-in copy)', () => {
    const idea = { id: 'idea_9', userId: 'u1', asset: 'NQ', direction: 'long' }

    const passed = buildIdeaEntryConfirm(idea, 'passed_earlier')
    assert.equal(passed.payload.note, 'passed_earlier')
    assert.match(passed.content, /Scheduled time already passed — LONG NQ/)
    assert.match(passed.content, /Confirm to place your order\./)

    const offHours = buildIdeaEntryConfirm(idea, 'off_hours')
    assert.equal(offHours.payload.note, 'off_hours')
    assert.match(offHours.content, /market was closed/)

    // An unknown note falls back to the normal lead-in and passes through as-is.
    const weird = buildIdeaEntryConfirm(idea, 'whatever')
    assert.match(weird.content, /Entry triggered — LONG NQ/)
    assert.equal(weird.payload.note, 'whatever')
})

test('idea entry-confirm: no userId → wrapper would no-op (builder still yields null userId)', () => {
    const c = buildIdeaEntryConfirm({ id: 'idea_2', asset: 'ES', direction: 'short' })
    assert.equal(c.userId, null)   // _post short-circuits on a null userId
})

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

// ── buildOrdersReady (the market-open batch card) ────────────────────────────
// One card for a batch that came off the bench at once, instead of N. The confirm dialog already
// walks pending orders one at a time, so the card only has to open the queue.

const order = (id, asset, builtAgoH = 1) => ({
    id, userId: 'u1', kind: 'idea', asset,
    pendingOrder: { builtAt: Date.now() - builtAgoH * 3_600_000 },
})

test('orders ready: one card carrying the count, the assets and the queue entry point', () => {
    const c = buildOrdersReady({
        userId: 'u1', kind: 'idea', botId: 'idea',
        entities: [order('a', 'AAPL'), order('b', 'MSFT'), order('c', 'NVDA')],
    })
    assert.equal(c.type, 'orders_ready')
    assert.equal(c.botId, 'idea')
    assert.equal(c.userId, 'u1')
    assert.equal(c.payload.count, 3)
    assert.equal(c.payload.firstId, 'a', 'the dialog opens on the first order and walks the rest')
    assert.deepEqual(c.payload.assets, ['AAPL', 'MSFT', 'NVDA'])
    assert.equal(c.actions.primary.label, 'Review orders')
    assert.match(c.content, /The market is open — 3 orders/)
    assert.match(c.content, /one at a time/)
})

test('orders ready: a short list is named, a long one is only counted', () => {
    const few  = buildOrdersReady({ kind: 'idea', botId: 'idea', entities: [order('a', 'AAPL'), order('b', 'MSFT')] })
    assert.match(few.content, /\(AAPL, MSFT\)/)

    const many = buildOrdersReady({
        kind: 'idea', botId: 'idea',
        entities: ['A', 'B', 'C', 'D', 'E'].map((s, i) => order(String(i), s)),
    })
    assert.doesNotMatch(many.content, /\(/, 'past four names the count is the information')
    assert.match(many.content, /5 orders/)
})

test('orders ready: duplicate assets are named once', () => {
    // Two legs of a forked multi-broker order are the same NAME to a reader, not two positions.
    const c = buildOrdersReady({ kind: 'idea', botId: 'idea', entities: [order('a', 'AAPL'), order('b', 'AAPL')] })
    assert.deepEqual(c.payload.assets, ['AAPL'])
    assert.equal(c.payload.count, 2, 'the COUNT is still the number of orders')
})

test('orders ready: a stale batch says so; a fresh one stays quiet', () => {
    const stale = buildOrdersReady({ kind: 'idea', botId: 'idea', entities: [order('a', 'AAPL')], staleHours: 62 })
    assert.equal(stale.payload.staleHours, 62)
    assert.match(stale.content, /priced 62h ago, before the close/)

    const fresh = buildOrdersReady({ kind: 'idea', botId: 'idea', entities: [order('a', 'AAPL')], staleHours: 2 })
    assert.doesNotMatch(fresh.content, /priced/, 'a same-session plan\'s age says nothing')

    const unknown = buildOrdersReady({ kind: 'idea', botId: 'idea', entities: [order('a', 'AAPL')] })
    assert.equal(unknown.payload.staleHours, null)
    assert.doesNotMatch(unknown.content, /priced/)
})

test('orders ready: the batch belongs to the desk that authored it, never to a router', () => {
    const c = buildOrdersReady({
        userId: 'u1', kind: 'setup', botId: 'mentor',
        entities: [order('s1', 'TSLA'), order('s2', 'NVDA')],
    })
    assert.equal(c.botId, 'mentor', 'a setup batch comes from Mentor, not a cross-kind bot')
    assert.equal(c.payload.kind, 'setup')
})

test('orders ready: an empty batch degrades to a coherent card, not a crash', () => {
    const c = buildOrdersReady({ kind: 'idea', botId: 'idea', entities: [] })
    assert.equal(c.payload.count, 0)
    assert.equal(c.payload.firstId, null)
    assert.deepEqual(c.payload.assets, [])
})
