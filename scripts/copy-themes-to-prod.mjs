// COPY PYTHIA'S THEMES from the dev database (axl_dev) to prod (test), as they are — status included (Roy, 2026-10-13:
// "all three, approved"). One-off, for the first deploy of the themes (docs/deploy-2026-10.md §4).
//
//   node scripts/copy-themes-to-prod.mjs            dry run: what would be copied
//   node scripts/copy-themes-to-prod.mjs --apply    writes
//
// Never overwrites a theme prod already has (by id). Reads MONGODB_URI from .env; the database names are fixed on purpose.
import 'dotenv/config'
import dns from 'node:dns'
dns.setServers(['8.8.8.8'])
import { MongoClient } from 'mongodb'
const apply = process.argv.includes('--apply')
const c = await MongoClient.connect(process.env.MONGODB_URI)
const from = c.db('axl_dev').collection('theme'), to = c.db('test').collection('theme')
const themes = await from.find({}, { projection: { _id: 0 } }).toArray()
for (const t of themes) {
    const exists = await to.findOne({ id: t.id }, { projection: { _id: 1, status: 1 } })
    console.log(`${t.id}  "${t.name}"  status=${t.status}  links=${t.links?.length ?? 0}  ${exists ? `SKIP — prod has it (${exists.status})` : apply ? 'COPIED' : 'would copy'}`)
    if (!exists && apply) await to.insertOne(t)
}
console.log(apply ? 'done' : 'dry run — nothing written; add --apply')
await c.close()
