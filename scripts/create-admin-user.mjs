// Create a new admin user.
//
//   node scripts/create-admin-user.mjs <username> <fullname> <password>
//
import { getDb } from '../providers/mongodb.provider.js'
import { buildUserDoc } from '../api/user/user.model.js'

const [username, fullname, password] = process.argv.slice(2)
if (!username || !fullname || !password) {
    console.error('Usage: node scripts/create-admin-user.mjs <username> <fullname> <password>')
    process.exit(1)
}

const db = await getDb()

const existing = await db.collection('users').findOne({ username })
if (existing) {
    console.error(`User "${username}" already exists.`)
    process.exit(1)
}

const doc = await buildUserDoc({ username, fullname, password })
doc.role = 'admin'

await db.collection('users').insertOne(doc)
console.log(`\nCreated admin user: ${username} (${fullname})\n`)
process.exit(0)
