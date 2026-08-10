/**
 * The adoption draft — staged intake, committed in one pass.
 *
 * Adopting a book (docs/design/adopted-book.md) is one user gesture that becomes N positions, N
 * entities, an account and a lifecycle doc. The user has to see and correct the whole table before
 * any of it is real, and the commit has to survive being interrupted half way — so the confirmed
 * table IS a persisted draft, and the commit reads it back rather than trusting a request body.
 *
 * DELIBERATELY THIN, and deliberately not a generic staging framework: it has one caller. What it
 * keeps is only what makes a retry safe — the ids of side effects already performed (the account,
 * and each symbol's position), so a second attempt reuses them instead of creating a twin. The
 * broader idempotency guarantee is NOT here: it is the commit re-reading which legs already exist
 * (see adoptBook.service), because the entity collection is the source of truth and this bookkeeping
 * is not.
 *
 * A second caller — a CSV import, the drift re-confirm ritual — should lift this as-is.
 */

import { randomUUID } from 'crypto'
import { getDb }      from '../../providers/mongodb.provider.js'
import { logger }     from '../../services/logger.service.js'

const COLLECTION = 'adoptionDrafts'
const LOG        = '[adoptDraft]'

/**
 * A draft is being confirmed, being committed, or spent. There is no FAILED state on purpose: an
 * interrupted commit is released back to `draft` so it can simply be retried.
 */
export const DRAFT_STATUS = { DRAFT: 'draft', COMMITTING: 'committing', COMMITTED: 'committed' }

// How long a commit may hold its claim before another attempt may take it over. Long enough for N
// position writes and a batch entity write; short enough that a process killed mid-commit doesn't
// strand the book. Mirrors the monitors' lease discipline (dueLoop).
export const CLAIM_LEASE_MS = 2 * 60_000

async function createDraft(userId, draft) {
    const db  = await getDb()
    const doc = {
        ...draft,
        draftId:   randomUUID(),
        userId,
        status:    DRAFT_STATUS.DRAFT,
        // Side effects already performed, so a retry reuses them rather than creating twins.
        accountId: null,
        positions: {},
        createdAt: Date.now(),
    }
    await db.collection(COLLECTION).insertOne({ ...doc })
    logger.info(LOG, `draft ${doc.draftId} created — ${draft.holdings?.length ?? 0} holding(s)`)
    return doc
}

/** Owner-scoped by construction: a draft is only ever readable by the user who staged it. */
async function getDraft(draftId, userId) {
    const db = await getDb()
    return db.collection(COLLECTION).findOne({ draftId: String(draftId), userId }, { projection: { _id: 0 } })
}

async function listDrafts(userId) {
    const db = await getDb()
    return db.collection(COLLECTION)
        .find({ userId, status: DRAFT_STATUS.DRAFT }, { projection: { _id: 0 } })
        .sort({ createdAt: -1 })
        .toArray()
}

/** Remember the account this draft opened, so a retry doesn't open a second one. */
async function recordAccount(draftId, userId, accountId) {
    const db = await getDb()
    await db.collection(COLLECTION).updateOne({ draftId: String(draftId), userId }, { $set: { accountId: String(accountId) } })
}

/**
 * Remember the position written for one symbol. This closes the one window the entity-collection
 * check cannot: a crash BETWEEN opening a position and writing its entity would otherwise leave the
 * position invisible to the retry, which would then open a second one for the same holding.
 */
async function recordPosition(draftId, userId, symbol, positionId) {
    const db = await getDb()
    await db.collection(COLLECTION).updateOne(
        { draftId: String(draftId), userId },
        { $set: { [`positions.${String(symbol).toUpperCase()}`]: String(positionId) } },
    )
}

/**
 * Take exclusive hold of a draft for the duration of one commit.
 *
 * Two simultaneous commits (a double-clicked button) would each open an account and a position per
 * symbol — the existence check in the service runs BEFORE the positions are written, so it cannot see
 * a twin that is mid-flight. `updateOne` + `modifiedCount` is the same atomic-claim idiom the order
 * layer uses (paperBroker.claimOrder): only one caller can match.
 *
 * The claim is LEASED rather than permanent, so a commit killed mid-flight can be retried once the
 * lease expires instead of stranding the book forever.
 * @returns {Promise<boolean>} whether this caller now holds the draft
 */
async function claimDraft(draftId, userId, leaseMs = CLAIM_LEASE_MS) {
    const db  = await getDb()
    const now = Date.now()
    const res = await db.collection(COLLECTION).updateOne(
        {
            draftId: String(draftId), userId,
            $or: [
                { status: DRAFT_STATUS.DRAFT },
                { status: DRAFT_STATUS.COMMITTING, claimedAt: { $lt: now - leaseMs } },
            ],
        },
        { $set: { status: DRAFT_STATUS.COMMITTING, claimedAt: now } },
    )
    return res.modifiedCount === 1
}

/**
 * Hand a draft back after an attempt that didn't finish the book, so the next retry isn't made to
 * wait out the lease. Safe because every step of the commit is idempotent.
 */
async function releaseDraft(draftId, userId) {
    const db = await getDb()
    await db.collection(COLLECTION).updateOne(
        { draftId: String(draftId), userId, status: DRAFT_STATUS.COMMITTING },
        { $set: { status: DRAFT_STATUS.DRAFT }, $unset: { claimedAt: '' } },
    )
}

/**
 * Update the staged table in place. Only ever an UNSPENT draft: once a book is committed its rows are
 * real positions, and the way to change those is the repair path, not the draft.
 */
async function patchDraft(draftId, userId, patch) {
    const db = await getDb()
    await db.collection(COLLECTION).updateOne(
        { draftId: String(draftId), userId, status: DRAFT_STATUS.DRAFT },
        { $set: { ...patch, updatedAt: Date.now() } },
    )
}

async function setStatus(draftId, userId, status, patch = {}) {
    const db = await getDb()
    await db.collection(COLLECTION).updateOne({ draftId: String(draftId), userId }, { $set: { status, ...patch } })
}

async function deleteDraft(draftId, userId) {
    const db = await getDb()
    const res = await db.collection(COLLECTION).deleteOne({ draftId: String(draftId), userId, status: DRAFT_STATUS.DRAFT })
    return res.deletedCount > 0
}

export const adoptDraftStore = {
    createDraft, getDraft, listDrafts, patchDraft, recordAccount, recordPosition,
    claimDraft, releaseDraft, setStatus, deleteDraft,
    DRAFT_STATUS, CLAIM_LEASE_MS,
}
