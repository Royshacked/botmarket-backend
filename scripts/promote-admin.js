/**
 * One-off: promote a user to admin role.
 * Usage:  node scripts/promote-admin.js roy_shacked
 */
import 'dotenv/config'
import { getDb, closeDb } from '../providers/mongodb.provider.js'
import { COLLECTION } from '../api/user/user.model.js'

const username = process.argv[2]
if (!username) { console.error('Usage: node scripts/promote-admin.js <username>'); process.exit(1) }

const db = await getDb()
const result = await db.collection(COLLECTION).findOneAndUpdate(
    { username },
    { $set: { role: 'admin', updatedAt: Date.now() } },
    { returnDocument: 'after', projection: { username: 1, role: 1 } }
)

if (!result) { console.error(`User "${username}" not found`); await closeDb(); process.exit(1) }
console.log(`✓ ${result.username} → role: ${result.role}`)
await closeDb()
