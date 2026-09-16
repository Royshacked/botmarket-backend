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
import { seedBotConversation } from '../api/chat/chat.service.js'

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
    // createUser fires seedBotConversation but does not await it — in the server that is fine (the
    // process lives on), but a script that closes the client and exits would cut the welcome writes
    // off mid-flight. Awaiting it here makes the welcome the header promises actually land; it is
    // idempotent, so racing createUser's own call produces exactly one welcome.
    await seedBotConversation(user.id).catch(() => {})
    console.log(`\nCreated admin user: ${username} (${fullname})\n`)
} catch (err) {
    console.error(`\nUser "${username}" was created but could NOT be promoted: ${err.message}`)
    console.error(`Run:  node scripts/set-admin-role.mjs ${username} --apply\n`)
    await closeDb(); process.exit(1)
}
await closeDb()
