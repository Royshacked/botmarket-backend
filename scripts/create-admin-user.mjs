// Create a new admin user.
//
//   node scripts/create-admin-user.mjs <username> <fullname> <password>
//
// Rides userService.createUser — the ONE way an account comes to exist (it validates the fields,
// refuses a taken name and seeds Axl's welcome) — then sets the role. This used to re-implement the
// insert by hand against a raw 'users' string, with none of that.
import { getDb, closeDb } from '../providers/mongodb.provider.js'
import { COLLECTION } from '../api/user/user.model.js'
import { userService } from '../api/user/user.service.js'

const [username, fullname, password] = process.argv.slice(2)
if (!username || !fullname || !password) {
    console.error('Usage: node scripts/create-admin-user.mjs <username> <fullname> <password>')
    process.exit(1)
}

try {
    const user = await userService.createUser({ username, fullname, password })
    const db = await getDb()
    await db.collection(COLLECTION).updateOne({ id: user.id }, { $set: { role: 'admin', updatedAt: Date.now() } })
    console.log(`\nCreated admin user: ${username} (${fullname})\n`)
} catch (err) {
    console.error(`\n${err.message}\n`)
    await closeDb(); process.exit(1)
}
await closeDb()
