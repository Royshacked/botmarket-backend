// EVERY 8-K OF EVERY NAME EVER IN THE S&P 500, 2019-12 → (screener-lab.md §40) → data/lab/sec-8k.jsonl, one row a name:
// `{ symbol, cik, f: [[filed, items]] }`. Resumable: a name already in the file is skipped. Small process: the universe
// file only, never the bars. About 5 requests a second (SEC asks ≤ 10).
//
//   node scripts/lab-8k-items-fetch.mjs
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { config } = await import('../services/config.js')

const OUT = 'data/lab/sec-8k.jsonl', FROM = '2019-12-01'
const H = { 'User-Agent': config.secUserAgent, 'Accept-Encoding': 'gzip, deflate' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function get(url) {
    for (let a = 0; a < 4; a++) {
        try {
            const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(60000) })
            if (r.status === 404) return null
            if (r.ok) { await sleep(200); return await r.json() }
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
    let row = { symbol, miss: 'no_cik' }
    const sub = cik ? await get(`https://data.sec.gov/submissions/CIK${cik}.json`) : null
    if (sub) {
        const f = []
        const take = (rec) => rec.form.forEach((form, i) => { if (form === '8-K' && rec.filingDate[i] >= FROM) f.push([rec.filingDate[i], String(rec.items[i] ?? '')]) })
        take(sub.filings.recent)
        for (const page of sub.filings.files ?? []) {
            if (page.filingTo < FROM) continue
            const rec = await get(`https://data.sec.gov/submissions/${page.name}`)
            if (rec) take(rec)
        }
        row = { symbol, cik, f: f.sort((a, b) => a[0].localeCompare(b[0])) }
    } else if (cik) row = { symbol, cik, miss: 'no_submissions' }
    if (row.miss) miss++
    fs.appendFileSync(OUT, JSON.stringify(row) + '\n')
    if (++n % 50 === 0) console.log(`  ${n}/${todo.length} · missing ${miss}`)
}
console.log(`done · ${n} read · missing ${miss}`)
process.exit(0)
