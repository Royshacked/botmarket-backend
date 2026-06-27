import { getDb }   from '../../providers/mongodb.provider.js'
import { logger }  from '../../services/logger.service.js'

const LOG        = '[portfolioChat]'
const COLLECTION = 'portfolio_chats'

const CADENCE_MS = { monthly: 30 * 86400000, quarterly: 90 * 86400000 }

export const portfolioChatService = {
    saveChatState,
    getChatState,
    deleteChatState,
    getPortfolioLifecycle,
    setPortfolioLifecycle,
    addReviewHistoryEntry,
    getPendingReviews,
    getMandate,
    setMandate,
}

async function saveChatState(portfolioId, messages, userId) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).findOneAndUpdate(
            { portfolioId, userId },
            {
                $set: { portfolioId, messages, userId, savedAt: Date.now() },
                // Lifecycle defaults — only written when the doc is first created.
                $setOnInsert: {
                    reviewCadence: 'monthly',
                    nextReviewAt:  Date.now() + CADENCE_MS.monthly,
                    lastReviewAt:  null,
                    reviewHistory: [],
                },
            },
            { upsert: true }
        )
        logger.info(LOG, 'Chat state saved', { portfolioId })
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to save chat state', err)
        return { ok: false }
    }
}

async function deleteChatState(portfolioId, userId) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).deleteOne({ portfolioId, userId })
        logger.info(LOG, 'Chat state deleted', { portfolioId })
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to delete chat state', err)
        return { ok: false }
    }
}

async function getChatState(portfolioId, userId) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne({ portfolioId, userId })
        if (!doc) return null
        const { _id, ...rest } = doc
        return rest
    } catch (err) {
        logger.error(LOG, 'Failed to get chat state', err)
        return null
    }
}

async function getPortfolioLifecycle(portfolioId, userId) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne(
            { portfolioId, userId },
            { projection: { reviewCadence: 1, nextReviewAt: 1, lastReviewAt: 1, reviewHistory: 1 } }
        )
        if (!doc) return null
        return {
            reviewCadence: doc.reviewCadence ?? 'monthly',
            nextReviewAt:  doc.nextReviewAt  ?? null,
            lastReviewAt:  doc.lastReviewAt  ?? null,
            reviewHistory: doc.reviewHistory ?? [],
        }
    } catch (err) {
        logger.error(LOG, 'Failed to get portfolio lifecycle', err)
        return null
    }
}

async function setPortfolioLifecycle(portfolioId, userId, patch) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).updateOne(
            { portfolioId, userId },
            { $set: patch },
            { upsert: true }
        )
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to set portfolio lifecycle', err)
        return { ok: false }
    }
}

async function addReviewHistoryEntry(portfolioId, userId, entry) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).updateOne(
            { portfolioId, userId },
            { $push: { reviewHistory: { $each: [entry], $slice: -50 } } }
        )
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to add review history entry', err)
        return { ok: false }
    }
}

async function getMandate(portfolioId, userId) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne(
            { portfolioId, userId },
            { projection: { mandate: 1 } }
        )
        return doc?.mandate ?? null
    } catch (err) {
        logger.error(LOG, 'Failed to get mandate', err)
        return null
    }
}

async function setMandate(portfolioId, userId, mandate) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).updateOne(
            { portfolioId, userId },
            { $set: { mandate } }
        )
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to set mandate', err)
        return { ok: false }
    }
}

/**
 * Returns portfolios due for review (nextReviewAt <= now), with portfolioName
 * resolved from the ideas collection.
 */
async function getPendingReviews(userId) {
    try {
        const db    = await getDb()
        const query = userId
            ? { userId, nextReviewAt: { $lte: Date.now() } }
            : { nextReviewAt: { $lte: Date.now() } }
        const docs = await db.collection(COLLECTION)
            .find(query)
            .project({ portfolioId: 1, userId: 1, reviewCadence: 1, nextReviewAt: 1, lastReviewAt: 1, notifiedAt: 1 })
            .toArray()

        if (!docs.length) return []

        const portfolioIds = docs.map(d => d.portfolioId)
        const nameRows = await db.collection('ideas')
            .aggregate([
                { $match: { portfolioId: { $in: portfolioIds }, userId } },
                { $group: { _id: '$portfolioId', portfolioName: { $first: '$portfolioName' } } },
            ])
            .toArray()

        const nameMap = Object.fromEntries(nameRows.map(r => [r._id, r.portfolioName ?? 'Portfolio']))

        return docs.map(d => ({
            portfolioId:   d.portfolioId,
            userId:        d.userId,
            portfolioName: nameMap[d.portfolioId] ?? 'Portfolio',
            reviewCadence: d.reviewCadence ?? 'monthly',
            nextReviewAt:  d.nextReviewAt,
            lastReviewAt:  d.lastReviewAt ?? null,
            notifiedAt:    d.notifiedAt   ?? null,
        }))
    } catch (err) {
        logger.error(LOG, 'Failed to get pending reviews', err)
        return []
    }
}
