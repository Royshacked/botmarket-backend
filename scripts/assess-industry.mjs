#!/usr/bin/env node
// One Pythia assessment from the command line — the same "Assess now" the admin route runs
// (services/industryAssessmentRun.service.js; docs/design/pythia-assessment.md). Runs AS an admin, so the
// spend is booked and printed: the number the weekly assessment cap is set from.
//
//   node scripts/assess-industry.mjs <8-digit GICS code> [admin username, default roy_shacked]
//
// Writes the assessment (industry_assessment) and its call (pythia_calls) to this process's database.

import dns from 'node:dns'
import { config } from '../services/config.js'

// Mongo's SRV lookup fails on this laptop's default resolver (the DNS pin every script here carries).
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb } = await import('../providers/mongodb.provider.js')
const { assessIndustry } = await import('../services/industryAssessmentRun.service.js')

const [code, username = 'roy_shacked'] = process.argv.slice(2)
if (!/^\d{8}$/.test(code ?? '')) {
    console.error('usage: node scripts/assess-industry.mjs <8-digit GICS code> [admin username]')
    process.exit(2)
}
const db = await getDb()
const admin = await db.collection('users').findOne({ username, role: 'admin' }, { projection: { _id: 1 } })
if (!admin) {
    console.error(`no admin user "${username}"`)
    process.exit(2)
}
const started = Date.now()
const r = await assessIndustry(code, { userId: admin._id })
const { doc, ...rest } = r
console.log(JSON.stringify({ ...rest, seconds: Math.round((Date.now() - started) / 1000) }, null, 2))
if (doc) {
    const { revisions, ...shown } = doc   // eslint-disable-line no-unused-vars -- the trail is not the point here
    console.log(JSON.stringify(shown, null, 2))
}
process.exit(r.ok ? 0 : 1)
