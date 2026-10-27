// THE S&P 500 AS IT WAS — the universe file (services/sp500History.service.js): Wikipedia's two tables → each name's
// spans in the index since FROM, then FMP's profile for each (its sector, and a check that a REMOVED ticker still
// names the same company — a ticker can be reused). Declared in screener-lab.md §30.
//
//   node scripts/lab-sp500-universe.mjs        → data/lab/sp500-universe.json
//   then: node --max-old-space-size=6000 scripts/lab-rotation.mjs --universe=sp500
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { parseCurrent, parseChanges, membership } = await import('../services/sp500History.service.js')
const { fmpGet } = await import('../providers/fmp.price.provider.js')
const { createPacer } = await import('../services/concurrency.util.js')

const FROM = '2017-11-01', OUT = 'data/lab/sp500-universe.json'
const wiki = async (page) => {
    const r = await fetch(`https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json&formatversion=2`,
        { headers: { 'User-Agent': 'ar2trade-lab/1.0 (research)' } })
    if (!r.ok) throw new Error(`Wikipedia ${page}: ${r.status}`)
    return (await r.json()).parse.wikitext
}
const current = parseCurrent(await wiki('List of S&P 500 companies'))
const changes = parseChanges(await wiki('Historical components of the S&P 500'))
const m = membership(current, changes, { from: FROM })
const syms = Object.keys(m.spans).sort()
console.log(`today ${current.length} · changes ${changes.length} · names since ${FROM}: ${syms.length} · unmatched ${m.unmatched.length}`)
for (const u of m.unmatched) console.log(`  unmatched ${JSON.stringify(u)}`)

// The profile for the sector only. Whether a REMOVED ticker still names the same company is judged on its bars when the
// lab loads them (scripts/lab-rotation.mjs: they must cover its days in the index) — a reused ticker's bars start later;
// an acquired company often has bars and no profile (Celgene, Tiffany).
const pace = createPacer({ perMinute: 120 })
const profiles = {}
for (const [k, s] of syms.entries()) {
    await pace()
    let p = null
    try { p = (await fmpGet(`/profile?symbol=${encodeURIComponent(s)}`, { label: `FMP profile ${s}` }))?.[0] ?? null } catch { /* no profile: no sector */ }
    if (p) profiles[s] = { name: p.companyName, sector: p.sector || null }
    if ((k + 1) % 100 === 0) console.log(`  profiles ${k + 1}/${syms.length}`)
}
fs.writeFileSync(OUT, JSON.stringify({ built_at: new Date().toISOString(), from: FROM, spans: m.spans, names: m.names, profiles, unmatched: m.unmatched }))
console.log(`${syms.length} names, ${Object.keys(profiles).length} with a profile → ${OUT}`)
process.exit(0)
