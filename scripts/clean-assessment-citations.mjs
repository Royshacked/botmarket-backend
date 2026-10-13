// STRIP RAW MARKDOWN CITATIONS from stored assessments — "([spglobal.com](https://…?utm_source=openai))" → "(spglobal.com)".
// One-off. The write path has cleaned them since 2026-10-13 (agentUtils.plainCitations, in industryAssessment's _str);
// the rows written before that still carried them, and the Assessed board printed them raw (105 of 166 on axl_dev).
//
//   node scripts/clean-assessment-citations.mjs                 dry run on axl_dev: what would change
//   node scripts/clean-assessment-citations.mjs --apply         writes
//   node scripts/clean-assessment-citations.mjs --db test       the same on prod
//
// The SAME cleaner the write path uses, over every string in the document (revision notes included), so a cleaned
// row is exactly what a fresh assessment would have stored. Touches only the top-level fields that changed.
import 'dotenv/config'
import dns from 'node:dns'
dns.setServers(['8.8.8.8'])
import { MongoClient } from 'mongodb'
import { plainCitations } from '../services/agentUtils.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const dbName = args.includes('--db') ? args[args.indexOf('--db') + 1] : 'axl_dev'

const clean = (v) => {
    if (typeof v === 'string') return plainCitations(v)
    if (Array.isArray(v)) return v.map(clean)
    if (v && typeof v === 'object' && !(v instanceof Date) && v._bsontype == null) {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]))
    }
    return v
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const c = await MongoClient.connect(process.env.MONGODB_URI)
const coll = c.db(dbName).collection('industry_assessment')
const docs = await coll.find({}).toArray()
let changed = 0
for (const doc of docs) {
    const set = {}
    for (const [k, v] of Object.entries(doc)) {
        if (k === '_id') continue
        const cv = clean(v)
        if (!same(cv, v)) set[k] = cv
    }
    const fields = Object.keys(set)
    if (!fields.length) continue
    changed++
    console.log(`${doc.id}  "${doc.subject?.name ?? '?'}"  ${fields.join(', ')}  ${apply ? 'CLEANED' : 'would clean'}`)
    if (apply) await coll.updateOne({ _id: doc._id }, { $set: set })
}
console.log(`${dbName}.industry_assessment: ${changed} of ${docs.length} ${apply ? 'cleaned' : 'to clean — dry run, nothing written; add --apply'}`)
await c.close()
