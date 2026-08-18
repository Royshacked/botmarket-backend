// Repair the holdings whose recorded size drifted from the broker's (2026-08-17). One-shot,
// idempotent, and reversible by inspection: it only ever writes a size the BROKER is already
// reporting, and it prints every change before making it.
//
//   node scripts/repair-stale-leg-quantities.mjs            # DRY RUN — prints the plan, writes nothing
//   node scripts/repair-stale-leg-quantities.mjs --apply    # writes
//
// WHAT WENT WRONG. Two bugs, one symptom — the app's own record of how much it holds.
//
//   • A review TRIM closes the position directly, placing no tracked exit order. The reconciler can
//     only size a reduction it can match to one, so the reduce reached NEITHER writer: XLU's leg
//     still read 126 shares while the venue held 63. That number is the base every later fraction is
//     measured against, so the next "trim half" would have computed floor(126 × 0.5) = 63 and closed
//     the whole remaining position.
//
//   • A scale-in on a hedging venue (and paper, until it learned to net) opens a SIBLING position
//     rather than growing the original. The new leg was tracked correctly, but the holding's own
//     `quantity` stayed at the pre-add figure: MU read 10 while 13 was held across two positions.
//
// Both writers are fixed. This is for the rows that drifted before the fix.
//
// WHAT IT DOES, per holding that is live and linked:
//   • each leg's `quantity` ← the volume its position actually reports at the broker
//   • the holding's `quantity` ← the sum of its MAIN account's linked legs (idea units — the same
//     derivation `_syncItemQuantity` now makes on every trim and add)
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not merge two paper positions of one holding into one,
// even though the venue now nets. Merging means deleting a position document the trade ledger may
// already reference, and the display folds those legs into a single blended line anyway — so there is
// nothing to gain by rewriting history. It also never invents a size: a position the broker cannot be
// asked about (an unreachable venue) is reported and skipped, never zeroed.

import 'dotenv/config'
import { getDb } from '../providers/mongodb.provider.js'
import { brokerService } from '../api/broker/broker.service.js'
import { ENTITIES } from '../services/entity/entityCollection.js'
import { LIVE_POSITION } from '../services/entity/vocabulary.js'

const APPLY = process.argv.includes('--apply')
const LIVE  = new Set(LIVE_POSITION)

const db = await getDb()

// Every live entity carrying broker linkage — holdings, calls and setups alike. The drift is not a
// portfolio-only fact: any entity whose position was partly closed outside a tracked exit order has it.
const rows = await db.collection(ENTITIES)
    .find({ status: { $in: [...LIVE] }, brokerOrders: { $exists: true, $ne: [] } })
    .project({ id: 1, userId: 1, asset: 1, kind: 1, status: 1, quantity: 1, mainAccountId: 1, brokerOrders: 1, portfolioName: 1 })
    .toArray()

console.log(`\n${rows.length} live linked entit${rows.length === 1 ? 'y' : 'ies'}${APPLY ? '' : '  (DRY RUN — nothing will be written)'}\n`)

// One getPositions per broker per user, reused across that user's rows.
const cache = new Map()
async function positionsFor(broker, userId) {
    const key = `${broker}|${userId}`
    if (!cache.has(key)) {
        cache.set(key, brokerService.getPositions(broker, userId).catch(err => {
            console.log(`  ! getPositions(${broker}) failed for ${userId}: ${err.message}`)
            return null   // null = UNKNOWN, distinct from an empty book
        }))
    }
    return cache.get(key)
}

let legFixes = 0, qtyFixes = 0, unknown = 0, clean = 0

for (const row of rows) {
    const legs = (row.brokerOrders ?? []).filter(l => l.positionId != null && l.broker)
    if (!legs.length) continue

    const changes = []
    for (const leg of legs) {
        const list = await positionsFor(leg.broker, row.userId)
        if (list == null) { unknown++; continue }
        const pos = list.find(p => String(p.id) === String(leg.positionId) && String(p.accountId) === String(leg.accountId))
        // A leg with no live position is either closed or gone — that is the reconciler's business
        // (it closes the entity), not a size to rewrite here.
        if (!pos) continue
        const live = Number(pos.volume)
        if (!Number.isFinite(live) || live <= 0) { unknown++; continue }
        if (Number(leg.quantity) === live) continue
        changes.push({ leg, live })
    }

    // The holding's own size, from the main account's linked legs — post-fix values.
    const acct  = String(row.mainAccountId ?? legs[0].accountId)
    const mine  = legs.filter(l => String(l.accountId) === acct)
    const sized = (mine.length ? mine : legs).map(l => {
        const fix = changes.find(c => c.leg.positionId === l.positionId)
        return fix ? fix.live : (Number(l.quantity) || 0)
    })
    const total   = sized.reduce((s, q) => s + q, 0)
    const qtyDrift = total > 0 && Number(row.quantity) !== total

    if (!changes.length && !qtyDrift) { clean++; continue }

    console.log(`${row.asset} ${row.status} (${row.kind ?? 'entity'}${row.portfolioName ? ` · ${row.portfolioName}` : ''})  ${row.id}`)
    for (const c of changes) {
        console.log(`   leg ${c.leg.accountId}/${c.leg.positionId}: ${c.leg.quantity} → ${c.live}`)
    }
    if (qtyDrift) console.log(`   quantity: ${row.quantity ?? '(unset)'} → ${total}`)

    if (APPLY) {
        for (const c of changes) {
            await db.collection(ENTITIES).updateOne(
                { id: row.id },
                { $set: { 'brokerOrders.$[leg].quantity': c.live } },
                { arrayFilters: [{ 'leg.accountId': String(c.leg.accountId), 'leg.positionId': String(c.leg.positionId) }] },
            )
            legFixes++
        }
        if (qtyDrift) {
            await db.collection(ENTITIES).updateOne({ id: row.id }, { $set: { quantity: total } })
            qtyFixes++
        }
    } else {
        legFixes += changes.length
        if (qtyDrift) qtyFixes++
    }
}

console.log(`\n${APPLY ? 'Wrote' : 'Would write'}: ${legFixes} leg size(s), ${qtyFixes} holding quantit(ies).`)
console.log(`${clean} already agreed with the broker; ${unknown} leg(s) could not be checked (left alone).`)
if (!APPLY) console.log('\nRe-run with --apply to write.\n')
process.exit(0)
