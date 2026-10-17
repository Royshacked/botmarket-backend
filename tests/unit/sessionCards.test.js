import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { agentOfBot, cardAction, mirrorCard } from '../../services/sessionCards.js'
import { onCardPosted, _notifyCardPosted } from '../../api/chat/chat.service.js'

// Background desk cards in the live session (plan phase 6): a REFERENCE row per card, in the agent's
// scope, only in a session the user already has, with the one table of what its button does.

const card = (over = {}) => ({ id: 'msg_1', conversationId: 'conv_1', type: 'entry_confirm', content: 'NVDA hit your entry', payload: { setupId: 's1' }, actions: {}, subject: { kind: 'setup', id: 's1' }, ...over })
const tick = () => new Promise(r => setImmediate(r))

test('a card speaks for its desk; retired and unknown bots read as Axl', () => {
    for (const b of ['axl', 'mentor', 'portfolio', 'analyst', 'strategy']) assert.equal(agentOfBot(b), b)
    assert.equal(agentOfBot('kairos'), 'axl')
    assert.equal(agentOfBot('idea'), 'axl')
    assert.equal(agentOfBot(undefined), 'axl')
})

test('the one action table: dialogs, edits, the brief, forms, navigation, nothing', () => {
    assert.deepEqual(cardAction(card()), { type: 'dialog', event: 'SETUP_CONFIRM_OPEN', ids: { setupId: 's1' } })
    assert.deepEqual(cardAction(card({ payload: { ideaId: 'i1' } })), { type: 'dialog', event: 'ENTRY_CONFIRM_OPEN', ids: { ideaId: 'i1' } })
    assert.deepEqual(cardAction(card({ payload: { callId: 'c1' } })), { type: 'none' })
    assert.deepEqual(cardAction(card({ type: 'setup_invalidation' })), { type: 'edit', kind: 'setup', id: 's1' })
    assert.deepEqual(cardAction(card({ type: 'setup_invalidation', actions: null })), { type: 'none' })
    assert.deepEqual(cardAction(card({ type: 'setup_manage', payload: { setupId: 's1', verdict: 'trail' } })), { type: 'popup', kind: 'setup', id: 's1' })
    assert.deepEqual(cardAction(card({ type: 'setup_manage', payload: { setupId: 's1', verdict: 'add_leg' } })).event, 'SETUP_CONFIRM_OPEN')
    assert.deepEqual(cardAction(card({ type: 'coverage_event', payload: { coverageId: 'cov1' } })), { type: 'edit', kind: 'coverage', id: 'cov1' })
    assert.deepEqual(cardAction(card({ type: 'coverage_refreshed', payload: { portfolioId: 'p1', coverageId: 'cov1' } })), { type: 'edit', kind: 'portfolio', id: 'p1', reviewMode: true })
    assert.deepEqual(cardAction(card({ type: 'portfolio_review', payload: { portfolioId: 'p1' } })), { type: 'edit', kind: 'portfolio', id: 'p1', reviewMode: true })
    assert.deepEqual(cardAction(card({ type: 'market_brief_offer', payload: { day: '2026-10-17' } })), { type: 'brief', day: '2026-10-17' })
    assert.deepEqual(cardAction(card({ type: 'manual_entry' })), { type: 'form' })
    assert.deepEqual(cardAction(card({ type: 'queue_ready' })), { type: 'dialog', event: 'OPEN_QUEUED_LIST', ids: {} })
    assert.deepEqual(cardAction(card({ type: 'industry_view' })), { type: 'navigate', to: 'forecasts' })
    assert.deepEqual(cardAction(card({ type: 'limit_disarmed' })), { type: 'none' })
})

function store() {
    const { db, rows } = memDb()
    return { s: makeSessionService({ getDb: async () => db }), rows }
}

test('a card lands in the user’s live session as a REFERENCE — msgId, conversation, subject, action', async () => {
    const { s } = store()
    const sess = await s.getActive({ userId: 'u1' })
    await mirrorCard({ userId: 'u1', botId: 'mentor', msg: card() }, s)
    const [row] = await s.messagesSince({ sessionId: sess.sessionId, userId: 'u1' })
    assert.equal(row.kind, 'card')
    assert.equal(row.agent, 'mentor')
    assert.equal(row.content, 'NVDA hit your entry')
    assert.deepEqual(row.ref, { msgId: 'msg_1', conversationId: 'conv_1', type: 'entry_confirm', subject: { kind: 'setup', id: 's1' }, action: { type: 'dialog', event: 'SETUP_CONFIRM_OPEN', ids: { setupId: 's1' } } })
})

test('no live session → nothing appended, and no session is created for a card', async () => {
    const { s, rows } = store()
    assert.equal(await mirrorCard({ userId: 'u1', botId: 'mentor', msg: card() }, s), null)
    assert.equal(rows('sessions').length, 0)
    assert.equal(rows('session_messages').length, 0)
})

test('Pythia’s cards land in the admin’s strategy session, not the main chat', async () => {
    const { s } = store()
    const main = await s.getActive({ userId: 'a1' })
    const pyth = await s.getActive({ userId: 'a1', scope: 'strategy' })
    await mirrorCard({ userId: 'a1', botId: 'strategy', msg: card({ type: 'industry_view', payload: {} }) }, s)
    assert.equal((await s.messagesSince({ sessionId: main.sessionId, userId: 'a1' })).length, 0)
    assert.equal((await s.messagesSince({ sessionId: pyth.sessionId, userId: 'a1' }))[0].agent, 'strategy')
})

test('the post path calls the hook for a CARD only — never for a plain bot line — and a throw never escapes', async () => {
    const seen = []
    onCardPosted((args) => { seen.push(args.msg.type); if (args.msg.type === 'boom') throw new Error('mirror down') })
    try {
        _notifyCardPosted({ userId: 'u1', botId: 'axl', msg: card({ type: 'text' }) })
        _notifyCardPosted({ userId: 'u1', botId: 'mentor', msg: card() })
        _notifyCardPosted({ userId: 'u1', botId: 'mentor', msg: card({ type: 'boom' }) })
        await tick(); await tick()
        assert.deepEqual(seen, ['entry_confirm', 'boom'])
    } finally { onCardPosted(null) }
})
