// SEC COMPANYFACTS FOR EVERY NAME EVER IN THE S&P 500 SINCE 2019 (screener-lab.md §39) → data/lab/sec-facts.jsonl, one
// compact row a name (secFundamentals.compactFacts). Resumable: a name already in the file is skipped. Small process:
// reads the universe file only, never the bars. SEC asks ≤ 10 requests a second; this keeps to about 5.
//
//   node scripts/lab-fundamentals-fetch.mjs
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { config } = await import('../services/config.js')
const { compactFacts } = await import('../services/secFundamentals.service.js')

const OUT = 'data/lab/sec-facts.jsonl'
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

const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).symbol) : [])
const tick = await get('https://www.sec.gov/files/company_tickers.json')
const cikOf = new Map()
for (const e of Object.values(tick)) {
    const cik = String(e.cik_str).padStart(10, '0'), t = String(e.ticker).toUpperCase()
    cikOf.set(t, cik); cikOf.set(t.replace('-', '.'), cik); cikOf.set(t.replace('.', '-'), cik)
}
const todo = Object.keys(u.spans).filter(s => !done.has(s))
console.log(`${Object.keys(u.spans).length} names · ${done.size} done · ${todo.length} to read`)
let n = 0, miss = 0
for (const symbol of todo) {
    const cik = cikOf.get(symbol)
    let row
    if (!cik) { row = { symbol, miss: 'no_cik' }; miss++ } else {
        const j = await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`)
        row = j ? { symbol, cik, c: compactFacts(j) } : { symbol, cik, miss: 'no_facts' }
        if (!j) miss++
        await sleep(200)
    }
    fs.appendFileSync(OUT, JSON.stringify(row) + '\n')
    if (++n % 50 === 0) console.log(`  ${n}/${todo.length} · missing ${miss}`)
}
console.log(`done · ${n} read · missing ${miss}`)
process.exit(0)
