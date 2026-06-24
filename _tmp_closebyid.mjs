import 'dotenv/config'
import { getDb } from './providers/mongodb.provider.js'

const ID    = '1782288567440'
const APPLY = process.argv.includes('--apply')

const db   = await getDb()
const col  = db.collection('ideas')
const idea = await col.findOne({ id: ID })
if (!idea) { console.log(`NOT FOUND: ${ID}`); process.exit(0) }

console.log('BEFORE:', JSON.stringify({
    id: idea.id, userId: idea.userId, asset: idea.asset, brokerSymbol: idea.brokerSymbol,
    status: idea.status, direction: idea.direction, closedReason: idea.closedReason ?? null,
    brokerOrders: idea.brokerOrders, exitOrders: idea.exitOrders,
}, null, 2))

if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); process.exit(0) }
if (!['long', 'short', 'resting'].includes(idea.status)) {
    console.log(`\nNot active (status=${idea.status}) — leaving as-is.`); process.exit(0)
}

const now    = Date.now()
const orders = (idea.exitOrders ?? []).map(o =>
    o.status === 'working' ? { ...o, status: 'cancelled', cancelledAt: now } : o)

const res = await col.updateOne(
    { id: ID, status: { $in: ['long', 'short', 'resting'] } },
    { $set: { status: 'closed', closedReason: 'manual', closedAt: now, exitOrders: orders } },
)
console.log(`\nUpdated ${res.modifiedCount} doc(s).`)
const after = await col.findOne({ id: ID }, { projection: { status: 1, closedReason: 1, closedAt: 1, exitOrders: 1, _id: 0 } })
console.log('AFTER:', JSON.stringify(after, null, 2))
process.exit(0)
