import { getDb, stripId }   from '../../providers/mongodb.provider.js'
import { ENTITIES }         from '../../services/entity/entityCollection.js'
import { logger }  from '../../services/logger.service.js'
import { getPortfolioStateCached } from '../../services/portfolioState.service.js'
import { threadService } from '../../services/thread.service.js'
import { isSubstantive } from '../../services/thread.util.js'
import { buildFingerprint, benchmarkTicker, computeReviewDelta, computeReviewTriggers } from '../../services/portfolioReview.util.js'
import { getMacroRaw } from '../../providers/fmp.provider.js'
import { getFmpQuote } from '../../providers/fmp.price.provider.js'
import { coverageService } from '../analyst/coverage.service.js'
// Mode/account helpers live in a shared util (portfolioState needs them too, and importing
// them from here would be circular). Re-exported below so existing importers/tests keep working.
import { _firstAccountId, _deriveMode, _accountLabel, _virtualAccountNames } from './portfolioMode.util.js'

export { _firstAccountId, _deriveMode, _accountLabel }

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
    captureFingerprint,
    computeReviewSignals,
    getPendingThemisChecks,
    loadStreamContext,
    persistStreamOutcome,
}

/**
 * Assemble the per-turn context the portfolio agent needs and resolve the effective mandate,
 * which is carried forward across turns: a fresh body mandate wins, then the draft-thread
 * mandate (so first-time construction survives a reload), then the stored one (edit/review).
 * Every fetch is best-effort. Returns { portfolioState, lifecycle, mandate, storedThesis }.
 */
async function loadStreamContext({ userId, portfolioId, threadId, isReviewMode, bodyMandate }) {
    const [portfolioState, lifecycle, storedMandate, storedThesis] = await Promise.all([
        // Position/P&L + workspace state is loaded whenever an EXISTING portfolio is open — a
        // scheduled review OR a normal update/edit — so Atlas can always see the live book it's
        // managing (mode, broker/account, per-position and total P&L). Construction (no portfolioId)
        // has no positions yet, so it stays null. The block's TITLE (review vs update) is what tells
        // the model whether to run the review sub-phases — see _buildPortfolioStateSection.
        portfolioId ? getPortfolioStateCached(portfolioId, userId).catch(() => null) : Promise.resolve(null),
        portfolioId ? getPortfolioLifecycle(portfolioId, userId).catch(() => null) : Promise.resolve(null),
        portfolioId ? getMandate(portfolioId, userId).catch(() => null) : Promise.resolve(null),
        portfolioId ? getThesis(portfolioId, userId).catch(() => null) : Promise.resolve(null),
    ])

    const draftThread = (!portfolioId && threadId)
        ? await threadService.getThread({ threadId, userId }).catch(() => null)
        : null

    const mandate = bodyMandate ?? draftThread?.mandate ?? storedMandate

    // In review mode, resolve the review-window delta (benchmark-relative return + regime shift)
    // against the stored fingerprint. Best-effort — a first review (no fingerprint) yields null.
    const reviewDelta = (isReviewMode && lifecycle?.lastFingerprint)
        ? await buildReviewDelta(lifecycle.lastFingerprint, portfolioState).catch(() => null)
        : null

    return { portfolioState, lifecycle, mandate, storedThesis, reviewDelta }
}

/**
 * Cheap pre-check for the scheduled-review nudge (S3, "pre-check only" model): compute the
 * review triggers for a due portfolio without running the LLM. Used by the monitor to enrich the
 * notification. Best-effort — returns empty triggers on any failure.
 *
 * @returns {Promise<{ triggers: Array }>}
 */
async function computeReviewSignals(portfolioId, userId) {
    try {
        const [state, lifecycle] = await Promise.all([
            getPortfolioStateCached(portfolioId, userId).catch(() => null),
            getPortfolioLifecycle(portfolioId, userId).catch(() => null),
        ])
        const fingerprint = lifecycle?.lastFingerprint ?? null
        const delta = fingerprint ? await buildReviewDelta(fingerprint, state).catch(() => null) : null
        // Coverage-delta gate: a held name whose Prometheus coverage flipped terminal. Read the
        // user's coverage book and keep only the held names that went thesis_broken / target_hit —
        // the crossing stays artifact-mediated (Themis reads coverage; Prometheus wrote it).
        const held = new Set((state?.ideas ?? []).map(i => String(i.asset ?? '').toUpperCase()).filter(Boolean))
        let coverage = []
        if (held.size) {
            const rows = await coverageService.getCoverage(userId).catch(() => [])
            coverage = (Array.isArray(rows) ? rows : []).filter(c =>
                held.has(String(c.symbol ?? '').toUpperCase()) && ['thesis_broken', 'target_hit'].includes(c.status))
        }
        return { triggers: computeReviewTriggers({ state, fingerprint, delta, coverage }) }
    } catch (err) {
        logger.warn(LOG, 'computeReviewSignals failed', err.message)
        return { triggers: [] }
    }
}

/**
 * Resolve the current benchmark price + macro read and diff them against a stored fingerprint.
 * Both fetches are cached (benchmark ~3s, macro 1h) and best-effort. Returns a reviewDelta or null.
 */
async function buildReviewDelta(fingerprint, state) {
    const [benchmarkNowPrice, macroNow] = await Promise.all([
        fingerprint.benchmark?.ticker ? getFmpQuote(fingerprint.benchmark.ticker).catch(() => null) : Promise.resolve(null),
        getMacroRaw().catch(() => null),
    ])
    return computeReviewDelta({ fingerprint, state, benchmarkNowPrice, macroNow })
}

/**
 * Fire-and-forget persistence after a portfolio stream turn: persist an emitted mandate (edit),
 * a captured thesis (construction/edit only — in review mode a thesis change persists only on
 * accepted rebalance), and, during first-time construction, refresh the draft thread once the
 * mandate floor is crossed. The caller gates this on the client still listening (!aborted).
 */
function persistStreamOutcome({ userId, portfolioId, threadId, isReviewMode, messages, mandate, storedThesis, result }) {
    if (result.mandate && portfolioId) {
        setMandate(portfolioId, userId, result.mandate)
            .then(r => { if (!r.ok) logger.warn(LOG, 'setMandate returned not-ok, mandate may not be persisted') })
            .catch(err => logger.warn(LOG, 'setMandate unexpected error', err))
    }
    if (result.thesis && portfolioId && !isReviewMode) {
        setThesis(portfolioId, userId, result.thesis, storedThesis ? 'mandate-edit' : 'construction')
            .catch(err => logger.warn(LOG, 'setThesis unexpected error', err))
    }
    const knownMandate = result.mandate ?? mandate
    if (!portfolioId && threadId && isSubstantive({ agent: 'portfolio', phase: result.phase, mandateReady: !!knownMandate })) {
        const draftMessages = [...messages, { role: 'assistant', content: result.reply }]
        threadService.saveDraft({
            threadId, userId, agent: 'portfolio',
            messages: draftMessages, phase: result.phase ?? null,
            subjectType: 'portfolio', mandate: knownMandate ?? null,
        }).catch(err => logger.warn(LOG, 'construction saveDraft failed', err))
    }
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
        // Exclude lastFingerprint: it's internal review-delta state (carries per-holding
        // conviction.score, which is never surfaced to the client) — not for the chat-state payload.
        const doc = await db.collection(COLLECTION).findOne({ portfolioId, userId }, { projection: { lastFingerprint: 0 } })
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
            { projection: { reviewCadence: 1, nextReviewAt: 1, lastReviewAt: 1, reviewHistory: 1, lastFingerprint: 1 } }
        )
        if (!doc) return null
        return {
            reviewCadence:   doc.reviewCadence ?? 'monthly',
            nextReviewAt:    doc.nextReviewAt  ?? null,
            lastReviewAt:    doc.lastReviewAt  ?? null,
            reviewHistory:   doc.reviewHistory ?? [],
            lastFingerprint: doc.lastFingerprint ?? null,
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
        const metaRows = await db.collection(ENTITIES)
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

/**
 * In-position books due for a Themis wake. Anchored on the Themis EOD clock (`themis.next_check_at`,
 * epoch ms — distinct from the scheduled-review clock `nextReviewAt`): a book is due when that clock
 * is missing (never checked) or has passed. Each candidate is joined to the `entities` collection for
 * display meta AND a live-holding count, then FILTERED to books that actually hold a position
 * (liveCount ≥ 1) — Themis only monitors in-position books. Returns the lifecycle + Themis sub-state
 * the monitor needs to evaluate both gates and re-lease the clock. Empty on no due books / failure.
 */
async function getPendingThemisChecks(now = Date.now()) {
    try {
        const db   = await getDb()
        const docs = await db.collection(COLLECTION)
            .find({ $or: [
                { 'themis.next_check_at': null },
                { 'themis.next_check_at': { $exists: false } },
                { 'themis.next_check_at': { $lte: now } },
            ] })
            .project({ portfolioId: 1, userId: 1, reviewCadence: 1, nextReviewAt: 1, lastReviewAt: 1, notifiedAt: 1, themis: 1 })
            .toArray()

        if (!docs.length) return []

        const portfolioIds = docs.map(d => d.portfolioId)
        // One representative idea per portfolio carries the display name + broker/account (a uniform
        // per-batch mode), plus liveCount = how many holdings are actually open (status long/short).
        const metaRows = await db.collection(ENTITIES)
            .aggregate([
                { $match: { portfolioId: { $in: portfolioIds } } },
                { $sort:  { createdAt: 1 } },
                { $group: {
                    _id:           '$portfolioId',
                    portfolioName: { $first: '$portfolioName' },
                    broker:        { $first: '$broker' },
                    mainAccountId: { $first: '$mainAccountId' },
                    accounts:      { $first: '$accounts' },
                    liveCount:     { $sum: { $cond: [{ $in: ['$status', ['long', 'short']] }, 1, 0] } },
                } },
            ])
            .toArray()

        const metaMap       = Object.fromEntries(metaRows.map(r => [r._id, r]))
        const nameByAccount = await _virtualAccountNames(docs.map(d => d.userId))

        return docs.map(d => {
            const meta = metaMap[d.portfolioId] ?? {}
            if ((meta.liveCount ?? 0) < 1) return null   // not in position → invisible to Themis
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
                nextReviewAt:  d.nextReviewAt ?? null,
                lastReviewAt:  d.lastReviewAt ?? null,
                notifiedAt:    d.notifiedAt   ?? null,
                themis:        d.themis       ?? null,
            }
        }).filter(Boolean)
    } catch (err) {
        logger.error(LOG, 'Failed to get pending Themis checks', err)
        return []
    }
}

/**
 * Capture the portfolio's compact "then" fingerprint (book value, benchmark price, regime,
 * per-holding weight+conviction) and store it as `lastFingerprint`. Read by the next review to
 * compute deltas (benchmark-relative return, regime shift). Best-effort — never throws; a failed
 * capture just means the next review has no baseline. Called at construction and review completion.
 *
 * @param {'construction'|'review'} reason
 */
async function captureFingerprint(portfolioId, userId, reason) {
    try {
        const [state, mandate, macroRaw] = await Promise.all([
            getPortfolioStateCached(portfolioId, userId).catch(() => null),
            getMandate(portfolioId, userId).catch(() => null),
            getMacroRaw().catch(() => null),
        ])

        let benchmark = null
        const tk = benchmarkTicker(mandate?.benchmark)
        if (tk) {
            const price = await getFmpQuote(tk).catch(() => null)
            benchmark = { ticker: tk, price: Number.isFinite(price) ? price : null }
        }

        const fingerprint = buildFingerprint({ reason, state, macroRaw, benchmark })
        await setPortfolioLifecycle(portfolioId, userId, { lastFingerprint: fingerprint })
        logger.info(LOG, 'fingerprint captured', { portfolioId, reason, benchmark: tk ?? null, bookValue: fingerprint.bookValue })
        return fingerprint
    } catch (err) {
        logger.warn(LOG, 'captureFingerprint failed', err.message)
        return null
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
        // At construction, seed the baseline fingerprint so the FIRST review has a "then" to
        // delta against (regime + benchmark + target weights). Fire-and-forget.
        if (reason === 'construction') captureFingerprint(portfolioId, userId, 'construction').catch(() => {})
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
        // Snapshot the book AS OF this review — the "then" the NEXT review deltas against.
        // Fire-and-forget so review completion stays snappy.
        captureFingerprint(portfolioId, userId, 'review').catch(() => {})
        return { ok: true, nextReviewAt: next }
    } catch (err) {
        logger.error(LOG, 'Failed to complete review', err)
        return { ok: false }
    }
}
