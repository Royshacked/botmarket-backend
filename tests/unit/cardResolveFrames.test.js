import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { _supersedePending, resolvePortfolioReviewCard, _setDeps as _setChatDeps, CONVS, MSGS } from '../../api/chat/chat.service.js'

// The card resolve frames. Desk cards no longer mirror into the session timeline (reverted 2026-10-18 — they
// live in the social chat); these frames keep the social chat's open panels in step.

function chatDb() {
    const { db, rows } = memDb()
    const frames = []
    const restore = _setChatDeps({ getDb: async () => db, emit: (userId, event, data) => frames.push({ userId, event, data }) })
    return { db, rows, frames, restore }
}
const seedCard = (db, over) => db.collection(MSGS).insertOne({ id: 'm1', conversationId: 'conv_1', type: 'setup_invalidation', status: 'pending', subject: { kind: 'setup', id: 's1' }, createdAt: 1, ...over })

test('a superseded card tells the open panels — the timeline must not show two live asks', async () => {
    const { db, rows, frames, restore } = chatDb()
    try {
        await db.collection(CONVS).insertOne({ id: 'conv_1', participants: ['mentor', 'u1'] })
        await seedCard(db)
        await seedCard(db, { id: 'm2', type: 'setup_manage' })   // another job about the same setup — untouched
        const n = await _supersedePending('conv_1', 'setup_invalidation', { kind: 'setup', id: 's1' }, { primary: {} })
        assert.equal(n, 1)
        assert.equal(rows(MSGS).find(r => r.id === 'm1').status, 'superseded')
        assert.equal(rows(MSGS).find(r => r.id === 'm2').status, 'pending')
        assert.equal(frames.length, 1)
        assert.deepEqual({ ...frames[0], data: { ...frames[0].data, resolvedAt: 0 } }, {
            userId: 'u1', event: 'message_resolved',
            data: { id: 'm1', conversationId: 'conv_1', status: 'superseded', resolvedAt: 0, resolveOutcome: 'superseded' },
        })
    } finally { restore() }
})

test('nothing to supersede → no write, no frame', async () => {
    const { frames, restore } = chatDb()
    try {
        assert.equal(await _supersedePending('conv_1', 'setup_invalidation', { kind: 'setup', id: 's1' }, { primary: {} }), 0)
        assert.equal(frames.length, 0)
    } finally { restore() }
})

test('a finished portfolio review flips its card on screen — one timestamp, stored and sent', async () => {
    const { db, rows, frames, restore } = chatDb()
    try {
        await db.collection(CONVS).insertOne({ id: 'conv_p', participants: ['portfolio', 'u1'] })
        await seedCard(db, { id: 'r1', conversationId: 'conv_p', type: 'portfolio_review', payload: { portfolioId: 'p1' } })
        const out = await resolvePortfolioReviewCard('u1', 'p1', { outcome: 'updated', nextReviewAt: 99 })
        assert.deepEqual(out, { ok: true, messageId: 'r1' })
        const row = rows(MSGS)[0]
        assert.equal(row.status, 'done')
        assert.deepEqual(frames, [{ userId: 'u1', event: 'message_resolved',
            data: { id: 'r1', conversationId: 'conv_p', status: 'done', resolvedAt: row.resolvedAt, resolveOutcome: 'updated',
                // the review bubble's "next review <date>" reads its payload — the patch rides along (phase 7, J3)
                payloadPatch: { resolved: true, outcome: 'updated', nextReviewAt: 99 } } }])
    } finally { restore() }
})

test('resolving a card echoes message_resolved to the user’s own screens', async () => {
    const { resolveMessage } = await import('../../api/chat/chat.service.js')
    const { db, rows, frames, restore } = chatDb()
    try {
        await db.collection(CONVS).insertOne({ id: 'conv_1', participants: ['mentor', 'u1'] })
        await seedCard(db)
        await resolveMessage('conv_1', 'm1', 'u1', { status: 'dismissed', outcome: 'later' })
        assert.equal(rows(MSGS)[0].status, 'dismissed')
        const echo = frames.find(f => f.event === 'message_resolved')
        assert.deepEqual({ ...echo, data: { ...echo.data, resolvedAt: 0 } }, {
            userId: 'u1', event: 'message_resolved',
            data: { id: 'm1', conversationId: 'conv_1', status: 'dismissed', resolvedAt: 0, resolveOutcome: 'later' },
        })
    } finally { restore() }
})
