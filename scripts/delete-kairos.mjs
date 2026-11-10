// Delete what Kairos (the `call` desk) and Hermes (its monitor) left in Mongo — 2026-11-10.
//
// Kairos was archived on 2026-08-18 and DELETED on 2026-11-10 (Roy: "delete all kairos", data
// included). The code is gone from both repos; this removes the documents nothing reads any more:
//
//   • entities kind:'call'                 — the calls themselves (frozen since August)
//   • entities with a callId               — a call's execution idea (ownedBy:'hermes'), hidden from
//                                            the ideas list. REFUSED if any is a live position: the
//                                            order and its stop would stay at the broker, unwatched.
//   • the `kairos_calls` collection        — the pre-entities backup copy (P3a)
//   • chat_messages from senderId 'kairos' — the call cards (entry confirm, manage, expiry)
//   • chat_conversations with 'kairos'     — the bot DM those cards lived in
//   • users.preferences                    — `hermesModel` and `hermesRoutingMode` dropped (nothing reads
//                                            either); `hermesReasoning` renamed `talosReasoning`, the
//                                            effort cap Talos still reads (monitoring/assess.shared.js)
//
// Everything deleted is written to backups/kairos-<db>-<stamp>.json first (backups/ is gitignored).
// DRY RUN by default.
//
//   node scripts/delete-kairos.mjs                       # local DB_NAME, dry run
//   node scripts/delete-kairos.mjs --apply
//   DB_NAME=test node scripts/delete-kairos.mjs --apply  # prod

import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb, closeDb } from '../providers/mongodb.provider.js'
import { ENTITIES } from '../services/entity/entityCollection.js'
import { config } from '../services/config.js'
import { LIVE_POSITION } from '../services/entity/vocabulary.js'

if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const apply = process.argv.includes('--apply')
const BOT = 'kairos'
const LEGACY_SOURCE = 'kairos_calls'

const db = await getDb()
const cols = new Set((await db.listCollections().toArray()).map(c => c.name))

const entityQuery = { $or: [{ kind: 'call' }, { callId: { $nin: [null, undefined] } }] }
const entities = await db.collection(ENTITIES).find(entityQuery).toArray()
const legacy = cols.has(LEGACY_SOURCE) ? await db.collection(LEGACY_SOURCE).find({}).toArray() : []
const messages = await db.collection('chat_messages').find({ senderId: BOT }).toArray()
const conversations = await db.collection('chat_conversations').find({ participants: BOT }).toArray()
const prefUsers = await db.collection('users').find(
    { $or: [{ 'preferences.hermesModel': { $exists: true } }, { 'preferences.hermesReasoning': { $exists: true } }, { 'preferences.hermesRoutingMode': { $exists: true } }] },
    { projection: { id: 1, preferences: 1 } },
).toArray()

console.log(`DB "${db.databaseName}"`)
console.log(`  entities           ${entities.length}`)
for (const e of entities) console.log(`      ${e.kind} · ${e.asset ?? '?'} · ${e.status ?? '?'} · ${e.id}${e.callId ? ` (call ${e.callId})` : ''}`)
console.log(`  ${LEGACY_SOURCE}       ${cols.has(LEGACY_SOURCE) ? legacy.length : 'absent'}`)
console.log(`  chat_messages      ${messages.length}`)
console.log(`  chat_conversations ${conversations.length}`)
console.log(`  users (prefs)      ${prefUsers.length}`)

const live = entities.filter(e => LIVE_POSITION.includes(e.status))
if (live.length) {
    console.log(`\nREFUSED: ${live.length} of these is an OPEN POSITION (${live.map(e => e.asset).join(', ')}). Close it at the broker first.`)
    await closeDb?.()
    process.exit(1)
}

if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply.')
    await closeDb?.()
    process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '..', 'backups')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `kairos-${db.databaseName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(file, JSON.stringify({ entities, [LEGACY_SOURCE]: legacy, chat_messages: messages, chat_conversations: conversations, users: prefUsers }, null, 1))
console.log(`\nBackup → ${file}`)

const del = (col, q) => db.collection(col).deleteMany(q).then(r => console.log(`  ${col}: deleted ${r.deletedCount}`))
await del(ENTITIES, entityQuery)
await del('chat_messages', { senderId: BOT })
await del('chat_conversations', { participants: BOT })
if (cols.has(LEGACY_SOURCE)) { await db.collection(LEGACY_SOURCE).drop(); console.log(`  ${LEGACY_SOURCE}: dropped`) }

// Rename only where the new key is not already set — a client that already wrote `talosReasoning` wins.
const renamed = await db.collection('users').updateMany(
    { 'preferences.hermesReasoning': { $exists: true }, 'preferences.talosReasoning': { $exists: false } },
    { $rename: { 'preferences.hermesReasoning': 'preferences.talosReasoning' } },
)
const unset = await db.collection('users').updateMany(
    { $or: [{ 'preferences.hermesModel': { $exists: true } }, { 'preferences.hermesReasoning': { $exists: true } }, { 'preferences.hermesRoutingMode': { $exists: true } }] },
    { $unset: { 'preferences.hermesModel': '', 'preferences.hermesReasoning': '', 'preferences.hermesRoutingMode': '' } },
)
console.log(`  users: renamed hermesReasoning on ${renamed.modifiedCount}, dropped hermes keys on ${unset.modifiedCount}`)

await closeDb?.()
process.exit(0)
