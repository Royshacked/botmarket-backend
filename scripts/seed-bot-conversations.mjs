/**
 * One-off script: seed the bot conversation for all existing users.
 * Safe to run multiple times — getOrCreateConversation is idempotent.
 *
 * Usage: node scripts/seed-bot-conversations.mjs
 */
import 'dotenv/config'
import { getDb }              from '../providers/mongodb.provider.js'
import { seedBotConversation } from '../api/chat/chat.service.js'

const db    = await getDb()
const users = await db.collection('users').find({}, { projection: { id: 1, username: 1 } }).toArray()

console.log(`Seeding bot conversations for ${users.length} users...`)

for (const user of users) {
    try {
        await seedBotConversation(user.id)
        console.log(`  ✓ ${user.username} (${user.id})`)
    } catch (err) {
        console.error(`  ✗ ${user.username}: ${err.message}`)
    }
}

console.log('Done.')
process.exit(0)
