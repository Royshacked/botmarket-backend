// Set role:'admin' on a user by username.
//
//   node scripts/set-admin-role.mjs <username>            # dry run — prints what would change
//   node scripts/set-admin-role.mjs <username> --apply    # writes the update
//
import { getDb } from '../providers/mongodb.provider.js'

const username = process.argv[2]
if (!username) {
    console.error('Usage: node scripts/set-admin-role.mjs <username> [--apply]')
    process.exit(1)
}
const APPLY = process.argv.includes('--apply')

const db   = await getDb()
const user = await db.collection('users').findOne({ username })

if (!user) {
    console.error(`No user found with username "${username}"`)
    process.exit(1)
}

console.log(`\nUser: ${user.username} (${user.fullname})`)
console.log(`Current role: ${user.role ?? '(unset)'}`)
console.log(`New role:     admin`)

if (!APPLY) {
    console.log('\nDry run — pass --apply to write.\n')
    process.exit(0)
}

await db.collection('users').updateOne({ username }, { $set: { role: 'admin' } })
console.log('\nDone.\n')
process.exit(0)
