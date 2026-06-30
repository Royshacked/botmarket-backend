import { getDb }   from '../../providers/mongodb.provider.js'
import { logger }  from '../../services/logger.service.js'

const LOG        = '[portfolioChat]'
const COLLECTION = 'portfolio_chats'

const CADENCE_MS = { weekly: 7 * 86400000, monthly: 30 * 86400000, quarterly: 90 * 86400000 }

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
    getThesis,
    setThesis,
    completeReview,
}

async function saveChatState(portfolioId, messages, userId, mandate = null) {
    try {
        const db = await getDb()
        const setFields = { portfolioId, messages, userId, savedAt: Date.now() }
        if (mandate && typeof mandate === 'object') setFields.mandate = mandate
        await db.collection(COLLECTION).findOneAndUpdate(
            { portfolioId, userId },
            {
                $set: setFields,
                // Lifecycle defaults — only written when the doc is first created.
                $setOnInsert: {
                    reviewCadence: 'weekly',
                    nextReviewAt:  Date.now() + CADENCE_MS.weekly,
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
            reviewCadence: d.reviewCadence ?? 'weekly',
            nextReviewAt:  d.nextReviewAt,
            lastReviewAt:  d.lastReviewAt ?? null,
            notifiedAt:    d.notifiedAt   ?? null,
        }))
    } catch (err) {
        logger.error(LOG, 'Failed to get pending reviews', err)
        return []
    }
}

// ─── Portfolio thesis ─────────────────────────────────────────────────────────
// The explicit portfolio-level intent the weekly review validates drift against:
// strategy rationale + target exposures. Mandate stays its own field; the thesis
// is the strategy layer on top of it. Versioned so we can enforce validate-weekly
// / rewrite-only-on-deliberate-change (never auto-synced to drift).

async function getThesis(portfolioId, userId) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne(
            { portfolioId, userId },
            { projection: { thesis: 1 } }
        )
        return doc?.thesis ?? null
    } catch (err) {
        logger.error(LOG, 'Failed to get thesis', err)
        return null
    }
}

// reason: 'construction' | 'mandate-edit' | 'accepted-rebalance'. Bumps version and
// stamps updatedAt/updatedReason; preserves prior fields when a partial patch is given.
async function setThesis(portfolioId, userId, thesis, reason = 'construction') {
    try {
        const db   = await getDb()
        const prev = await db.collection(COLLECTION).findOne(
            { portfolioId, userId },
            { projection: { thesis: 1 } }
        )
        const next = {
            strategy:        typeof thesis?.strategy === 'string' ? thesis.strategy : (prev?.thesis?.strategy ?? null),
            targetExposures: Array.isArray(thesis?.targetExposures) ? thesis.targetExposures : (prev?.thesis?.targetExposures ?? []),
            version:         ((prev?.thesis?.version) ?? 0) + 1,
            updatedAt:       Date.now(),
            updatedReason:   reason,
        }
        await db.collection(COLLECTION).updateOne(
            { portfolioId, userId },
            { $set: { thesis: next } },
            { upsert: true }
        )
        logger.info(LOG, 'Thesis updated', { portfolioId, version: next.version, reason })
        return { ok: true, thesis: next }
    } catch (err) {
        logger.error(LOG, 'Failed to set thesis', err)
        return { ok: false }
    }
}

// Bump the schedule forward after a review is completed/dismissed: stamp lastReviewAt,
// advance nextReviewAt by the cadence, and clear notifiedAt so the next cycle can notify.
async function completeReview(portfolioId, userId) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne(
            { portfolioId, userId },
            { projection: { reviewCadence: 1 } }
        )
        const cadence = doc?.reviewCadence ?? 'weekly'
        const now     = Date.now()
        const next    = now + (CADENCE_MS[cadence] ?? CADENCE_MS.weekly)
        await db.collection(COLLECTION).updateOne(
            { portfolioId, userId },
            { $set: { lastReviewAt: now, nextReviewAt: next, notifiedAt: null } }
        )
        logger.info(LOG, 'Review completed', { portfolioId, nextReviewAt: next })
        return { ok: true, nextReviewAt: next }
    } catch (err) {
        logger.error(LOG, 'Failed to complete review', err)
        return { ok: false }
    }
}
