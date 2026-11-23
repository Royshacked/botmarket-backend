// Give Prometheus's calls made before 2026-11-22 the two things the scorecard now reads on every call (Roy, 2026-11-22):
//
//   THE SECTOR YARDSTICK — the entry's close of the call's SPDR sector fund (echoReturns.sectorEtf) and, on every mark
//     already graded, the fund's return beside SPY's (prometheusCalls.sectorFill — no mark is added or closed here).
//   PYTHIA'S STANCE — her verdict on the name's GICS sub-industry AS IT STOOD the day the call was made, rebuilt from her
//     assessment's revision trail (pythiaStance.pythiaOnCall), on the book the call's horizon is graded on.
//
// The rating, target, entry price and marks vs SPY are untouched. Safe to re-run: a call that has both is skipped.
//
//   node scripts/backfill-call-context.mjs            DRY: what it would write, nothing written
//   node scripts/backfill-call-context.mjs --write    writes them                 (the DB in .env — DB_NAME)
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const write = process.argv.includes('--write')
const { getDb } = await import('../providers/mongodb.provider.js')
const { getTickerAggregates } = await import('../providers/candles.provider.js')
const { COLLECTION, sectorFill } = await import('../services/prometheusCalls.service.js')
const { sectorEtf } = await import('../services/echoReturns.service.js')
const { pythiaOnCall, agreement } = await import('../services/pythiaStance.js')
const { readCompaniesBySymbol } = await import('../api/strategy/industryData.service.js')
const { COLLECTION: ASSESSMENTS } = await import('../api/strategy/industryAssessment.service.js')

const DAY_MS = 86_400_000
const db = await getDb()
const calls = await db.collection(COLLECTION).find({}).toArray()
console.log(`${process.env.DB_NAME ?? '(db)'}: ${calls.length} calls · ${write ? 'WRITING' : 'dry run — nothing written'}`)

// The sector funds, once each, from the oldest call on.
const from = Math.min(...calls.map(c => Date.parse(c.made_at)).filter(Number.isFinite)) - 7 * DAY_MS
const funds = new Map()
for (const etf of [...new Set(calls.map(c => sectorEtf(c.sector)).filter(Boolean))]) {
    funds.set(etf, await getTickerAggregates(etf, { timeSpan: 'day', multiplier: 1, from, to: Date.now() }).catch(() => null))
    console.log(`  ${etf}: ${funds.get(etf)?.length ?? 0} bars`)
}
// Pythia: every name's GICS row, and every industry assessment with its trail.
const companies = await readCompaniesBySymbol([...new Set(calls.map(c => c.symbol))])
const docs = new Map((await db.collection(ASSESSMENTS).find({ 'subject.kind': 'industry' }, { projection: { _id: 0 } }).toArray()).map(d => [d.subject.code, d]))

const tally = { sector_entry: 0, sector_marks: 0, no_fund: 0, pythia: 0, written: 0 }, stances = {}, agree = {}
for (const c of calls) {
    const set = {}
    const etf = sectorEtf(c.sector)
    if (!etf) tally.no_fund++
    else if (c.entry && (!c.entry.sector || Object.values(c.marks ?? {}).some(m => Number.isFinite(m?.return_pct) && m.vs_sector == null))) {
        const f = sectorFill(c, funds.get(etf))
        if (f.entry?.sector && !c.entry.sector) { set['entry.sector'] = f.entry.sector; tally.sector_entry++ }
        for (const [m, mark] of Object.entries(f.marks)) {
            if (mark.vs_sector != null && c.marks?.[m]?.vs_sector == null) { set[`marks.${m}`] = mark; tally.sector_marks++ }
        }
    }
    if (c.pythia == null) {
        const company = companies[String(c.symbol).toUpperCase()] ?? null
        const p = pythiaOnCall({ company, doc: company?.sub_code ? docs.get(company.sub_code) ?? null : null, horizon: c.horizon, at: c.made_at })
        set.pythia = { ...p, basis: 'backfill' }
        tally.pythia++
        stances[p.stance ?? `none (${p.why})`] = (stances[p.stance ?? `none (${p.why})`] ?? 0) + 1
        const a = agreement(c.direction, p.stance) ?? (c.direction ? 'unread' : 'hold')
        agree[a] = (agree[a] ?? 0) + 1
    }
    if (!Object.keys(set).length) continue
    if (write) { await db.collection(COLLECTION).updateOne({ _id: c._id }, { $set: set }); tally.written++ }
}
console.log(`\nsector: ${tally.sector_entry} entries · ${tally.sector_marks} marks filled · ${tally.no_fund} calls with no sector fund`)
console.log(`Pythia: ${tally.pythia} calls · her stance ${JSON.stringify(stances)} · the calls ${JSON.stringify(agree)}`)
console.log(write ? `${tally.written} calls written` : 'Dry run. Run again with --write to apply.')
process.exit(0)
