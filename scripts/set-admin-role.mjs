// Set role:'admin' on a user by username. THE admin-promotion script — promote-admin.js did the
// same write without the dry run and was deleted 2026-09-16.
//
//   node scripts/set-admin-role.mjs <username>            # dry run — prints what would change
//   node scripts/set-admin-role.mjs <username> --apply    # writes the update
//
import { getDb, closeDb } from '../providers/mongodb.provider.js'
import { COLLECTION } from '../api/user/user.model.js'

const username = process.argv[2]
if (!username) {
    console.error('Usage: node scripts/set-admin-role.mjs <username> [--apply]')
    process.exit(1)
}
const APPLY = process.argv.includes('--apply')

const db   = await getDb()
const user = await db.collection(COLLECTION).findOne({ username })

if (!user) {
    console.error(`No user found with username "${username}"`)
    await closeDb(); process.exit(1)
}

console.log(`\nUser: ${user.username} (${user.fullname})`)
console.log(`Current role: ${user.role ?? '(unset)'}`)
console.log(`New role:     admin`)

if (!APPLY) {
    console.log('\nDry run — pass --apply to write.\n')
    await closeDb(); process.exit(0)
}

await db.collection(COLLECTION).updateOne({ username }, { $set: { role: 'admin', updatedAt: Date.now() } })
console.log('\nDone.\n')
await closeDb()
