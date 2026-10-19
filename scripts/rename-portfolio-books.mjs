#!/usr/bin/env node
// Rename `portfolio_chats` → `portfolio_books` (unified-chat plan §1 q3, phase 3). The document is the
// BOOK — lifecycle, mandate, thesis, reviews, fingerprint, Themis state — and the code reads it by the
// new name (api/portfolio/portfolioChat.service.js COLLECTION) from this commit on.
//
//   node scripts/rename-portfolio-books.mjs            # this process's database (DB_NAME)
//
// Idempotent: moves the documents (same _ids) when the old collection exists and the new one is absent
// or EMPTY (the new code creates it at startup while building its index), verifies the count, then drops
// the old one; a non-empty new one is reported and left alone, because then someone has to look, not a
// script to guess. Run on
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

    if (!hasOld) {
        console.log(hasNew ? '[rename-portfolio-books] already moved — nothing to do'
                           : '[rename-portfolio-books] neither exists — nothing to do (a fresh database)')
    } else {
        // COPY, VERIFY, THEN DROP — not renameCollection: the client runs the Stable API strictly
        // (providers/mongodb.provider.js) and renameCollection is not in API Version 1.
        //
        // The new code creates `portfolio_books` (empty) the moment it builds its index at startup — a
        // server on this branch that started before the script ran. An EMPTY one holds nothing and is
        // filled here. A non-empty one means writes landed in both, and a person has to look.
        const newCount = hasNew ? await db.collection(NEW).countDocuments() : 0
        if (newCount > 0) {
            console.log(`[rename-portfolio-books] BOTH exist and ${NEW} holds ${newCount} document(s) — left alone. Inspect before merging by hand.`)
            process.exitCode = 1
            return
        }
        const docs = await db.collection(OLD).find({}).toArray()
        if (docs.length) await db.collection(NEW).insertMany(docs, { ordered: true })
        const copied = await db.collection(NEW).countDocuments()
        if (copied !== docs.length) {
            console.log(`[rename-portfolio-books] copy MISMATCH (${docs.length} read, ${copied} in ${NEW}) — ${OLD} kept. Inspect.`)
            process.exitCode = 1
            return
        }
        await db.collection(OLD).drop()
        console.log(`[rename-portfolio-books] moved ${docs.length} document(s) ${OLD} → ${NEW} (same _ids), dropped ${OLD}`)
    }

    // The unique key every read and write uses. Fails loudly if duplicates exist rather than hiding them.
    await db.collection(NEW).createIndex({ portfolioId: 1, userId: 1 }, { unique: true })
    console.log(`[rename-portfolio-books] index { portfolioId, userId } unique — ok`)
}

run()
    .catch(err => { console.error('[rename-portfolio-books] failed:', err?.message ?? err); process.exitCode = 1 })
    .finally(() => closeDb())
