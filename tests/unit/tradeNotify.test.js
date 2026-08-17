import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIdeaEntryConfirm, buildCallReady, buildCallExpiry, buildQueueReady } from '../../services/tradeNotify.service.js'
import { cardSubject } from '../../api/chat/chat.service.js'

// ── buildIdeaEntryConfirm ───────────────────────────────────────────────────
test('idea entry-confirm: a lone idea has no living desk, so the card comes from Axl', () => {
    const idea = { id: 'idea_1', userId: 'u1', asset: 'NQ', direction: 'long' }
    const c = buildIdeaEntryConfirm(idea)
    assert.equal(c.type, 'entry_confirm')
    assert.equal(c.botId, 'axl', 'the Idea bot is retired — its cards must not vanish into a dead feed')
    assert.equal(c.userId, 'u1')
    assert.deepEqual(c.payload, { kind: 'idea', ideaId: 'idea_1', asset: 'NQ', direction: 'long', note: null })
    assert.match(c.content, /Entry triggered — LONG NQ/)
})

test('idea entry-confirm: a HOLDING rides the same builder but speaks as Atlas', () => {
    // The market-open sweep sends both kinds through this one builder, so the sender has to be
    // derived from the doc — a portfolio leg announcing itself as a lone idea is a misattribution.
    const held = { id: 'h1', userId: 'u1', asset: 'AAPL', direction: 'long', portfolioId: 'p1' }
    const c = buildIdeaEntryConfirm(held)
    assert.equal(c.botId, 'portfolio')
    assert.equal(c.payload.kind, 'portfolio_item', 'the tag on the card follows the sender')

    // An explicit kind wins over the portfolioId derivation (post-migration docs carry it).
    assert.equal(buildIdeaEntryConfirm({ ...held, kind: 'portfolio_item' }).botId, 'portfolio')
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

// ── buildQueueReady (the market-open nudge) ──────────────────────────────────
// ONE card per user for the whole open, from Axl, pointing at the list. It replaces the per-desk
// batch card, which answered "what does this desk have for you" — a question nobody asks. It is
// the one card deliberately not sent by the authoring desk, and it stays legitimate only by
// remaining a POINTER: a count and a route, never a summary of another desk's judgment.

test('queue ready: a count, the names, and a route to the list', () => {
    const c = buildQueueReady({ userId: 'u1', count: 3, assets: ['AAPL', 'MSFT', 'MU'] })
    assert.equal(c.type, 'queue_ready')
    assert.equal(c.botId, 'axl', 'the QUEUE is Axl\'s, even though the items in it are other desks\'')
    assert.equal(c.userId, 'u1')
    assert.equal(c.payload.count, 3)
    assert.deepEqual(c.payload.assets, ['AAPL', 'MSFT', 'MU'])
    assert.equal(c.actions.primary.label, 'Open the list')
    assert.match(c.content, /The market is open — 3 items/)
    assert.match(c.content, /waiting on you/)
})

test('queue ready: opening the list COMPLETES the card — the pointer exception', () => {
    // Every other card survives being opened, because its ask outlives the look. This one has no
    // subject to be resolved BY (it is about a batch, not an entity), so on the 'work' default no
    // write could ever close it and it would nag forever with a count that is stale the moment the
    // first item is executed. Seeing the list — which is always current — is the whole ask.
    const c = buildQueueReady({ userId: 'u1', count: 2, assets: ['MU', 'AAPL'] })
    assert.equal(c.actions.primary.resolvesOn, 'open')
    assert.equal(cardSubject(c.payload), null, 'a batch card has no entity, so resolveCardsFor can never reach it')
})

test('queue ready: it points, it does not describe', () => {
    // The guard against this quietly becoming the notification router that was abandoned: no verb,
    // no desk, no thesis — the list says what each item is.
    const c = buildQueueReady({ userId: 'u1', count: 2, assets: ['MU', 'AAPL'] })
    assert.doesNotMatch(c.content, /trim|exit|scale|Atlas|review/i)
})

test('queue ready: one item reads as one item', () => {
    const c = buildQueueReady({ userId: 'u1', count: 1, assets: ['MU'] })
    assert.match(c.content, /1 item — MU is waiting on you/)
    assert.match(c.content, /execute it/)
})

test('queue ready: a short list is named, a long one is only counted', () => {
    const few = buildQueueReady({ userId: 'u1', count: 2, assets: ['AAPL', 'MSFT'] })
    assert.match(few.content, /— AAPL, MSFT/)

    // Past four, the count IS the information. (The lead-in carries its own em-dash, so this
    // asserts the absence of the NAMES rather than of the punctuation.)
    const many = buildQueueReady({ userId: 'u1', count: 5, assets: ['A', 'B', 'C', 'D', 'E'] })
    assert.match(many.content, /open — 5 items are waiting/)
    assert.doesNotMatch(many.content, /A, B, C/)
})

test('queue ready: a stale decision says so; a fresh one stays quiet', () => {
    const stale = buildQueueReady({ userId: 'u1', count: 1, assets: ['MU'], staleHours: 62 })
    assert.equal(stale.payload.staleHours, 62)
    assert.match(stale.content, /decided 62h ago, before the close/)

    const fresh = buildQueueReady({ userId: 'u1', count: 1, assets: ['MU'], staleHours: 2 })
    assert.doesNotMatch(fresh.content, /decided/, 'a same-session decision\'s age says nothing')

    const unknown = buildQueueReady({ userId: 'u1', count: 1, assets: ['MU'] })
    assert.equal(unknown.payload.staleHours, null)
})

test('queue ready: a nonsense count degrades to a coherent card, not a crash', () => {
    const c = buildQueueReady({ userId: 'u1', count: undefined, assets: [] })
    assert.equal(c.payload.count, 0)
    assert.deepEqual(c.payload.assets, [])
    assert.match(c.content, /0 items/)
})
