import 'dotenv/config'
import { getDb } from './providers/mongodb.provider.js'

const db = await getDb()

const users = await db.collection('users')
    .find({}).project({ id: 1, username: 1, fullname: 1, _id: 0 }).toArray()
console.log('ALL USERS:', JSON.stringify(users, null, 2))

const active = await db.collection('ideas')
    .find({ status: { $in: ['long', 'short', 'resting'] } })
    .project({ id: 1, userId: 1, asset: 1, brokerSymbol: 1, status: 1, direction: 1, ordersPlacedAt: 1, _id: 0 })
    .toArray()
console.log('\nALL ACTIVE IDEAS:', JSON.stringify(active, null, 2))
process.exit(0)
