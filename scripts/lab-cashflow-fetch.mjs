// CASH FLOW FROM SEC COMPANYFACTS for the names in data/lab/sec-facts.jsonl (screener-lab.md §52) → data/lab/sec-cashflow.jsonl,
// one compact row a name (secFundamentals.compactCashFlow). The CIKs come from sec-facts.jsonl; the request is
// lab-fundamentals-fetch.mjs's (its User-Agent from config, ≤ 5 a second). Resumable: a name already in the file is skipped.
//
//   node scripts/lab-cashflow-fetch.mjs
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { config } = await import('../services/config.js')
const { compactCashFlow } = await import('../services/secFundamentals.service.js')

const IN = 'data/lab/sec-facts.jsonl', OUT = 'data/lab/sec-cashflow.jsonl'
const H = { 'User-Agent': config.secUserAgent, 'Accept-Encoding': 'gzip, deflate' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function get(url) {
    for (let a = 0; a < 4; a++) {
        try {
            const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(60000) })
            if (r.status === 404) return null
            if (r.ok) return await r.json()
            await sleep(2000 * (a + 1))
        } catch { await sleep(2000 * (a + 1)) }
    }
    throw new Error(`SEC ${url} failed 4 times`)
}

const ciks = fs.readFileSync(IN, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.cik).map(r => [r.symbol, r.cik])
const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).symbol) : [])
const todo = ciks.filter(([s]) => !done.has(s))
console.log(`${ciks.length} names with a CIK · ${done.size} done · ${todo.length} to read`)
let n = 0, miss = 0
for (const [symbol, cik] of todo) {
    const json = await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`)
    const c = json ? compactCashFlow(json) : null
    if (!c?.ocf?.length) miss++
    fs.appendFileSync(OUT, JSON.stringify({ symbol, cik, c }) + '\n')
    if (++n % 100 === 0) console.log(`  ${n}/${todo.length} · no cash flow ${miss}`)
    await sleep(200)
}
console.log(`done · ${n} read · no cash flow ${miss} → ${OUT}`)
process.exit(0)
