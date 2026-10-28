// Put back in line the research names an ACCOUNT refusal stranded (2026-10-28). Before the fix in researchRun, a name the
// model's account refused — no credit, a bad key — was left `in_research` with reason `failed`, and the pick-up never
// reads a claim with a reason: one name lost per refused run (60 on prod). Every such claim, any source, goes back to
// `queued`; a Hotlist name from an earlier day is then expired by the next pick-up (hotlistResearch._expireOld), today's
// is read. A claim that failed on the NAME keeps its reason — that one is the admin's.
//
//   node scripts/requeue-refused-claims.mjs [--dry]      (the DB in .env — DB_NAME)
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const dry = process.argv.includes('--dry')
const { researchQueueService } = await import('../services/researchQueue.service.js')
const { isRunFatal } = await import('../services/researchRun.service.js')

const claims = await researchQueueService.listQueue({ status: 'in_research', limit: 5000 })
if (claims === null) { console.log('the queue could not be read'); process.exit(1) }
const refused = claims.filter(r => r.reason === 'failed' && r.detail && isRunFatal(new Error(r.detail)))
let back = 0
for (const r of refused) {
    console.log(`  ${r.source?.padEnd(8) ?? ''} ${r.symbol.padEnd(6)} ${r.context?.day ?? String(r.created_at).slice(0, 10)}  ${String(r.detail).slice(0, 70)}`)
    if (!dry && (await researchQueueService.requeue(r.id))?.ok) back++
}
console.log(`${claims.length} claimed · ${refused.length} refused on the account${dry ? ' (dry run)' : ` · ${back} back in line`}`)
process.exit(0)
