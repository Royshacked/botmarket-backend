// Put the σ and the conviction on Prometheus's calls made before the σ rating bands (services/ratingBands.js, 2026-11-21)
// — Roy, 2026-11-22: without them the scorecard reads those calls' band on the old flat margin for months.
//
// σ AS OF THE CALL: the stock's daily bars from BEFORE the call's day (no bar it could not have seen), the swing scale's
// σ (stockProfile.engine, the same read the live save takes) → over the call's horizon. Nothing is fetched into
// `stock_profiles`: the bars are read once per name and kept in memory only.
// CONVICTION: the coverage trail does not log conviction, so only a call that is still the coverage's live one (not
// superseded, same target) gets the coverage's conviction now; every other call keeps none (read uncapped).
// The rating, target, entry and marks are untouched. Safe to re-run: a call that has a σ is skipped.
//
//   node scripts/backfill-call-sigma.mjs            DRY: what it would write, nothing written
//   node scripts/backfill-call-sigma.mjs --write    writes them                 (the DB in .env — DB_NAME)
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const write = process.argv.includes('--write')
const { getDb } = await import('../providers/mongodb.provider.js')
const { COLLECTION } = await import('../api/analyst/coverage.service.js')
const { fetchScaleBars } = await import('../services/stockProfile.service.js')
const { SCALES, scaleProfile } = await import('../services/stockProfile.engine.js')
const { horizonSigmaPct, ratingBand } = await import('../services/ratingBands.js')

const PACE_MS = 300
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const db = await getDb()
const calls = await db.collection('prometheus_calls').find({ sigma_pct: null }).toArray()
const covs = new Map((await db.collection(COLLECTION).find({ id: { $in: [...new Set(calls.map(c => c.coverage_id).filter(Boolean))] } },
    { projection: { _id: 0, id: 1, price_target: 1, conviction: 1 } }).toArray()).map(c => [c.id, c]))
console.log(`${process.env.DB_NAME ?? '(db)'}: ${calls.length} calls without a σ · ${write ? 'WRITING' : 'dry run — nothing written'}`)

const bySym = new Map()
for (const c of calls) (bySym.get(c.symbol) ?? bySym.set(c.symbol, []).get(c.symbol)).push(c)
const tally = { sigma: 0, no_history: 0, conviction: 0 }, moved = {}
for (const [sym, list] of [...bySym].sort((a, b) => a[0].localeCompare(b[0]))) {
    let bars = []
    try { bars = (await fetchScaleBars(sym, { scales: ['swing'] })).swing } catch (e) { console.log(`  ${sym}: no bars — ${e.message}`) }
    for (const c of list) {
        const dayStart = Date.parse(String(c.made_at).slice(0, 10)) / 1000
        const prof = scaleProfile(bars.filter(b => b.timestamp < dayStart), SCALES.swing)
        const sigma_pct = horizonSigmaPct(prof?.sigma, c.horizon)
        if (sigma_pct == null) { tally.no_history++; continue }
        const cov = covs.get(c.coverage_id)
        const live = !c.superseded_at && cov && Number(cov.price_target?.value) === Number(c.pt)
        const conviction = live ? cov.conviction?.level ?? null : null
        tally.sigma++
        if (conviction) tally.conviction++
        const before = ratingBand({ target: c.pt, price: c.entry?.price, horizon: c.horizon })?.rating ?? '—'
        const after = ratingBand({ target: c.pt, price: c.entry?.price, horizon: c.horizon, sigma_pct, conviction })?.rating ?? '—'
        const k = `${before} → ${after}`
        moved[k] = (moved[k] ?? 0) + 1
        if (write) await db.collection('prometheus_calls').updateOne({ _id: c._id, sigma_pct: null }, { $set: { sigma_pct, conviction, sigma_backfilled_at: new Date().toISOString() } })
    }
    await sleep(PACE_MS)
}
console.log('\nband (flat → σ), by entry price:\n' + Object.entries(moved).sort((a, b) => b[1] - a[1]).map(([m, n]) => `  ${m}: ${n}`).join('\n'))
console.log(`\nσ set ${tally.sigma} · no history before the call ${tally.no_history} · conviction carried ${tally.conviction}` + (write ? '' : '\nDry run. Run again with --write to apply.'))
process.exit(0)
