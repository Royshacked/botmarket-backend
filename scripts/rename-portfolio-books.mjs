#!/usr/bin/env node
// Rename `portfolio_chats` → `portfolio_books` (unified-chat plan §1 q3, phase 3). The document is the
// BOOK — lifecycle, mandate, thesis, reviews, fingerprint, Themis state — and the code reads it by the
// new name (api/portfolio/portfolioChat.service.js COLLECTION) from this commit on.
//
//   node scripts/rename-portfolio-books.mjs            # this process's database (DB_NAME)
//
// Idempotent: renames only when the old name exists and the new one does not; anything else is
// reported and left alone (both present means someone has to look, not a script to guess). Run on
// axl_dev with phase 3, on prod in the deploy runbook BEFORE the new code serves traffic — the old
// code would keep writing the old name.

import dns from 'node:dns'
import { config } from '../services/config.js'

// Mongo's SRV lookup fails on this laptop's default resolver (the DNS pin every script here carries).
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, getDbName, closeDb } = await import('../providers/mongodb.provider.js')
const { COLLECTION } = await import('../api/portfolio/portfolioChat.service.js')

const OLD = 'portfolio_chats'
const NEW = COLLECTION

async function run() {
    const db    = await getDb()
    const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name))
    const hasOld = names.has(OLD), hasNew = names.has(NEW)
    console.log(`[rename-portfolio-books] db=${getDbName()} ${OLD}=${hasOld} ${NEW}=${hasNew}`)

    if (hasOld && !hasNew) {
        const n = await db.collection(OLD).countDocuments()
        await db.collection(OLD).rename(NEW)
        console.log(`[rename-portfolio-books] renamed ${OLD} → ${NEW} (${n} document(s))`)
    } else if (!hasOld && hasNew) {
        console.log('[rename-portfolio-books] already renamed — nothing to do')
    } else if (hasOld && hasNew) {
        console.log(`[rename-portfolio-books] BOTH exist — left alone. Inspect before merging by hand.`)
        process.exitCode = 1
        return
    } else {
        console.log('[rename-portfolio-books] neither exists — nothing to do (a fresh database)')
    }

    // The unique key every read and write uses. Fails loudly if duplicates exist rather than hiding them.
    await db.collection(NEW).createIndex({ portfolioId: 1, userId: 1 }, { unique: true })
    console.log(`[rename-portfolio-books] index { portfolioId, userId } unique — ok`)
}

run()
    .catch(err => { console.error('[rename-portfolio-books] failed:', err?.message ?? err); process.exitCode = 1 })
    .finally(() => closeDb())
