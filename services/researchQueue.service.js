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
import { getDb }      from '../providers/mongodb.provider.js'
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

function _strip(doc) { const d = { ...doc }; delete d._id; return d }

/**
 * Add a symbol to the queue. Idempotent — if the symbol is already queued or
 * in_research, returns { ok: true, duplicate: true } without inserting.
 */
async function enqueue({ symbol, source, requestedBy = 'house' } = {}) {
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
            created_at:  now,
            updated_at:  now,
        }
        await db.collection(COLLECTION).insertOne(doc)
        logger.info(LOG, 'queued', { symbol: sym, source: src })
        return { ok: true, id: doc.id, doc: _strip(doc) }
    } catch (err) {
        logger.error(LOG, 'enqueue failed', err)
        return { ok: false, error: err }
    }
}

/**
 * List queue entries. Admin view — no userId filter.
 */
async function listQueue({ status, limit = 200 } = {}) {
    try {
        const db = await getDb()
        const q  = {}
        if (status) q.status = Array.isArray(status) ? { $in: status } : status
        const docs = await db.collection(COLLECTION)
            .find(q).sort({ created_at: 1 }).limit(limit).toArray()
        return docs.map(_strip)
    } catch (err) {
        logger.error(LOG, 'listQueue failed', err)
        return []
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
 */
async function reject(id) {
    return _transition(id, 'rejected', ['queued', 'in_research'])
}

async function _transition(id, to, from) {
    try {
        const db  = await getDb()
        const now = new Date().toISOString()
        const res = await db.collection(COLLECTION).findOneAndUpdate(
            { id, status: { $in: from } },
            { $set: { status: to, updated_at: now } },
            { returnDocument: 'after' },
        )
        if (!res) return { ok: false, reason: 'not_found_or_wrong_status' }
        logger.info(LOG, to, { id })
        return { ok: true, doc: _strip(res) }
    } catch (err) {
        logger.error(LOG, `transition → ${to} failed`, err)
        return { ok: false, error: err }
    }
}

export const researchQueueService = { enqueue, listQueue, startResearch, markDone, reject }
