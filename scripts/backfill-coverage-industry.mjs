/**
 * Stamp `industry` on coverage documents written before the field existed (2026-09-30).
 *
 * WHY. Pythia's Phase 4 cross-check is the `bottom_up` basis — the one the vocabulary ranks MOST
 * defensible. A stance can now be held on an industry, and `bottom_up` on one has to mean "our
 * covered names in THAT industry". Coverage stored only the sector, so the desk could answer at
 * eleven buckets and no finer, which is why a live run took six sector stances and reached for no
 * industry at all: it had the vocabulary to say "Semiconductors" and no evidence at that grain.
 *
 * The value is READ from the provider, never asked of a model. It is the same lookup
 * `_withTaxonomy` now makes when a document is initiated — `getSectorRaw`, already cached 24h per
 * symbol, already fetched for every covered name. We were discarding it.
 *
 * It rewrites the SECTOR too, for the same reason and from the same read. Three documents stored a
 * qualified provider string ("Technology - Software Infrastructure") because the fundamentals text
 * hands the model `Sector / industry` joined and it copied the whole thing; a taxonomy transcribed
 * by a model is a taxonomy that drifts. Anything it would change is printed before it is written.
 *
 * A ticker the provider does not know — an ETF, a foreign listing — keeps what it has. A thesis is
 * worth more than its metadata, and blanking a sector would drop the name out of the cross-check
 * entirely.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   node scripts/backfill-coverage-industry.mjs
 *   node scripts/backfill-coverage-industry.mjs --apply
 *   DB_NAME=test node scripts/backfill-coverage-industry.mjs --apply   # prod
 */

import dns from 'node:dns'
import { config } from '../services/config.js'

// Mongo's SRV lookup fails on this laptop's default resolver (docs: the DNS pin every script here
// carries). Harmless where it already worked.
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb } = await import('../providers/mongodb.provider.js')
const { getSectorRaw } = await import('../providers/fmp.provider.js')
const { normalizeSector, normalizeIndustry } = await import('../services/entity/vocabulary.js')
const { COLLECTION } = await import('../api/analyst/coverage.service.js')

const apply = process.argv.includes('--apply')
const line  = (s = '') => console.log(s)

const db   = await getDb()
const docs = await db.collection(COLLECTION)
    .find({}).project({ _id: 0, id: 1, symbol: 1, sector: 1, industry: 1, status: 1 }).toArray()

line(`\nCOVERAGE INDUSTRY BACKFILL — db "${db.databaseName}"${apply ? '' : '   (dry run)'}\n`)
line(`coverage documents: ${docs.length}`)

const changes = [], unknown = []
for (const d of docs) {
    // One read per symbol, cached 24h by the provider. Sequential on purpose: this is a one-off
    // over ~80 names and the last thing the FMP key needs is eighty parallel profile reads.
    const raw = await getSectorRaw(d.symbol).catch(() => null)
    if (!raw) { unknown.push(d.symbol); continue }

    const sector   = normalizeSector(raw.sector) ?? d.sector ?? null
    const industry = normalizeIndustry(raw.industry) ?? d.industry ?? null
    const $set = {}
    if (sector && sector !== d.sector)       $set.sector = sector
    if (industry && industry !== d.industry) $set.industry = industry
    if (!Object.keys($set).length) continue

    changes.push({ ...d, $set, providerIndustry: raw.industry })
    const bits = []
    if ($set.sector)   bits.push(`sector "${d.sector ?? '—'}" -> "${$set.sector}"`)
    if ($set.industry) bits.push(`industry "${d.industry ?? '—'}" -> "${$set.industry}"`)
    line(`  ${String(d.symbol).padEnd(6)} ${bits.join('   ')}`)
}

if (unknown.length) {
    line(`\n! the provider does not know ${unknown.length} ticker(s) — left exactly as they are:`)
    line(`  ${unknown.join(', ')}`)
}

// An industry string the provider returns but the vocabulary cannot place is worth seeing: it is
// either a name FMP added or one this app's list is missing, and both want a human.
const unplaced = docs
    .map(d => d)
    .filter(d => !changes.some(c => c.id === d.id) && !d.industry && !unknown.includes(d.symbol))
if (unplaced.length) {
    line(`\n! ${unplaced.length} document(s) got no industry and were not skipped — the provider's`)
    line(`  value did not resolve against INDUSTRY_SECTOR: ${unplaced.map(d => d.symbol).join(', ')}`)
}

if (!changes.length) { line('\nEvery document already carries the provider\'s taxonomy. Nothing to do.\n'); process.exit(0) }
if (!apply) { line(`\nDry run — ${changes.length} document(s) would be updated. Re-run with --apply.\n`); process.exit(0) }

let written = 0
for (const c of changes) {
    const res = await db.collection(COLLECTION).updateOne({ id: c.id }, { $set: c.$set })
    if (res.matchedCount === 1) written++
    else line(`  ! ${c.symbol}: no document matched id ${c.id}`)
}

line(`\n✓ BACKFILLED ${written} coverage document(s).\n`)
process.exit(0)
