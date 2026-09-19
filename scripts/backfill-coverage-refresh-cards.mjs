// Make the pending coverage-refresh cards closable. Idempotent; run once per DB:
//
//   node scripts/backfill-coverage-refresh-cards.mjs
//
// Two defects, stamped onto the message at POST time and read by the client off the message it
// renders — so fixing the producer (coverageNotify / coverageRefresh) fixes every FUTURE card and
// nothing already sitting in a user's chat. Same reasoning as backfill-queue-card-resolves-on.
//
//   1. A refresh card WITHOUT a review behind it asks the reader to READ what the refresh wrote.
//      Stamped 'work', it could only close when a write landed on its entity — and a read has no
//      write. Every "Scheduled re-model of X …" card stayed "Opened — still waiting on you".
//      → `actions.primary.resolvesOn: 'open'` for the pending ones with no portfolioId.
//
//   2. The failure cards ("produced nothing to store") were posted with `coverageId: null`, so
//      they carried no `subject` and no write could have reached them anyway. The house has a doc
//      on the symbol — the card just never named it.
//      → fill `payload.coverageId` and `subject` from the coverage book, by symbol.
//
//   3. A card about a company REVISED after the card was posted is answered — there is nothing left
//      to click. Going forward the write closes it (analyst.controller / coverageRefresh →
//      resolveCardsFor); the cards posted before that seam existed are closed here, with the
//      revision's own account of what moved, dated to the revision.
//      → status 'done' · resolveOutcome 'revised' · resolveNote revisionSummary(latest revision).
//
//   4. With no subject, the one-live-ask rule (_supersedePending) could not see that a second card
//      about the same doc had replaced the first. Now that they are named, the older pending
//      duplicate collapses as superseded.
//
// Only PENDING cards are touched: a settled card is history.

import dns from 'node:dns'
import { config } from '../services/config.js'
import { getDb } from '../providers/mongodb.provider.js'
import { logger } from '../services/logger.service.js'
import { MSGS } from '../api/chat/chat.service.js'
import { COLLECTION as COVERAGE, revisionSummary } from '../api/analyst/coverage.service.js'

const LOG = '[backfill:coverage-refresh-cards]'

// Same pin server.js and clone-db-for-dev apply: a dev router that blocks SRV lookups makes
// `mongodb+srv://` fail with `querySrv ECONNREFUSED` before the script does anything.
if (config.dnsServers.length) dns.setServers(config.dnsServers)

async function run() {
    const db = await getDb()

    // (1) read cards close on open
    const stamped = await db.collection(MSGS).updateMany(
        { type: 'coverage_refreshed', status: 'pending', 'payload.portfolioId': { $in: [null, ''] }, 'actions.primary.resolvesOn': { $ne: 'open' } },
        { $set: { 'actions.primary.resolvesOn': 'open' } },
    )

    // (2) name the doc
    const orphans = await db.collection(MSGS)
        .find({ type: 'coverage_refreshed', status: 'pending', 'payload.coverageId': { $in: [null, ''] } }, { projection: { _id: 0, id: 1, 'payload.symbol': 1 } })
        .toArray()
    let named = 0, unmatched = []
    for (const m of orphans) {
        const sym = String(m.payload?.symbol ?? '').toUpperCase().trim()
        const cov = sym ? await db.collection(COVERAGE).findOne({ symbol: sym }, { projection: { _id: 0, id: 1 } }) : null
        if (!cov?.id) { unmatched.push(sym || '?'); continue }
        const res = await db.collection(MSGS).updateOne(
            { id: m.id, status: 'pending' },
            { $set: { 'payload.coverageId': cov.id, subject: { kind: 'coverage', id: cov.id } } },
        )
        named += res.modifiedCount
    }

    // (3) answered by a later revision → resolved, dated to the revision
    const pending = await db.collection(MSGS)
        .find({ type: { $in: ['coverage_event', 'coverage_refreshed'] }, status: 'pending', 'subject.kind': 'coverage' },
              { projection: { _id: 0, id: 1, conversationId: 1, type: 1, status: 1, createdAt: 1, 'subject.id': 1 } })
        .sort({ createdAt: 1 }).toArray()
    const docIds = [...new Set(pending.map(m => m.subject.id))]
    const docs   = await db.collection(COVERAGE).find({ id: { $in: docIds } }, { projection: { _id: 0, id: 1, revisions: 1 } }).toArray()
    const byId   = Object.fromEntries(docs.map(d => [d.id, d]))
    // The user's writes and re-models, not the monitor's bookkeeping: a verdict revision ('validating',
    // 'thesis_broken' …) is what POSTS the card, so it cannot also be what answers it.
    const ANSWERS = new Set(['remodel', 'update', 'retire', 'initiate', 'rating_change', 'target_change'])
    let resolved = 0
    for (const m of pending) {
        const revs   = (byId[m.subject.id]?.revisions ?? []).filter(r => ANSWERS.has(r.kind) && Date.parse(r.at) > m.createdAt)
        if (!revs.length) continue
        const latest = revs.reduce((a, b) => (Date.parse(b.at) > Date.parse(a.at) ? b : a))
        const res = await db.collection(MSGS).updateOne(
            { id: m.id, status: 'pending' },
            { $set: { status: 'done', resolvedAt: Date.parse(latest.at), resolveOutcome: 'revised', resolveNote: revisionSummary(latest) } },
        )
        resolved += res.modifiedCount
        m.status = 'done'
    }

    // (4) a pending card with a NEWER sibling (same conversation, type, doc — any status: the newer
    //     card superseded it the moment it was posted, whatever became of it since) → superseded,
    //     as _supersedePending would have done had the older one carried a subject.
    let superseded = 0
    const all = await db.collection(MSGS)
        .find({ type: { $in: ['coverage_event', 'coverage_refreshed'] }, 'subject.kind': 'coverage' },
              { projection: { _id: 0, conversationId: 1, type: 1, createdAt: 1, 'subject.id': 1 } })
        .toArray()
    const newestAt = {}
    for (const m of all) {
        const key = `${m.conversationId}|${m.type}|${m.subject.id}`
        newestAt[key] = Math.max(newestAt[key] ?? 0, m.createdAt)
    }
    for (const m of pending.filter(x => x.status === 'pending')) {
        const key = `${m.conversationId}|${m.type}|${m.subject.id}`
        if (m.createdAt >= newestAt[key]) continue
        const res = await db.collection(MSGS).updateOne(
            { id: m.id, status: 'pending' },
            { $set: { status: 'superseded', resolvedAt: Date.now(), resolveOutcome: 'superseded' } },
        )
        superseded += res.modifiedCount
    }

    logger.info(LOG, `re-stamped ${stamped.modifiedCount} pending refresh card(s) to close on open; named the doc on ${named} of ${orphans.length} orphan(s)`
        + (unmatched.length ? ` — no coverage found for: ${[...new Set(unmatched)].join(', ')}` : '')
        + `; resolved ${resolved} card(s) answered by a later revision; superseded ${superseded} older duplicate(s)`)
}

run()
    .then(() => process.exit(0))
    .catch(err => { logger.error(LOG, 'Backfill failed:', err); process.exit(1) })
