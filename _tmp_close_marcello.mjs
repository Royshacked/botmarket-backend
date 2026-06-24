import 'dotenv/config'
import { getDb } from './providers/mongodb.provider.js'

const APPLY = process.argv.includes('--apply')
const ID    = process.argv.find(a => a.startsWith('--id='))?.slice(5) ?? null

const db = await getDb()

// Resolve marcello's userId(s)
const re    = new RegExp('marcello', 'i')
const users = await db.collection('users')
    .find({ $or: [{ username: re }, { fullname: re }] })
    .project({ id: 1, username: 1, fullname: 1, _id: 0 })
    .toArray()
console.log('USERS:', JSON.stringify(users, null, 2))

const userIds = users.map(u => u.id)

// Active (or resting) ideas for those users
const active = await db.collection('ideas')
    .find({ userId: { $in: userIds }, status: { $in: ['long', 'short', 'resting'] } })
    .project({ id: 1, userId: 1, asset: 1, brokerSymbol: 1, status: 1, direction: 1,
               brokerOrders: 1, exitOrders: 1, ordersPlacedAt: 1, _id: 0 })
    .toArray()
console.log('\nACTIVE IDEAS:', JSON.stringify(active, null, 2))

if (!APPLY) {
    console.log('\n(dry run — pass --apply --id=<ideaId> to close a specific idea)')
    process.exit(0)
}
if (!ID) { console.log('\n--apply requires --id=<ideaId>'); process.exit(1) }

const idea = active.find(i => i.id === ID)
if (!idea) { console.log(`\n${ID} is not an active idea for marcello — aborting.`); process.exit(1) }

const now    = Date.now()
const orders = (idea.exitOrders ?? []).map(o =>
    o.status === 'working' ? { ...o, status: 'cancelled', cancelledAt: now } : o)

const res = await db.collection('ideas').updateOne(
    { id: ID, status: { $in: ['long', 'short', 'resting'] } },
    { $set: { status: 'closed', closedReason: 'manual', closedAt: now, exitOrders: orders } },
)
console.log(`\nUpdated ${res.modifiedCount} doc(s).`)
const after = await db.collection('ideas').findOne({ id: ID }, { projection: { status: 1, closedReason: 1, closedAt: 1, exitOrders: 1, _id: 0 } })
console.log('AFTER:', JSON.stringify(after, null, 2))
process.exit(0)
