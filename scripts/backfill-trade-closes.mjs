/**
 * Closes the `trades` rows left open by the captureClose bug (exit: null, 2026-08-09 on).
 *
 * Paper and manual only: their positions live in our own store, with the exit price, P&L and time.
 * The reason comes from the setup's closedReason, when one holds this position. Live rows are only
 * listed, because their truth is at the broker.
 *
 *   node scripts/backfill-trade-closes.mjs            lists what it would do, writes nothing
 *   node scripts/backfill-trade-closes.mjs --apply    writes
 *
 * Works on the database named by DB_NAME. Safe to rerun: it only touches rows still open.
 */
import dns from 'node:dns'
dns.setServers(['8.8.8.8', '1.1.1.1'])
import 'dotenv/config'
import { MongoClient } from 'mongodb'

const APPLY = process.argv.includes('--apply')
const client = new MongoClient(process.env.MONGODB_URI)
await client.connect()
const db = client.db(process.env.DB_NAME)
const trades = db.collection('trades')
console.log(`db ${db.databaseName}, ${APPLY ? 'WRITING' : 'dry run'}`)

const open = await trades.find({ status: 'open' }).toArray()
let fixed = 0
for (const t of open.filter(o => o.mode !== 'live')) {
    const position = await db.collection('paperPositions').findOne({ accountId: t.accountId, positionId: t.positionId })
    if (position?.status !== 'closed') continue
    const setup = await db.collection('entities').findOne(
        { 'exitOrders.positionId': t.positionId, status: 'closed' }, { projection: { id: 1, closedReason: 1 } })
    const reason = setup?.closedReason ?? null
    const pnl = position.realizedPnl ?? null
    console.log(`${t.symbol} ${t.accountId} closed ${new Date(position.closedAt).toISOString()} @ ${position.exitPrice} pnl ${pnl} reason ${reason ?? '-'}`)
    fixed++
    if (!APPLY) continue
    await trades.updateOne({ _id: t._id, status: 'open' }, {
        $set: {
            status: 'closed',
            closedAt: position.closedAt,
            exit: { price: position.exitPrice ?? null, ts: position.closedAt, reason, realizedPnl: pnl },
            exits: [...(t.exits ?? []), { orderId: null, price: position.exitPrice ?? null, ts: position.closedAt, reason, quantity: position.qty ?? null, realizedPnl: pnl }],
        },
    })
}
console.log(`${APPLY ? 'closed' : 'would close'} ${fixed} of ${open.length} open rows`)

const live = open.filter(o => o.mode === 'live')
console.log(`\n${live.length} live rows still open, not touched. Compare them with the broker:`)
for (const t of live) console.log(`  ${t.symbol} account ${t.accountId} position ${t.positionId} opened ${new Date(t.openedAt).toISOString().slice(0, 10)}`)
await client.close()
