/**
 * Canonicalise the `sector` on coverage documents that stored a QUALIFIED provider string.
 *
 * WHY IT MATTERS, and it is not cosmetic. Pythia's Phase 4 cross-check reads
 * `coverageService.listActiveBySector`, which matches `sector: { $in: [the eleven] }` — an exact
 * match. A document that stored "Technology — Software Infrastructure" is therefore invisible to
 * it: the desk is told Technology has 14 covered names when it has 15, and MSFT is not one of
 * them. `bottom_up` is the basis the vocabulary ranks MOST defensible, and it is being computed
 * off an undercount.
 *
 * Worse in the limit: were a sector's only coverage stored this way, the tool would report "no
 * coverage at all in Energy" and the prompt instructs Pythia to say so out loud. A wrong count is
 * bad; a confident denial is worse.
 *
 * NOT A LIVE BUG. `normalizeCoverage` canonicalises on write (coverage.service, `sector:
 * normalizeSector(r.sector)`), and `normalizeSector` learned to split a qualified string on its
 * separator afterwards. These are documents written before that, which nothing migrated — three
 * of them on the dev book, created 2026-07-27 to 2026-08-02.
 *
 * The rewrite is exactly what the writer would produce today: `normalizeSector` on the stored
 * value. A row whose sector will not canonicalise at all is REPORTED, never guessed — a coverage
 * document filed under the wrong sector is worse than one filed under none, because the first is
 * counted.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   node scripts/repair-coverage-sectors.mjs
 *   node scripts/repair-coverage-sectors.mjs --apply
 *   DB_NAME=test node scripts/repair-coverage-sectors.mjs --apply   # prod
 */

import dns from 'node:dns'
import { config } from '../services/config.js'

// Mongo's SRV lookup fails on this laptop's default resolver (docs: the DNS pin every script here
// carries). Harmless where it already worked.
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb } = await import('../providers/mongodb.provider.js')
const { normalizeSector, SECTORS } = await import('../services/entity/vocabulary.js')
const { COLLECTION } = await import('../api/analyst/coverage.service.js')

const apply = process.argv.includes('--apply')
const line  = (s = '') => console.log(s)

const db   = await getDb()
const docs = await db.collection(COLLECTION)
    .find({}).project({ _id: 0, id: 1, symbol: 1, sector: 1, status: 1, created_at: 1 }).toArray()

line(`\nCOVERAGE SECTOR REPAIR — db "${db.databaseName}"${apply ? '' : '   (dry run)'}\n`)
line(`coverage documents: ${docs.length}`)

const off = docs.filter(d => d.sector && !SECTORS.includes(d.sector))
const nul = docs.filter(d => !d.sector)

if (nul.length) {
    // A document with NO sector was never joinable and this script cannot invent one — it is a
    // different repair, and it needs whoever knows the name.
    line(`\n! ${nul.length} document(s) carry no sector at all — out of scope here: ${nul.map(d => d.symbol).join(', ')}`)
}

if (!off.length) { line('\nEvery stored sector is canonical. Nothing to repair.\n'); process.exit(0) }

line(`\nnon-canonical: ${off.length}\n`)
const fixable = [], stuck = []
for (const d of off) {
    const to = normalizeSector(d.sector)
    line(`  ${String(d.symbol).padEnd(6)} ${String(d.status ?? '?').padEnd(8)} ${String(d.created_at ?? '').slice(0, 10)}  "${d.sector}"`)
    line(`         -> ${to ? `"${to}"` : 'UNRESOLVABLE — reported, not guessed'}`)
    ;(to ? fixable : stuck).push({ ...d, to })
}

if (stuck.length) {
    line(`\n! ${stuck.length} will NOT be touched: the vocabulary cannot place them, and a document`)
    line('  filed under the wrong sector is worse than one filed under none — the first gets counted.')
}

if (!fixable.length) { line('\nNothing this script can repair.\n'); process.exit(0) }
if (!apply) { line(`\nDry run — ${fixable.length} document(s) would be rewritten. Re-run with --apply.\n`); process.exit(0) }

let written = 0
for (const d of fixable) {
    const res = await db.collection(COLLECTION).updateOne({ id: d.id }, { $set: { sector: d.to } })
    if (res.matchedCount === 1) written++
    else line(`  ! ${d.symbol}: no document matched id ${d.id}`)
}

line(`\n✓ REPAIRED ${written} coverage document(s) — now visible to Pythia's bottom-up cross-check.\n`)
process.exit(0)
