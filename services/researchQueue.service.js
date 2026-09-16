// Research queue — the pipeline from Argus house scan to Prometheus research.
//
// Argus enqueues names it discovers in overweight sectors; Prometheus picks them up one at a time,
// researches them, and writes house coverage with school tags. The queue is house-owned (no userId):
// it is an admin-pipeline artifact, not a per-user resource.
//
// Lifecycle: queued → in_research → done | rejected
//   queued:      enqueued by Argus (or admin manually)
//   in_research: admin/Prometheus has started research
//   done:        house coverage written for this symbol
//   rejected:    removed from active queue (misfire / admin decision)
//
// Idempotent enqueue: a symbol already queued or in_research is not duplicated.

import { randomUUID } from 'crypto'
import { getDb, stripId } from '../providers/mongodb.provider.js'
import { logger }     from './logger.service.js'

const LOG = '[researchQueue]'
export const COLLECTION = 'research_queue'
export const SOURCES    = ['argus', 'manual']
export const STATUSES   = ['queued', 'in_research', 'done', 'rejected']

async function _ensureIndexes(db) {
    const col = db.collection(COLLECTION)
    await col.createIndex({ id: 1 }, { unique: true })
    await col.createIndex({ symbol: 1, status: 1 })
    await col.createIndex({ status: 1, created_at: 1 })
}

/**
 * Add a symbol to the queue. Idempotent — if the symbol is already queued or
 * in_research, returns { ok: true, duplicate: true } without inserting.
 *
 * `context` is WHY this name is here: the view, regime, sector and stance that surfaced it. It is
 * carried rather than re-derived because by the time Prometheus picks the name up the view may have
 * been superseded, and "research AAPL" without the mandate that surfaced it is a different — worse —
 * instruction than "research AAPL because the house is +300bp Technology on a disinflation regime".
 *
 * A duplicate keeps the context it was FIRST queued with. Overwriting would silently re-motivate a
 * name that may already be in research under the old reason, and the queue is not the place to
 * resolve which mandate a half-finished thesis belongs to.
 */
async function enqueue({ symbol, source, requestedBy = 'house', context = null } = {}) {
    const sym = String(symbol || '').toUpperCase().trim()
    if (!sym) return { ok: false, reason: 'missing_symbol' }
    const src = SOURCES.includes(source) ? source : 'manual'

    try {
        const db = await getDb()
        await _ensureIndexes(db)

        const existing = await db.collection(COLLECTION).findOne(
            { symbol: sym, status: { $in: ['queued', 'in_research'] } }
        )
        if (existing) return { ok: true, duplicate: true, id: existing.id }

        const now = new Date().toISOString()
        const doc = {
            id:          `rq_${sym}_${randomUUID().slice(0, 8)}`,
            symbol:      sym,
            source:      src,
            requestedBy,
            status:      'queued',
            context:     context && typeof context === 'object' ? context : null,
            created_at:  now,
            updated_at:  now,
        }
        await db.collection(COLLECTION).insertOne(doc)
        logger.info(LOG, 'queued', { symbol: sym, source: src, sector: doc.context?.sector ?? null })
        return { ok: true, id: doc.id, doc: stripId(doc) }
    } catch (err) {
        logger.error(LOG, 'enqueue failed', err)
        return { ok: false, error: err }
    }
}

/**
 * List queue entries. Admin view — no userId filter. → the rows, or NULL when the read failed.
 *
 * Null and not `[]`, and the distinction is the whole point: this used to swallow a DB failure into
 * an empty array, so an Atlas outage rendered in the admin tab as "no names queued" — visually
 * identical to a queue that is genuinely empty. That is the worst possible failure for a diagnostic
 * surface, because it answers the question you are asking it with a confident lie. The caller turns
 * null into a 503; an empty array still means empty.
 */
async function listQueue({ status, limit = 200 } = {}) {
    try {
        const db = await getDb()
        const q  = {}
        if (status) q.status = Array.isArray(status) ? { $in: status } : status
        const docs = await db.collection(COLLECTION)
            .find(q).sort({ created_at: 1 }).limit(limit).toArray()
        return docs.map(stripId)
    } catch (err) {
        logger.error(LOG, 'listQueue failed', err)
        return null
    }
}

/**
 * Advance a queued entry to in_research.
 * Only moves from queued → in_research (a name already in research is not touched).
 */
async function startResearch(id) {
    return _transition(id, 'in_research', ['queued'])
}

/**
 * Mark a queue entry done — called when house coverage is written for the symbol.
 */
async function markDone(id) {
    return _transition(id, 'done', ['in_research', 'queued'])
}

/**
 * Reject — misfire, low-quality screen hit, or admin decision.
 *
 * `reason` is WHY, when a machine decided it: the batch run (researchRun.service) rejects a name
 * it skipped because the house already covers it, and one Prometheus researched and passed on.
 * Those are different outcomes from an admin's click, and a rejected row that cannot say which
 * it was is a row the admin has to re-derive. Free text, stored as given; absent on a manual
 * reject.
 */
async function reject(id, reason = null) {
    return _transition(id, 'rejected', ['queued', 'in_research'], reason ? { reason } : {})
}

/**
 * Back to the line — in_research → queued. For a claim that produced nothing: a research turn
 * that failed on the account (researchRun.requeueFailed), or one lost to a refresh. Not a
 * lifecycle step, a correction; it clears any reason the row carried.
 */
async function requeue(id) {
    return _transition(id, 'queued', ['in_research'], { reason: null })
}

/**
 * Every claimed name back to the line at once — the whole `in_research` set, minus `except`.
 *
 * Reads the QUEUE, not a run's memory: the first batch run died on the account with 22 names
 * claimed, and the tally that knew which 22 died with the process on the restart that fixed it.
 * The rows themselves never forgot. `except` is the one name a running batch is mid-turn on.
 */
async function requeueInResearch({ except = [] } = {}) {
    try {
        const db  = await getDb()
        const now = new Date().toISOString()
        const q   = { status: 'in_research' }
        if (except.length) q.symbol = { $nin: except.map(s => String(s).toUpperCase()) }
        const res = await db.collection(COLLECTION).updateMany(q, { $set: { status: 'queued', updated_at: now, reason: null } })
        logger.info(LOG, 'requeued in_research', { requeued: res.modifiedCount, except })
        return { ok: true, requeued: res.modifiedCount }
    } catch (err) {
        logger.error(LOG, 'requeueInResearch failed', err)
        return { ok: false, error: err }
    }
}

async function _transition(id, to, from, extra = {}) {
    try {
        const db  = await getDb()
        const now = new Date().toISOString()
        const res = await db.collection(COLLECTION).findOneAndUpdate(
            { id, status: { $in: from } },
            { $set: { status: to, updated_at: now, ...extra } },
            { returnDocument: 'after' },
        )
        if (!res) return { ok: false, reason: 'not_found_or_wrong_status' }
        logger.info(LOG, to, { id, ...extra })
        return { ok: true, doc: stripId(res) }
    } catch (err) {
        logger.error(LOG, `transition → ${to} failed`, err)
        return { ok: false, error: err }
    }
}

export const researchQueueService = { enqueue, listQueue, startResearch, markDone, reject, requeue, requeueInResearch }
