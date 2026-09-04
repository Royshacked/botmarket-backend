// Repair setup entities stuck in 'long'/'short' whose paper position is already closed.
//
// HOW IT HAPPENS. When a paper position is closed via the ✕ button (or any manual path),
// `reducePosition` emits `position.closed`. The reconciler's `_onClosed` calls
// `findActiveByPosition(accountId, positionId)` — which requires the entity's `brokerOrders[]`
// to contain that exact `{ accountId, positionId }` pair. If the positionId was never stamped
// onto the setup's `brokerOrders` (most common when the entry was a resting limit/stop and the
// reconciler's `claimRestingFill` path missed the setup because it looks for status: 'resting'
// while the setup was already 'long'), the entity is never found and stays stuck.
//
// The stale-position startup sweep also skips entries with `positionId: null`, so a restart
// does not help in that case either.
//
// WHAT THIS DOES. For every 'long'/'short' entity of kind 'setup':
//   1. If it has a broker link with a positionId → asks the broker whether that position is still open.
//      Gone → marks the entity 'closed'.
//   2. If it has NO positionId on any broker link (the gap case above) → checks whether the paper
//      broker has ANY open position for that account + symbol. None → marks the entity 'closed'.
//
// DRY RUN by default. Pass --apply to write.
//
//   node scripts/repair-stuck-setup-status.mjs
//   node scripts/repair-stuck-setup-status.mjs --apply

import 'dotenv/config'
import { getDb }         from '../providers/mongodb.provider.js'
import { paperBrokerService } from '../api/broker/paperBroker.service.js'
import { ENTITIES }      from '../services/entity/entityCollection.js'
import { LIVE_POSITION } from '../services/entity/vocabulary.js'

const APPLY = process.argv.includes('--apply')

async function main() {
    const db = await getDb()
    const coll = db.collection(ENTITIES)

    const stuck = await coll.find({
        kind:   'setup',
        status: { $in: LIVE_POSITION },
        broker: 'paper',
    }).toArray()

    console.log(`Found ${stuck.length} paper setup(s) in live status.`)
    if (!stuck.length) { process.exit(0) }

    let fixed = 0
    for (const setup of stuck) {
        const userId = setup.userId
        const asset  = setup.asset
        const links  = setup.brokerOrders ?? []

        let positionGone = false

        // Case 1: positionId is stamped — ask the broker directly.
        const linked = links.filter(l => l.positionId)
        if (linked.length) {
            let allGone = true
            for (const link of linked) {
                const pos = await paperBrokerService.getPosition(userId, link.positionId)
                if (pos && pos.status === 'open') { allGone = false; break }
            }
            positionGone = allGone
        } else {
            // Case 2: positionId never stamped — check whether the paper account has any open
            // position for this symbol.
            const open = await paperBrokerService.listPositions(userId, { status: 'open' })
            const match = open.filter(p => p.symbol === asset && links.some(l => String(l.accountId) === String(p.accountId)))
            positionGone = match.length === 0
        }

        if (!positionGone) {
            console.log(`  SKIP  ${setup.id} (${asset}) — paper position is still open`)
            continue
        }

        console.log(`  FIX   ${setup.id} (${asset}) — paper position gone, entity stuck at '${setup.status}'`)

        if (APPLY) {
            await coll.updateOne(
                { id: setup.id, status: { $in: LIVE_POSITION } },
                { $set: { status: 'closed', closedReason: 'manual', closedAt: Date.now() } },
            )
            fixed++
        }
    }

    if (!APPLY) {
        console.log(`\nDRY RUN — run with --apply to write. ${stuck.length} setup(s) checked.`)
    } else {
        console.log(`\nFixed ${fixed} stuck setup(s).`)
    }

    process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
