import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { postBotCard, getMessages, resolvePortfolioReviewCard, _setDeps as _setChatDeps, CONVS, MSGS } from '../../api/chat/chat.service.js'

// ONE AXL in the social chat (docs/design/one-axl.md D8, 2026-11-13): every card lands in the user's one thread with Axl;
// the sender stays the role's bot, so the client writes the role under Axl's name and admin-only roles stay admin-only.

function chatDb() {
    const { db, rows } = memDb()
    const restore = _setChatDeps({ getDb: async () => db, emit: () => {} })
    return { db, rows, restore }
}

test('every role\'s card lands in the ONE Axl thread, sent by the role', async () => {
    const { rows, restore } = chatDb()
    try {
        await postBotCard({ userId: 'u1', content: 'Your NVDA setup armed.', botId: 'mentor' })
        await postBotCard({ userId: 'u1', content: 'Review due.', botId: 'portfolio' })
        await postBotCard({ userId: 'u1', content: 'Hello.' })
        const convs = rows(CONVS)
        assert.equal(convs.length, 1, 'one thread, not one per role')
        assert.deepEqual(convs[0].participants, ['axl', 'u1'])
        assert.deepEqual(rows(MSGS).map(m => [m.conversationId, m.senderId]), [[convs[0].id, 'mentor'], [convs[0].id, 'portfolio'], [convs[0].id, 'axl']])
    } finally { restore() }
})

test('an admin-only role\'s cards in Axl\'s thread are an admin\'s alone — a trader (or a demoted admin) never reads them', async () => {
    const { rows, restore } = chatDb()
    try {
        await postBotCard({ userId: 'u1', content: 'Revised NVDA.', botId: 'analyst' })
        await postBotCard({ userId: 'u1', content: 'Setup armed.', botId: 'mentor' })
        const conv = rows(CONVS)[0].id
        assert.deepEqual((await getMessages(conv, 'u1', null, 50, 'trader')).map(m => m.senderId), ['mentor'])
        // Two cards posted in one millisecond have no order between them — compare what is there, not its order.
        assert.deepEqual((await getMessages(conv, 'u1', null, 50, 'admin')).map(m => m.senderId).sort(), ['analyst', 'mentor'])
        assert.equal((await getMessages(conv, 'u1', null, 50)).length, 2, 'no role given (an internal read) → unfiltered, as before')
    } finally { restore() }
})

test('a portfolio review card is found in the Axl thread — and still in an old portfolio thread not yet merged', async () => {
    const { db, rows, restore } = chatDb()
    try {
        await db.collection(CONVS).insertOne({ id: 'conv_axl', participants: ['axl', 'u1'] })
        await db.collection(MSGS).insertOne({ id: 'r1', conversationId: 'conv_axl', senderId: 'portfolio', type: 'portfolio_review', status: 'pending', payload: { portfolioId: 'p1' }, createdAt: 2 })
        assert.deepEqual(await resolvePortfolioReviewCard('u1', 'p1', { outcome: 'updated' }), { ok: true, messageId: 'r1' })
        assert.equal(rows(MSGS)[0].status, 'done')
        await db.collection(CONVS).insertOne({ id: 'conv_old', participants: ['portfolio', 'u2'] })
        await db.collection(MSGS).insertOne({ id: 'r2', conversationId: 'conv_old', senderId: 'portfolio', type: 'portfolio_review', status: 'pending', payload: { portfolioId: 'p2' }, createdAt: 1 })
        assert.deepEqual(await resolvePortfolioReviewCard('u2', 'p2'), { ok: true, messageId: 'r2' })
    } finally { restore() }
})
