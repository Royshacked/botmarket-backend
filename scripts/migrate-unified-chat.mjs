#!/usr/bin/env node
// Unified chat, phase 9 — the legacy chat stores move onto the new model (docs/design/unified-chat-plan.md §11).
// What moves where, and why, is in services/migrations/unifiedChat.migration.js.
//
//   node scripts/migrate-unified-chat.mjs                 # DRY RUN on this process's database (DB_NAME)
//   node scripts/migrate-unified-chat.mjs --apply         # do it
//   node scripts/migrate-unified-chat.mjs --db test       # another database by name (dry run)
//   node scripts/migrate-unified-chat.mjs --db test --apply --yes-not-my-db
//
// Idempotent: a re-run skips what is already moved. Order on prod (the deploy runbook): rename-portfolio-books.mjs
// FIRST — this script refuses while `portfolio_chats` still holds the books — then a dry run, then --apply.
// Writing to a database other than this process's own needs --yes-not-my-db, said out loud.

import dns from 'node:dns'
import { config } from '../services/config.js'

// Mongo's SRV lookup fails on this laptop's default resolver (the DNS pin every script here carries).
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, getDbName, getSiblingDb, closeDb } = await import('../providers/mongodb.provider.js')
const { makeAgentContextService } = await import('../services/agentContext.service.js')
const { makeSessionService } = await import('../services/session.service.js')
const { silentEvents } = await import('../services/sessionEvents.js')
const { migrateUnifiedChat } = await import('../services/migrations/unifiedChat.migration.js')

const args  = process.argv.slice(2)
const apply = args.includes('--apply')
const named = args.includes('--db') ? args[args.indexOf('--db') + 1] : null

async function run() {
    const own = getDbName()
    const db  = named && named !== own ? await getSiblingDb(named) : await getDb()
    if (apply && db.databaseName !== own && !args.includes('--yes-not-my-db')) {
        console.log(`[migrate-unified-chat] refusing to WRITE to "${db.databaseName}" (this process is on "${own}") without --yes-not-my-db`)
        return
    }
    const getThis   = async () => db
    const contexts  = makeAgentContextService({ getDb: getThis })
    const sessions  = makeSessionService({ getDb: getThis, events: silentEvents })
    await contexts.ensureIndexes()
    console.log(`[migrate-unified-chat] db=${db.databaseName} ${apply ? 'APPLY' : 'DRY RUN'}`)
    const report = await migrateUnifiedChat({ db, contexts, sessions, apply, log: (l) => console.log(`  ${l}`) })
    console.log(JSON.stringify(report, null, 2))
}

try { await run() } catch (err) { console.error('[migrate-unified-chat] failed:', err); process.exitCode = 1 } finally { await closeDb() }
