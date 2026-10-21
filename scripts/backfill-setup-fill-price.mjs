/**
 * Re-stamp an open setup's entry with what the broker ACTUALLY filled (2026-10-21).
 *
 * WHY. Talos wrote `position_state.entry.fill_price` from the PLAN's entry leg, never from the
 * broker. A confirmed entry goes out at market, so every setup confirmed off its level carries a
 * price nobody paid — EXPD stored 196 for a 198.81 fill, and its R, MAE/MFE and every in-position
 * read were measured from it. The monitor reads the broker now (positionManage.brokerEntryPrice);
 * this corrects the positions stamped before that.
 *
 * The SAME read the monitor makes, so the two cannot disagree. A broker this script cannot reach
 * (a cTrader account whose session lives in the server) is reported and left alone, as is a
 * position scaled in over several legs — its legs each have their own price, and re-pricing them
 * from one average would be inventing a history. Anything it would change is printed first.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   node scripts/backfill-setup-fill-price.mjs
 *   node scripts/backfill-setup-fill-price.mjs --apply
 *   DB_NAME=test node scripts/backfill-setup-fill-price.mjs --apply   # prod
 */

import dns from 'node:dns'
import { config } from '../services/config.js'

// Mongo's SRV lookup fails on this laptop's default resolver (docs: the DNS pin every script here
// carries). Harmless where it already worked.
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb } = await import('../providers/mongodb.provider.js')
const { ENTITIES } = await import('../services/entity/entityCollection.js')
const { LIVE_POSITION } = await import('../services/entity/vocabulary.js')
const { brokerEntryPrice } = await import('../services/positionManage.service.js')

const apply = process.argv.includes('--apply')
const line  = (s = '') => console.log(s)
// Below a cent is rounding, not a wrong fill.
const SAME = 0.005

const db   = await getDb()
const docs = await db.collection(ENTITIES).find({
    kind: 'setup',
    status: { $in: LIVE_POSITION },
    'position_state.entry.fill_at': { $ne: null },
}).project({ _id: 0, id: 1, userId: 1, asset: 1, accounts: 1, brokerOrders: 1, basisOffset: 1, position_state: 1 }).toArray()

line(`\nSETUP FILL-PRICE BACKFILL — db "${db.databaseName}"${apply ? '' : '   (dry run)'}\n`)
line(`open setups with a stamped entry: ${docs.length}`)

const changes = [], unreached = [], scaled = []
for (const d of docs) {
    const legs = d.position_state?.entry?.legs ?? []
    if (legs.length > 1) { scaled.push(d.asset); continue }

    const paid = await brokerEntryPrice(d).catch(() => null)
    if (paid == null) { unreached.push(d.asset); continue }

    const stored = Number(d.position_state?.entry?.fill_price)
    if (Number.isFinite(stored) && Math.abs(paid - stored) < SAME) continue

    const rounded = Math.round(paid * 1e6) / 1e6
    const $set = { 'position_state.entry.fill_price': rounded }
    if (legs.length === 1) $set['position_state.entry.legs.0.price'] = rounded
    changes.push({ id: d.id, asset: d.asset, stored, $set })
    line(`  ${String(d.asset).padEnd(6)} ${d.id}   stored ${Number.isFinite(stored) ? stored : '—'} -> paid ${rounded}`)
}

if (scaled.length)    line(`\n· ${scaled.length} scaled-in position(s) left alone (one price per leg): ${scaled.join(', ')}`)
if (unreached.length) line(`\n! no broker answer for ${unreached.length} position(s) — left as they are: ${unreached.join(', ')}`)

if (!changes.length) { line('\nEvery reachable entry already matches its fill. Nothing to do.\n'); process.exit(0) }
if (!apply) { line(`\nDry run — ${changes.length} setup(s) would be corrected. Re-run with --apply.\n`); process.exit(0) }

let written = 0
for (const c of changes) {
    const res = await db.collection(ENTITIES).updateOne({ id: c.id, kind: 'setup' }, { $set: c.$set })
    if (res.matchedCount === 1) written++
    else line(`  ! ${c.asset}: no setup matched id ${c.id}`)
}

line(`\n✓ CORRECTED ${written} setup entr${written === 1 ? 'y' : 'ies'}.\n`)
process.exit(0)
