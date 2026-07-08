import { getDb, stripId }   from '../../providers/mongodb.provider.js'
import { logger }  from '../../services/logger.service.js'
import { paperBrokerService } from '../broker/paperBroker.service.js'

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
        return stripId(doc)
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
        // One representative idea per portfolio carries the display name plus the
        // broker/account the whole batch was saved under. Paper/live/manual is a uniform
        // per-batch mode (applied at save time), so the first idea speaks for the batch.
        const ideaMatch = userId
            ? { portfolioId: { $in: portfolioIds }, userId }
            : { portfolioId: { $in: portfolioIds } }
        const metaRows = await db.collection('ideas')
            .aggregate([
                { $match: ideaMatch },
                { $sort:  { createdAt: 1 } },
                { $group: {
                    _id:           '$portfolioId',
                    portfolioName: { $first: '$portfolioName' },
                    broker:        { $first: '$broker' },
                    mainAccountId: { $first: '$mainAccountId' },
                    accounts:      { $first: '$accounts' },
                } },
            ])
            .toArray()

        const metaMap = Object.fromEntries(metaRows.map(r => [r._id, r]))
        // Virtual (paper/manual) accounts carry a user-facing name; resolve them once per
        // user. Live accounts fall back to their raw account id (the broker login number).
        const nameByAccount = await _virtualAccountNames(docs.map(d => d.userId))

        return docs.map(d => {
            const meta      = metaMap[d.portfolioId] ?? {}
            const accountId = meta.mainAccountId ?? _firstAccountId(meta.accounts)
            const mode      = _deriveMode(meta.broker, accountId)
            return {
                portfolioId:   d.portfolioId,
                userId:        d.userId,
                portfolioName: meta.portfolioName ?? 'Portfolio',
                mode,
                account:       _accountLabel(mode, accountId, nameByAccount, meta.broker),
                accountId:     accountId ?? null,
                reviewCadence: d.reviewCadence ?? 'weekly',
                nextReviewAt:  d.nextReviewAt,
                lastReviewAt:  d.lastReviewAt ?? null,
                notifiedAt:    d.notifiedAt   ?? null,
            }
        })
    } catch (err) {
        logger.error(LOG, 'Failed to get pending reviews', err)
        return []
    }
}

// ── Mode/account derivation (mirrors the frontend ideaWorkspace deriver) ────────
// Exported for unit testing; the pure logic mirrors tradeIdea.utils.ideaWorkspace.
// An idea's account can be a bare id string or a { id } object; take the first.
export function _firstAccountId(accounts) {
    const a = (accounts ?? [])[0]
    if (a == null) return null
    return typeof a === 'object' ? a.id : a
}

// 'paper' | 'manual' | 'live'. The top-level broker stamped at save time is primary;
// the virtual-account prefix (paper-/manual-) is the fallback for legacy ideas.
export function _deriveMode(broker, accountId) {
    if (broker === 'paper' || broker === 'manual') return broker
    return paperBrokerService.accountMode(accountId) ?? 'live'
}

// Batch-resolve virtual-account display names, one listAccounts per distinct user.
// Best-effort: a failed lookup just leaves the account unresolved (label falls back).
async function _virtualAccountNames(userIds) {
    const uniq = [...new Set(userIds.filter(Boolean))]
    const map  = {}
    await Promise.all(uniq.map(async uid => {
        try {
            const accts = await paperBrokerService.listAccounts(uid)
            for (const a of accts) map[a.accountId] = a.name
        } catch { /* leave unresolved */ }
    }))
    return map
}

// Display names for the live brokers (raw keys are lowercase).
const BROKER_LABELS = { ctrader: 'cTrader', ibkr: 'IBKR' }

// A human-friendly account label for the review notification. Virtual accounts show
// their user name; live accounts show "<Broker> #<login>" (the broker login IS the id).
export function _accountLabel(mode, accountId, nameByAccount, broker = null) {
    const fallback = mode === 'manual' ? 'Manual' : mode === 'paper' ? 'Paper' : 'Live account'
    if (!accountId) return fallback
    if (mode === 'paper' || mode === 'manual') return nameByAccount[accountId] ?? fallback
    const brokerLabel = BROKER_LABELS[broker] ?? (broker ? String(broker) : 'Live')
    return `${brokerLabel} #${accountId}`
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
