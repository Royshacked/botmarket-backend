/**
 * One-time migration: rename the social-chat bot user id 'ar2trade_bot' → 'axl'
 * across existing conversations and messages, so history stays attached after the
 * BOT_USER_ID constant change. Idempotent — safe to re-run.
 *
 * Run: node scripts/rename-bot-to-axl.mjs
 */
import 'dotenv/config'
import { getDb } from '../providers/mongodb.provider.js'

const OLD   = 'ar2trade_bot'
const NEW   = 'axl'
const CONVS = 'chat_conversations'
const MSGS  = 'chat_messages'

async function main() {
    const db = await getDb()

    // Conversations: replace the bot id AND re-sort the participants array.
    // Participants are stored sorted so [a,b] and [b,a] resolve to one doc; a
    // blind $set would leave the array unsorted and break getOrCreateConversation's
    // exact-array lookup for that user's bot thread. So re-sort per doc.
    const convs = await db.collection(CONVS).find({ participants: OLD }).toArray()
    let convCount = 0
    for (const c of convs) {
        const participants = c.participants.map(p => (p === OLD ? NEW : p)).sort()
        await db.collection(CONVS).updateOne({ _id: c._id }, { $set: { participants } })
        convCount++
    }

    // Messages: senderId rename is order-independent — bulk update.
    const msgRes = await db.collection(MSGS).updateMany(
        { senderId: OLD },
        { $set: { senderId: NEW } }
    )

    console.log(`Renamed ${OLD} → ${NEW}: ${convCount} conversations, ${msgRes.modifiedCount} messages`)
    process.exit(0)
}

main().catch(err => { console.error('migration failed', err); process.exit(1) })
