/**
 * One-time fixup: the old bot welcome message ("Hi! I'm your ar2trade assistant…")
 * is stored as message CONTENT, which the ar2trade_bot→axl rename didn't touch. This
 * rewrites any Axl text message (and conversation preview) still containing "ar2trade"
 * to the current brand-neutral welcome. Idempotent — safe to re-run.
 *
 * Run: node scripts/refresh-axl-welcome.mjs
 */
import 'dotenv/config'
import { getDb } from '../providers/mongodb.provider.js'

const NEW_WELCOME = "Hi, I'm Axl — your trading assistant. I'll notify you here about portfolio reviews, position alerts, and anything that needs your attention, and you can ask me how the app works. Just message me."

async function main() {
    const db = await getDb()

    // Only Axl's own plain-text welcome messages carry "ar2trade" — notifications don't.
    const msgRes = await db.collection('chat_messages').updateMany(
        { senderId: 'axl', type: 'text', content: { $regex: 'ar2trade' } },
        { $set: { content: NEW_WELCOME } }
    )

    // Refresh the conversation-list preview where it mirrored the old welcome.
    const convRes = await db.collection('chat_conversations').updateMany(
        { lastMessage: { $regex: 'ar2trade' } },
        { $set: { lastMessage: NEW_WELCOME.slice(0, 120) } }
    )

    console.log(`Refreshed welcome: ${msgRes.modifiedCount} messages, ${convRes.modifiedCount} conversation previews`)
    process.exit(0)
}

main().catch(err => { console.error('fixup failed', err); process.exit(1) })
