// Delete what the Aether event board left in Mongo — 2026-11-18.
//
// The event board (headline → selector → discovery → candidates → scorecard, the admin's Aether desk and its
// quick read) was unused and is DELETED on 2026-11-18 (Roy: "delete it like kairos, drop the data after
// export"). It is being replaced by the supply-chain simulator (docs/design/Event-Driven Supply Chain
// Simulator.docx). The code is gone from all three repos; this removes the documents nothing reads any more:
//
//   • the engine's event collections   — runs, candidates, scorecard, news queue, ticker facts, prices,
//                                         run usage, scheduler claims (whichever exist in this DB)
//   • aether_candidate_reads            — Prometheus's quick reads (the backend owned this one)
//   • aether_opportunities, _exposures  — the channel engine's leftovers, readerless since 2026-09-09
//   • sessions scope:'aether'           — the admin's Aether desk chat, with its session_messages
//   • threads agent:'aether'            — its saved drafts
//
// Pythia's engine collections (industry_*, fund_holdings, geopolitical_risk, fin_statements, …) are NOT
// touched: they never carried the aether_ prefix.
//
// Everything deleted is written to backups/aether-events-<db>-<stamp>/ first, one JSON file per collection
// (backups/ is gitignored), and the scorecard's last tally is printed — the only forward-tested result on
// event exposure the board produced. DRY RUN by default.
//
//   node scripts/delete-aether-events.mjs                       # local DB_NAME, dry run
//   node scripts/delete-aether-events.mjs --apply
//   DB_NAME=test node scripts/delete-aether-events.mjs --apply  # prod

import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb, closeDb } from '../providers/mongodb.provider.js'
import { config } from '../services/config.js'

if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const apply = process.argv.includes('--apply')

export const EVENT_COLLECTIONS = Object.freeze([
    'aether_event_runs', 'aether_event_candidates', 'aether_scorecard', 'aether_news_queue',
    'aether_ticker_facts', 'aether_prices', 'aether_run_usage', 'aether_scheduler_runs',
    'aether_candidate_reads',
    // The channel engine's last two (deleted 2026-09-09); nothing has read or written them since.
    'aether_opportunities', 'aether_exposures',
])
const SCOPE = 'aether'

const db = await getDb()
const cols = new Set((await db.listCollections().toArray()).map(c => c.name))
const present = EVENT_COLLECTIONS.filter(c => cols.has(c))
const strayPrefixed = [...cols].filter(c => c.startsWith('aether_') && !EVENT_COLLECTIONS.includes(c))

const sessions = await db.collection('sessions').find({ scope: SCOPE }).toArray()
const sessionIds = sessions.map(s => s.sessionId)
const sessionMessages = sessionIds.length
    ? await db.collection('session_messages').find({ sessionId: { $in: sessionIds } }).toArray()
    : []
const threads = await db.collection('threads').find({ agent: SCOPE }).toArray()

console.log(`DB "${db.databaseName}"`)
for (const c of EVENT_COLLECTIONS) {
    console.log(`  ${c.padEnd(26)} ${cols.has(c) ? await db.collection(c).estimatedDocumentCount() : 'absent'}`)
}
console.log(`  sessions (scope aether)    ${sessions.length}`)
console.log(`  session_messages           ${sessionMessages.length}`)
console.log(`  threads (agent aether)     ${threads.length}`)
if (strayPrefixed.length) console.log(`\n  NOT TOUCHED (aether_ but not the event board's): ${strayPrefixed.join(', ')}`)

if (cols.has('aether_scorecard')) {
    const card = await db.collection('aether_scorecard').findOne({ _id: 'latest' })
    console.log('\nLast scorecard (record this in the deletion note):')
    console.log(JSON.stringify(card, null, 1)?.slice(0, 4000) ?? '  none')
}

if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply.')
    await closeDb?.()
    process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '..', 'backups', `aether-events-${db.databaseName}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
fs.mkdirSync(dir, { recursive: true })
// One file per collection, written before anything is dropped. A failed write throws here — nothing is
// dropped without its backup.
for (const c of present) {
    const rows = await db.collection(c).find({}).toArray()
    fs.writeFileSync(path.join(dir, `${c}.json`), JSON.stringify(rows))
}
fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ sessions, session_messages: sessionMessages, threads }))
console.log(`\nBackup → ${dir}`)

for (const c of present) { await db.collection(c).drop(); console.log(`  ${c}: dropped`) }
if (sessionIds.length) {
    const m = await db.collection('session_messages').deleteMany({ sessionId: { $in: sessionIds } })
    const s = await db.collection('sessions').deleteMany({ scope: SCOPE })
    console.log(`  sessions: deleted ${s.deletedCount}, session_messages: deleted ${m.deletedCount}`)
}
const t = await db.collection('threads').deleteMany({ agent: SCOPE })
console.log(`  threads: deleted ${t.deletedCount}`)

await closeDb?.()
process.exit(0)
