/**
 * `sector` becomes `grain` + `bucket` + `proxy` on every stance row (2026-09-30).
 *
 * WHY. A view could only ever be held on one of eleven sectors, because the vocabulary had one
 * level. "Overweight Energy" is a direction, not a place to look. Rows now name a SECTOR or an
 * INDUSTRY and carry the grain they were taken at, plus the fund they are graded against — see
 * docs/design/pythia-industries-and-channels.md.
 *
 * ONE field replaces one field. `sector` is removed rather than left beside `bucket`: two fields
 * that can disagree, with every reader checking both, is the failure this migration exists to
 * avoid. `_row` still READS `sector` as a fallback so an unmigrated document normalises, and that
 * fallback comes out once no stored view carries one.
 *
 * TWO COLLECTIONS, because the field escaped the desk:
 *   • `tilt` — every document, active and superseded. The superseded ones are the record the desk
 *     is graded on and `listTilts` still reads them.
 *   • `portfolio_chats` — Atlas fingerprints the view it last reviewed against
 *     (`lastFingerprint.tilt.stances[]`, one `{sector, stance, active_bp}` per row) and
 *     `diffStances` compares the stored copy with the live one. Left alone, every stored
 *     fingerprint would read as "every stance withdrawn, every stance new" on the next review and
 *     fire the house-view-moved trigger for nothing.
 *
 * The proxy is stamped from the table as it stands today. That is correct for these rows and only
 * these: every one is a sector, and the sector funds have not changed. A row's proxy is frozen from
 * here on, exactly like its baseline.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   node scripts/migrate-tilt-buckets.mjs
 *   node scripts/migrate-tilt-buckets.mjs --apply
 *   DB_NAME=test node scripts/migrate-tilt-buckets.mjs --apply   # prod
 */

import dns from 'node:dns'
import { config } from '../services/config.js'

// Mongo's SRV lookup fails on this laptop's default resolver (docs: the DNS pin every script here
// carries). Harmless where it already worked.
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb } = await import('../providers/mongodb.provider.js')
const { resolveBucket, proxyMeta } = await import('../services/entity/vocabulary.js')

const apply = process.argv.includes('--apply')
const line  = (s = '') => console.log(s)

const db = await getDb()
line(`\nTILT BUCKET MIGRATION — db "${db.databaseName}"${apply ? '' : '   (dry run)'}\n`)

// ─── tilt documents ───────────────────────────────────────────────────────────

const docs = await db.collection('tilt').find({}).toArray()
let rowsToMove = 0, unresolved = []

for (const doc of docs) {
    const rows = Array.isArray(doc.tilts) ? doc.tilts : []
    const moving = rows.filter(r => r && r.bucket === undefined)
    if (!moving.length) continue
    line(`${doc.id}  ${String(doc.status).padEnd(11)} ${moving.length}/${rows.length} rows`)
    for (const r of moving) {
        const resolved = resolveBucket(r.sector)
        if (!resolved) { unresolved.push(`${doc.id}: ${r.sector}`); continue }
        const meta = proxyMeta(resolved.bucket)
        line(`    ${String(r.sector).padEnd(24)} -> ${resolved.grain} "${resolved.bucket}"  proxy ${meta?.symbol ?? 'NONE'}`)
        rowsToMove++
    }
}

if (unresolved.length) {
    // A stored sector that no longer resolves is a vocabulary change nobody migrated. Guessing is
    // how a stance ends up graded against the wrong fund, so this stops instead.
    line(`\n✗ REFUSED — ${unresolved.length} stored row(s) name something the vocabulary no longer knows:`)
    for (const u of unresolved) line(`    ${u}`)
    line('  Nothing written.\n')
    process.exit(1)
}

// ─── Atlas fingerprints ───────────────────────────────────────────────────────

const chats = await db.collection('portfolio_chats')
    .find({ 'lastFingerprint.tilt.stances.sector': { $exists: true } })
    .project({ _id: 1, portfolioId: 1, userId: 1, 'lastFingerprint.tilt': 1 })
    .toArray()

line(`\nfingerprints carrying the old field: ${chats.length}`)
for (const c of chats) {
    const st = c.lastFingerprint?.tilt?.stances ?? []
    line(`    ${String(c.portfolioId).slice(0, 18).padEnd(20)} ${st.length} stance(s): ${st.map(s => s.sector).join(', ')}`)
}

if (!rowsToMove && !chats.length) { line('\nNothing to migrate — every row already carries a bucket.\n'); process.exit(0) }
if (!apply) { line(`\nDry run — ${rowsToMove} stance row(s) and ${chats.length} fingerprint(s) would move. Re-run with --apply.\n`); process.exit(0) }

// ─── write ────────────────────────────────────────────────────────────────────

let docsWritten = 0
for (const doc of docs) {
    const rows = Array.isArray(doc.tilts) ? doc.tilts : []
    if (!rows.some(r => r && r.bucket === undefined)) continue

    const tilts = rows.map(r => {
        if (!r || r.bucket !== undefined) return r
        const { grain, bucket } = resolveBucket(r.sector)
        const meta = proxyMeta(bucket)
        const { sector, ...rest } = r                                    // eslint-disable-line no-unused-vars
        return { grain, bucket, proxy: meta ? { ...meta } : null, ...rest }
    })
    await db.collection('tilt').updateOne({ id: doc.id }, { $set: { tilts } })
    docsWritten++
}

let chatsWritten = 0
for (const c of chats) {
    const stances = (c.lastFingerprint?.tilt?.stances ?? []).map(s => {
        if (s?.bucket !== undefined) return s
        const { sector, ...rest } = s ?? {}                              // eslint-disable-line no-unused-vars
        return { bucket: resolveBucket(sector)?.bucket ?? sector ?? null, ...rest }
    })
    await db.collection('portfolio_chats').updateOne(
        { _id: c._id },
        { $set: { 'lastFingerprint.tilt.stances': stances } },
    )
    chatsWritten++
}

line(`\n✓ MIGRATED — ${docsWritten} tilt document(s), ${chatsWritten} fingerprint(s).\n`)
process.exit(0)
