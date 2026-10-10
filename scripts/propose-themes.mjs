#!/usr/bin/env node
// Ask Pythia to propose themes from the command line — the same "Propose themes" the admin route runs
// (services/industryAssessmentRun.service.js proposeThemes; docs/design/pythia-assessment.md §3). Runs AS an
// admin, so the spend is booked and printed. Proposals land as `proposed`; approving them is the admin's.
//
//   node scripts/propose-themes.mjs [max, default 5] [admin username, default roy_shacked]

import dns from 'node:dns'
import { config } from '../services/config.js'

if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb } = await import('../providers/mongodb.provider.js')
const { proposeThemes } = await import('../services/industryAssessmentRun.service.js')
const { themeService } = await import('../api/strategy/theme.service.js')

const [max = '5', username = 'roy_shacked'] = process.argv.slice(2)
const db = await getDb()
const admin = await db.collection('users').findOne({ username, role: 'admin' }, { projection: { _id: 1 } })
if (!admin) {
    console.error(`no admin user "${username}"`)
    process.exit(2)
}
const started = Date.now()
const r = await proposeThemes({ userId: admin._id, max: Number(max) })
console.log(JSON.stringify({ ...r, seconds: Math.round((Date.now() - started) / 1000) }, null, 2))
for (const p of r.proposed ?? []) {
    const t = await themeService.getTheme(p.id)
    console.log(`\n${t.name} [${t.status}] — ${t.thesis}\n  terms: ${t.terms.join(', ')}`)
    for (const l of t.links) console.log(`  ${l.order} ${l.name} (${l.code}) — ${l.why}`)
    if (t.basket.length) console.log(`  basket: ${t.basket.map(b => b.symbol).join(', ')}`)
}
process.exit(r.ok ? 0 : 1)
