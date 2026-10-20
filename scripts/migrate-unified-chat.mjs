#!/usr/bin/env node
// Unified chat, phase 9 — the legacy chat stores move onto the new model (docs/design/unified-chat-plan.md §11).
// What moves where, and why, is in services/migrations/unifiedChat.migration.js.
//
//   node scripts/migrate-unified-chat.mjs                 # DRY RUN on this process's database (DB_NAME)
//   node scripts/migrate-unified-chat.mjs --apply         # back up, then do it
//   node scripts/migrate-unified-chat.mjs --db test       # another database by name (dry run)
//   node scripts/migrate-unified-chat.mjs --db test --apply --yes-not-my-db
//   node scripts/migrate-unified-chat.mjs --restore backups/unified-chat-axl_dev-<stamp>.json   # undo an apply
//
// BACKUP FIRST (Roy, 2026-10-20): --apply writes every document it will change or delete to
// backups/unified-chat-<db>-<stamp>.json (EJSON — ids and types survive), reads it back, and only then writes.
// Idempotent: a re-run skips what is already moved. Order on prod (the deploy runbook): rename-portfolio-books.mjs
// FIRST — this script refuses while `portfolio_chats` still holds the books — then a dry run, then --apply.
// Writing to a database other than this process's own needs --yes-not-my-db, said out loud.

import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BSON } from 'mongodb'
import { config } from '../services/config.js'

// Mongo's SRV lookup fails on this laptop's default resolver (the DNS pin every script here carries).
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, getDbName, getSiblingDb, closeDb } = await import('../providers/mongodb.provider.js')
const { makeAgentContextService } = await import('../services/agentContext.service.js')
const { makeSessionService } = await import('../services/session.service.js')
const { silentEvents } = await import('../services/sessionEvents.js')
const { migrateUnifiedChat, restoreUnifiedChat } = await import('../services/migrations/unifiedChat.migration.js')

const BACKUPS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backups')
const args    = process.argv.slice(2)
const flag    = (f) => args.includes(f)
const value   = (f) => (flag(f) ? args[args.indexOf(f) + 1] : null)
const apply   = flag('--apply')
const named   = value('--db')
const restore = value('--restore')

/** Write the snapshot, read it back whole, and say where it is. Throws — and so stops the run — on any failure. */
async function writeBackup(snapshot) {
    fs.mkdirSync(BACKUPS, { recursive: true })
    const file = path.join(BACKUPS, `unified-chat-${snapshot.db}-${snapshot.takenAt.replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(file, BSON.EJSON.stringify(snapshot, { relaxed: false }))
    const back = BSON.EJSON.parse(fs.readFileSync(file, 'utf8'), { relaxed: false })
    const count = (s) => Object.values(s).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
    if (count(back) !== count(snapshot)) throw new Error(`backup read back ${count(back)} documents of ${count(snapshot)}`)
    console.log(`[migrate-unified-chat] backup: ${file} (${count(back)} documents, ${(fs.statSync(file).size / 1e6).toFixed(2)} MB)`)
    return { file, documents: count(back) }
}

async function run() {
    const own = getDbName()
    const db  = named && named !== own ? await getSiblingDb(named) : await getDb()
    const writes = apply || restore
    if (writes && db.databaseName !== own && !flag('--yes-not-my-db')) {
        console.log(`[migrate-unified-chat] refusing to WRITE to "${db.databaseName}" (this process is on "${own}") without --yes-not-my-db`)
        return
    }
    if (restore) {
        const snapshot = BSON.EJSON.parse(fs.readFileSync(restore, 'utf8'), { relaxed: false })
        if (snapshot.db !== db.databaseName) { console.log(`[migrate-unified-chat] that backup is of "${snapshot.db}", not "${db.databaseName}"`); return }
        console.log('[migrate-unified-chat] RESTORE from', restore, JSON.stringify(await restoreUnifiedChat({ db, snapshot })))
        return
    }
    const getThis  = async () => db
    const contexts = makeAgentContextService({ getDb: getThis })
    const sessions = makeSessionService({ getDb: getThis, events: silentEvents })
    await contexts.ensureIndexes()
    console.log(`[migrate-unified-chat] db=${db.databaseName} ${apply ? 'APPLY' : 'DRY RUN'}`)
    const report = await migrateUnifiedChat({ db, contexts, sessions, apply, backup: writeBackup, log: (l) => console.log(`  ${l}`) })
    console.log(JSON.stringify(report, null, 2))
}

try { await run() } catch (err) { console.error('[migrate-unified-chat] failed — nothing past the failure was written:', err); process.exitCode = 1 } finally { await closeDb() }
