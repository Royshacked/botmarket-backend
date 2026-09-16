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

let user
try {
    user = await userService.createUser({ username, fullname, password })
} catch (err) {
    console.error(`\n${err.message}\n`)
    await closeDb(); process.exit(1)
}

// The account exists now. From here a failure leaves a TRADER, not nothing — so it says how to
// finish rather than exiting on an error the operator cannot retry through this script (createUser
// would 409 on the name the second time).
try {
    const db = await getDb()
    await db.collection(COLLECTION).updateOne({ id: user.id }, { $set: { role: 'admin', updatedAt: Date.now() } })
    // createUser has already seeded Axl's welcome — and now AWAITS it, so it has landed by the time
    // we get here. No second call: getOrCreateConversation is a non-atomic find-then-insert, and a
    // duplicate call could race it into two welcomes.
    console.log(`\nCreated admin user: ${username} (${fullname})\n`)
} catch (err) {
    console.error(`\nUser "${username}" was created but could NOT be promoted: ${err.message}`)
    console.error(`Run:  node scripts/set-admin-role.mjs ${username} --apply\n`)
    await closeDb(); process.exit(1)
}
await closeDb()
