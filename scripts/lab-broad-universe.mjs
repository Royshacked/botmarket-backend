// THE BROAD UNIVERSE — US stocks outside the S&P 500, with the ones gone since (screener-lab.md §48, test Y). Small
// process: lists only, no bars. → data/lab/broad-universe.json `{ built_at, names: [{ symbol, sector, source }] }`.
//
//   node scripts/lab-broad-universe.mjs
//
// Sources: FMP's screener (actively trading, US, $300M+, NYSE / NASDAQ / AMEX); FMP's earnings calendar from CAL_FROM,
// week by week (one long read is capped at 4,000 rows), keeping the symbols no longer actively trading (gone since);
// FMP's delisted list (its first page — the plan gives no other). S&P 500 names are kept: the test drops them by date.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { fmpGet } = await import('../providers/fmp.price.provider.js')
const OUT = 'data/lab/broad-universe.json', CAL_FROM = '2025-11-10', EX = new Set(['NYSE', 'NASDAQ', 'AMEX'])
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const names = new Map()
const active = await fmpGet('/company-screener?country=US&isEtf=false&isFund=false&isActivelyTrading=true&marketCapMoreThan=300000000&limit=10000', { label: 'FMP screener' })
for (const r of active ?? []) if (EX.has(r.exchangeShortName) && r.symbol) names.set(r.symbol.toUpperCase(), { symbol: r.symbol.toUpperCase(), sector: r.sector ?? null, source: 'active' })
console.log(`active US $300M+: ${names.size}`)

// FMP's actively trading list (its stock list keeps delisted symbols: SIVB, HES, ANSS are in it, 2026-11-08).
const listed = new Set(((await fmpGet('/actively-trading-list', { label: 'FMP actively trading' })) ?? []).map(r => String(r.symbol).toUpperCase()))
const seen = new Set()
for (let t = Date.parse(CAL_FROM); t < Date.now(); t += 7 * 86_400_000) {
    const rows = (await fmpGet(`/earnings-calendar?from=${ymd(t)}&to=${ymd(t + 6 * 86_400_000)}`, { label: 'FMP calendar' })) ?? []
    if (rows.length >= 4000) console.log(`  ${ymd(t)}: a week hit the 4,000 cap`)
    for (const r of rows) seen.add(String(r.symbol).toUpperCase())
    await sleep(300)
}
let gone = 0
for (const s of seen) if (!listed.has(s) && !names.has(s) && !s.includes('.')) { names.set(s, { symbol: s, sector: null, source: 'calendar, gone since' }); gone++ }
console.log(`calendar ${CAL_FROM} →: ${seen.size} symbols · no longer listed: ${gone}`)

let del = 0
for (const r of (await fmpGet('/delisted-companies?page=0&limit=100', { label: 'FMP delisted' })) ?? []) {
    const s = String(r.symbol).toUpperCase()
    if (EX.has(r.exchange) && !names.has(s)) { names.set(s, { symbol: s, sector: null, source: 'delisted list' }); del++ }
}
console.log(`delisted list (first page): +${del}`)
fs.writeFileSync(OUT, JSON.stringify({ built_at: new Date().toISOString(), cal_from: CAL_FROM, names: [...names.values()] }))
console.log(`→ ${OUT}: ${names.size} names`)
process.exit(0)
