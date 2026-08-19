// Remove the MODE-LESS virtual-account docs, and the virtual state hanging off them (2026-08-19).
//
//   node scripts/drop-ghost-paper-accounts.mjs            # DRY RUN — prints the plan, writes nothing
//   node scripts/drop-ghost-paper-accounts.mjs --apply    # archives, then deletes
//
// WHAT A GHOST IS. `paperAccounts` docs written before accounts became multi-per-user: no `mode`,
// no `name`, and a suffix-less id (`paper-<userId>` rather than `<mode>-<userId>-<short>`). The
// app reads accounts through listAccounts({ mode }), so a doc without one is invisible to every
// surface that lists accounts — while still being findable by id, which is the bad half: positions
// and orders sit on an account the user cannot see, select, or close from.
//
// WHY IT IS SAFE TO DELETE. Their ids are not derivable from anything (they were only ever handed
// out by the pre-migration code), so nothing NEW can land on them; the equity snapshotter runs off
// OPEN positions (listActiveAccounts), so a ghost with none can never be written to again. The
// guard below still refuses any ghost holding an open position or a working order — the same
// refusal paperBroker.deleteAccount makes, for the same reason: cascade-wiping one would orphan a
// live idea at a dead accountId.
//
// WHY NOT deleteAccount(). Two things it cannot do here. It deletes the ACCOUNT with deleteOne,
// and a ghost id is DUPLICATED (the pre-migration code re-created it), so one copy would survive.
// And it takes no archive.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH. Entities whose `accounts[]` still name a ghost. They are
// closed ideas — history, not routing — and their workspace still derives correctly from the id's
// `paper-` prefix with no account doc behind it. Emptying a document's account binding is the one
// thing this must not do (see planAccountRebind): an empty binding is never an improvement on a
// stale one. They are listed at the end so the reference is on the record.

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'node:fs'
import { getDb } from '../providers/mongodb.provider.js'

const APPLY = process.argv.includes('--apply')

const ACCOUNTS  = 'paperAccounts'
const POSITIONS = 'paperPositions'
const ORDERS    = 'paperOrders'
const EQUITY    = 'paperEquity'
const VALID     = ['paper', 'manual']

const db = await getDb()

const ghosts = await db.collection(ACCOUNTS).find({ mode: { $nin: VALID } }).toArray()
if (!ghosts.length) {
    console.log('\nNo mode-less accounts found — nothing to do.\n')
    process.exit(0)
}

console.log(`\n${ghosts.length} mode-less account doc${ghosts.length === 1 ? '' : 's'}${APPLY ? '' : '   (DRY RUN — nothing will be written)'}\n`)

// Group by (userId, accountId): a ghost id may be duplicated, and the state hanging off it belongs
// to the ID, not to either copy of the doc.
const byKey = new Map()
for (const g of ghosts) {
    const key = `${g.userId}|${g.accountId}`
    if (!byKey.has(key)) byKey.set(key, { userId: g.userId, accountId: g.accountId, docs: [] })
    byKey.get(key).docs.push(g)
}

const archive = { at: new Date().toISOString(), accounts: [], positions: [], orders: [], equity: [] }
const plan    = []
let blocked   = 0

for (const { userId, accountId, docs } of byKey.values()) {
    const q = { userId, accountId }
    const [positions, orders, equity] = await Promise.all([
        db.collection(POSITIONS).find(q).toArray(),
        db.collection(ORDERS).find(q).toArray(),
        db.collection(EQUITY).find(q).toArray(),
    ])
    const open    = positions.filter(p => p.status === 'open').length
    const working = orders.filter(o => o.status === 'working').length

    console.log(`  ${accountId}   user ${userId}`)
    console.log(`     account docs ${docs.length}   cash ${docs.map(d => d.cashBalance ?? d.startingBalance ?? '—').join(' / ')}   enabled ${docs.map(d => !!d.enabled).join(' / ')}`)
    console.log(`     positions ${positions.length} (${open} OPEN)   orders ${orders.length} (${working} WORKING)   equity points ${equity.length}`)

    if (open > 0 || working > 0) {
        console.log(`     ! SKIPPED — holds ${open > 0 ? 'an open position' : 'a resting order'}; a live idea may be bound to it\n`)
        blocked++
        continue
    }

    archive.accounts.push(...docs)
    archive.positions.push(...positions)
    archive.orders.push(...orders)
    archive.equity.push(...equity)
    plan.push({ userId, accountId, counts: { accounts: docs.length, positions: positions.length, orders: orders.length, equity: equity.length } })
    console.log('')
}

const totals = plan.reduce((t, p) => ({
    accounts:  t.accounts  + p.counts.accounts,
    positions: t.positions + p.counts.positions,
    orders:    t.orders    + p.counts.orders,
    equity:    t.equity    + p.counts.equity,
}), { accounts: 0, positions: 0, orders: 0, equity: 0 })

console.log(`TO DELETE: ${totals.accounts} account docs · ${totals.positions} positions · ${totals.orders} orders · ${totals.equity} equity points`)
if (blocked) console.log(`SKIPPED:   ${blocked} account(s) still holding live virtual state`)

// On the record, never touched: documents still naming a ghost.
const refs = await db.collection('entities')
    .find({ accounts: { $in: plan.map(p => p.accountId) } }, { projection: { _id: 0, id: 1, kind: 1, status: 1, asset: 1, accounts: 1 } })
    .toArray()
if (refs.length) {
    console.log(`\n${refs.length} entit${refs.length === 1 ? 'y' : 'ies'} still name one of these accounts — LEFT AS THEY ARE (history, not routing):`)
    for (const r of refs) console.log(`   ${String(r.kind).padEnd(9)} ${String(r.status).padEnd(9)} ${String(r.asset).padEnd(8)} → ${JSON.stringify(r.accounts)}`)
}

if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to archive and delete.\n')
    process.exit(0)
}
if (!plan.length) {
    console.log('\nNothing deletable.\n')
    process.exit(0)
}

mkdirSync('data/archive', { recursive: true })
const file = `data/archive/ghost-paper-accounts-${archive.at.slice(0, 19).replace(/[:T]/g, '')}.json`
writeFileSync(file, JSON.stringify(archive, null, 2))
console.log(`\nArchived every document below to ${file}`)

for (const { userId, accountId } of plan) {
    const q = { userId, accountId }
    const [a, p, o, e] = await Promise.all([
        db.collection(ACCOUNTS).deleteMany(q),    // deleteMANY: a ghost id is duplicated
        db.collection(POSITIONS).deleteMany(q),
        db.collection(ORDERS).deleteMany(q),
        db.collection(EQUITY).deleteMany(q),
    ])
    console.log(`   deleted ${accountId}: ${a.deletedCount} accounts, ${p.deletedCount} positions, ${o.deletedCount} orders, ${e.deletedCount} equity`)
}

const left = await db.collection(ACCOUNTS).countDocuments({ mode: { $nin: VALID } })
console.log(`\nMode-less accounts remaining: ${left}\n`)
process.exit(0)
