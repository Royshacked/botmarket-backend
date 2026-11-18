/**
 * Slim recorded Talos reads already pulled to disk into the v2 shape (monitoring/talos.recorder.js BUNDLE_VERSION 2).
 *
 *   node scripts/eval/talos-replay/slim-reads.mjs [--db=test] [--dir=data/eval/talos-reads] [--apply]
 *
 * Why (2026-11-18): the M0 holds 512 MB across every database, and `talos_reads` was 98 MB — 62% of each record chart
 * PNGs nothing reads (the replay redraws from `pack.bars`), 13% the same system prompt and tool list copied into every
 * read. For each record that is PULLED and whose full copy is ON DISK (pull-reads.mjs), this:
 *   - stores its system prompt and tool list once each in talos_prompts (upsert by ref — nothing lost)
 *   - sets `prompt.systemRef` / `prompt.toolsRef` and `v: 2`
 *   - removes `pack.charts`, `prompt.systemText`, `prompt.tools`
 * A record with no file on disk is left whole. Without --apply it only reports what it would do.
 */

import dns from 'node:dns'
import { access } from 'node:fs/promises'
import { config } from '../../../services/config.js'
import { getDb, getSiblingDb, closeDb } from '../../../providers/mongodb.provider.js'
import { COLLECTION, PROMPTS_COLLECTION, bundlePath, promptPieces, promptRef } from '../../../monitoring/talos.recorder.js'

if (config.dnsServers.length) dns.setServers(config.dnsServers)

const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
}))
const dir   = args.dir ?? config.talosRecordDir
const apply = args.apply === true

const db      = args.db ? await getSiblingDb(String(args.db)) : await getDb()
const reads   = db.collection(COLLECTION)
const prompts = db.collection(PROMPTS_COLLECTION)
const onDisk  = (file) => access(file).then(() => true, () => false)

const fat = { pulled: true, $or: [{ 'pack.charts': { $exists: true } }, { 'prompt.systemText': { $exists: true } }, { 'prompt.tools': { $exists: true } }] }
const cursor = reads.find(fat, { projection: { _id: 1, readId: 1, recordedAt: 1, 'prompt.systemText': 1, 'prompt.tools': 1, size: { $bsonSize: '$$ROOT' } } })

let slimmed = 0, skipped = 0, before = 0
for await (const doc of cursor) {
    if (!(await onDisk(bundlePath(dir, doc)))) { skipped++; console.log(`${doc._id}: no copy on disk — left whole`); continue }
    before += doc.size ?? 0
    if (apply) {
        const pieces = promptPieces({ systemText: doc.prompt?.systemText ?? null, tools: doc.prompt?.tools ?? null })
        for (const [ref, piece] of Object.entries(pieces)) {
            await prompts.updateOne({ _id: ref }, { $setOnInsert: { ...piece, firstSeen: doc.recordedAt } }, { upsert: true })
        }
        await reads.updateOne({ _id: doc._id }, {
            $set:   { v: 2, 'prompt.systemRef': promptRef(doc.prompt?.systemText ?? null), 'prompt.toolsRef': promptRef(doc.prompt?.tools ?? null) },
            $unset: { 'pack.charts': '', 'prompt.systemText': '', 'prompt.tools': '' },
        })
    }
    slimmed++
}

const [after] = await reads.aggregate([{ $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: { $bsonSize: '$$ROOT' } } } }]).toArray()
console.log(`${apply ? 'slimmed' : 'would slim'} ${slimmed} read(s) (${(before / 1048576).toFixed(1)} MB as they were); ${skipped} left whole (no copy on disk)`)
console.log(`${COLLECTION} now: ${after?.n ?? 0} read(s), ${((after?.bytes ?? 0) / 1048576).toFixed(1)} MB${apply ? '' : ' (dry run — nothing changed; --apply to write)'}`)
await closeDb()
