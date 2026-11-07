// THE GUIDANCE IN THE EARNINGS RELEASE — the download for test O (screener-lab.md §33). For every report test N trades (the
// S&P 500 as it was, entries 2020 →): the 8-K with item 2.02 filed around the report day, its press release, and the
// sentences that could state guidance. Text is kept, not a verdict, so the classifier can change without another download.
//
//   node --max-old-space-size=6000 scripts/lab-guidance-fetch.mjs --list   (once: the reports to read → data/lab/guidance-wanted.json)
//   node scripts/lab-guidance-fetch.mjs                                     (the download; resumable: reports on file are skipped)
//
// Free, from SEC EDGAR, at most 6 requests a second (their limit is 10). → data/lab/guidance-8k.jsonl
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const OUT = 'data/lab/guidance-8k.jsonl', PER_SECOND = 6, WORKERS = 4
const { holdTrades } = await import('../services/holdToNext.service.js')
const { pickExhibit, guidanceText, nearestEarnings8k } = await import('../services/guidance8k.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')
const { config } = await import('../services/config.js')

// THE LIST OF REPORTS, IN ITS OWN PROCESS (2026-11-07: holding ~1.1 GB of bars through an hour of downloading ran the
// laptop out of memory). `--list` loads the bars, writes the reports test N trades and exits; the download reads that file.
const LIST = 'data/lab/guidance-wanted.json'
if (process.argv.includes('--list')) {
    const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
    const member = (sym, day) => memberOn(u.spans, sym, day)
    const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
    await closeDb()
    // The report day of each trade: the entry is two bars after it.
    const list = holdTrades(data, { from: '2020-01-01', member }).trades.map(t => ({ symbol: t.symbol, report: data.names.get(t.symbol).ind.date[t.i - 2] }))
    fs.writeFileSync(LIST, JSON.stringify(list))
    console.log(`${list.length} reports → ${LIST}`)
    process.exit(0)
}
await closeDb()
if (!fs.existsSync(LIST)) { console.log(`no ${LIST}: run with --list first`); process.exit(1) }
const wanted = JSON.parse(fs.readFileSync(LIST, 'utf8'))

const done = new Set()
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) { if (l) { const r = JSON.parse(l); done.add(`${r.symbol} ${r.report}`) } }
const todo = wanted.filter(w => !done.has(`${w.symbol} ${w.report}`))
console.log(`${wanted.length} reports · ${done.size} on file · ${todo.length} to read`)

// One clock for every worker: a request starts no sooner than 1/PER_SECOND after the last.
let nextAt = 0
const slot = async () => { const now = Date.now(), at = Math.max(now, nextAt); nextAt = at + 1000 / PER_SECOND; if (at > now) await new Promise(r => setTimeout(r, at - now)) }
async function get(url, json = true) {
    for (let tries = 0; ; tries++) {
        await slot()
        try {
            const r = await fetch(url, { headers: { 'User-Agent': config.secUserAgent }, signal: AbortSignal.timeout(30000) })
            if (r.status === 404) return null
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return json ? await r.json() : await r.text()
        } catch (e) {
            if (tries >= 4) throw e
            await new Promise(res => setTimeout(res, 2000 * 2 ** tries))
        }
    }
}

const tick = await get('https://www.sec.gov/files/company_tickers.json')
const cikOf = new Map()
for (const e of Object.values(tick)) {
    const cik = String(e.cik_str).padStart(10, '0'), t = String(e.ticker).toUpperCase()
    cikOf.set(t, cik)
    cikOf.set(t.replace('-', '.'), cik)
}

// Every 8-K with item 2.02 of a name, once: the recent list and the older pages that reach 2020.
const filings = new Map()
function filingsOf(symbol) {
    if (filings.has(symbol)) return filings.get(symbol)
    const p = (async () => {
        const cik = cikOf.get(symbol)
        if (!cik) return null
        const sub = await get(`https://data.sec.gov/submissions/CIK${cik}.json`)
        if (!sub) return null
        const list = []
        const take = (rec) => rec.form.forEach((f, i) => {
            if (f === '8-K' && String(rec.items[i]).split(',').map(s => s.trim()).includes('2.02')) {
                list.push({ cik, filed: rec.filingDate[i], acc: rec.accessionNumber[i].replace(/-/g, ''), primary: rec.primaryDocument[i] })
            }
        })
        take(sub.filings.recent)
        for (const page of sub.filings.files ?? []) {
            if (page.filingTo < '2019-12-01') continue
            const rec = await get(`https://data.sec.gov/submissions/${page.name}`)
            if (rec) take(rec)
        }
        return list
    })()
    filings.set(symbol, p)
    return p
}

const out = fs.createWriteStream(OUT, { flags: 'a' })
let n = 0, failed = 0
async function readOne({ symbol, report }) {
    const row = { symbol, report }
    const list = await filingsOf(symbol)
    if (!list) return { ...row, miss: 'no_cik' }
    const f = nearestEarnings8k(list, report)
    if (!f) return { ...row, miss: 'no_8k' }
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(f.cik)}/${f.acc}`
    const idx = await get(`${base}/index.json`)
    const name = pickExhibit(idx?.directory?.item ?? [], f.primary)
    if (!name) return { ...row, filed: f.filed, miss: 'no_exhibit' }
    const html = await get(`${base}/${name}`, false)
    if (!html) return { ...row, filed: f.filed, miss: 'no_doc' }
    return { ...row, filed: f.filed, exhibit: name, ...guidanceText(html) }
}
const queue = [...todo]
await Promise.all(Array.from({ length: WORKERS }, async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
        // A failure is not written, so the next run tries it again.
        try { out.write(`${JSON.stringify(await readOne(w))}\n`) } catch (e) { failed++; console.log(`  failed ${w.symbol} ${w.report}: ${e.message}`) }
        if (++n % 250 === 0) console.log(`  ${n}/${todo.length} · failed ${failed}`)
    }
}))
await new Promise(r => out.end(r))
console.log(`done: ${n} read · ${failed} failed (run it again for those) → ${OUT}`)
process.exit(0)
