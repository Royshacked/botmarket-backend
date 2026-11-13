// Merge every role's social-chat thread into the user's ONE thread with Axl — 2026-11-13 (docs/design/one-axl.md D8).
//
// Until one-axl, each desk posted its cards into its own bot DM (the user ↔ 'mentor', ↔ 'portfolio', ↔ 'analyst' …).
// Since then postBotCard posts every card into the user's thread with Axl and keeps the role's bot as the SENDER (the
// client writes "Axl · Trader" from it; getMessages keeps an admin-only role's cards from a non-admin). This moves the
// cards already posted, so the old threads do not linger in the sidebar beside the new one:
//
//   • for each conversation between a user and a live non-Axl bot (chat.service BOT_IDS minus 'axl'):
//       – the user's Axl thread is found, or created;
//       – its messages move into it (conversationId rewritten; sender, status, actions untouched);
//       – the Axl thread's lastMessageAt / lastMessage take the newest message of the two;
//       – the old conversation is deleted.
//   • RETIRED bots' threads ('idea', 'kairos') are left alone — already hidden, real history.
//
// Every conversation touched and the ids of every message moved go to backups/merge-bot-threads-<db>-<stamp>.json
// first (backups/ is gitignored), so a move can be reversed by rewriting conversationId back.
// DRY RUN by default.
//
//   node scripts/merge-bot-threads.mjs                       # local DB_NAME, dry run
//   node scripts/merge-bot-threads.mjs --apply
//   DB_NAME=test node scripts/merge-bot-threads.mjs --apply  # prod

import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb, closeDb } from '../providers/mongodb.provider.js'
import { config } from '../services/config.js'
import { CONVS, MSGS, BOT_IDS, BOT_USER_ID } from '../api/chat/chat.service.js'

if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const apply = process.argv.includes('--apply')
const ROLE_BOTS = BOT_IDS.filter(b => b !== BOT_USER_ID)

const db = await getDb()
const roleConvs = await db.collection(CONVS).find({ participants: { $in: ROLE_BOTS } }).toArray()

const plan = []
for (const c of roleConvs) {
    const user = c.participants.find(p => !BOT_IDS.includes(p))
    if (!user) continue   // a bot ↔ bot thread should not exist; never guess
    const messages = await db.collection(MSGS).find({ conversationId: c.id }, { projection: { _id: 0, id: 1, createdAt: 1, content: 1 } }).toArray()
    plan.push({ conv: c, user, bot: c.participants.find(p => ROLE_BOTS.includes(p)), messages })
}

console.log(`${config.dbName ?? process.env.DB_NAME}: ${plan.length} role thread(s), ${plan.reduce((n, p) => n + p.messages.length, 0)} message(s) to move`)
for (const p of plan) console.log(`  ${p.user} ↔ ${p.bot}: ${p.messages.length} message(s) (${p.conv.id})`)

if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply.')
    await closeDb()
    process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '..', 'backups')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `merge-bot-threads-${process.env.DB_NAME ?? 'db'}-${Date.now()}.json`)
fs.writeFileSync(file, JSON.stringify(plan.map(p => ({ conv: p.conv, messageIds: p.messages.map(m => m.id) })), null, 2))
console.log(`backup → ${file}`)

let moved = 0
for (const p of plan) {
    const participants = [p.user, BOT_USER_ID].sort()
    let axl = await db.collection(CONVS).findOne({ participants })
    if (!axl) {
        axl = { id: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, participants, createdAt: p.conv.createdAt ?? Date.now(), lastMessageAt: 0, lastMessage: '' }
        await db.collection(CONVS).insertOne({ ...axl })
    }
    const res = await db.collection(MSGS).updateMany({ conversationId: p.conv.id }, { $set: { conversationId: axl.id } })
    moved += res.modifiedCount ?? 0
    const newest = p.messages.reduce((m, x) => (!m || (x.createdAt ?? 0) > (m.createdAt ?? 0) ? x : m), null)
    if (newest && (newest.createdAt ?? 0) > (axl.lastMessageAt ?? 0)) {
        await db.collection(CONVS).updateOne({ id: axl.id }, { $set: { lastMessageAt: newest.createdAt, lastMessage: String(newest.content ?? '').slice(0, 120) } })
    }
    await db.collection(CONVS).deleteOne({ id: p.conv.id })
}
console.log(`moved ${moved} message(s); ${plan.length} role thread(s) deleted`)
await closeDb()
