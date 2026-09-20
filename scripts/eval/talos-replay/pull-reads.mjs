/**
 * Bring recorded Talos reads down from the Mongo sink into the disk layout the replay reads.
 *
 *   node scripts/eval/talos-replay/pull-reads.mjs [--db=test] [--all] [--dir=data/eval/talos-reads]
 *
 * The deployed instance records with TALOS_RECORD_SINK=mongo because its disk does not survive a
 * deploy; the laptop pulls. Each document becomes `<dir>/<day>/<readId>.json` — the same file the
 * disk sink would have written — and is stamped `pulled: true` so the next pull skips it. `--all`
 * re-pulls stamped documents too (a file was lost, or the layout changed). `--db` names a sibling
 * database on the same cluster (the laptop sits on DB_NAME=axl_dev; the real reads are on `test`) —
 * read-only there apart from the stamp, and never the lease.
 */

import dns from 'node:dns'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../../../services/config.js'
import { getDb, getSiblingDb, closeDb } from '../../../providers/mongodb.provider.js'
import { COLLECTION, bundlePath } from '../../../monitoring/talos.recorder.js'

// Same pin server.js applies — a dev router that blocks SRV lookups fails `mongodb+srv://` first.
if (config.dnsServers.length) dns.setServers(config.dnsServers)

const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
}))
const dir = args.dir ?? config.talosRecordDir

const db  = args.db ? await getSiblingDb(String(args.db)) : await getDb()
const col = db.collection(COLLECTION)
const cursor = col.find(args.all ? {} : { pulled: { $ne: true } })

let n = 0
for await (const doc of cursor) {
    const { _id, pulled: _p, ...bundle } = doc
    const file = bundlePath(dir, bundle)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(bundle))
    await col.updateOne({ _id }, { $set: { pulled: true } })
    n++
    console.log(`${_id} → ${file}`)
}
console.log(`${n} read(s) pulled from ${db.databaseName}.${COLLECTION} into ${dir}`)
await closeDb()
