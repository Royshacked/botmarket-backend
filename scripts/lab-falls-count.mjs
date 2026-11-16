#!/usr/bin/env node
// THE FALL WITH THE BUSINESS INTACT — A COUNT (Roy, 2026-11-16, on LNG from 22 June 2026: "yes start with the count").
// Declared in docs/design/screener-lab.md §52 before the run. A description, not a test. Reads the lab's caches only.
//
//   node --max-old-space-size=4000 scripts/lab-falls-count.mjs   → data/lab/falls-count.out.txt

import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { loadLabData, equalWeightBars } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { prepareFundamentals, prepareCashFlow, cashFlowAt, fundamentalsAt, lastQuarterNi } = await import('../services/secFundamentals.service.js')

const TO = '2026-10-26', WARMUP = 260, COVERAGE = 0.9
/** §52, fixed before the run. */
export const RULE = { fallPct: 20, look: 60, forward: 63, minPrice: 5, analystDays: 90, targetUpside: 20, split: '2023-01-01', analystFrom: '2023-09-01' }

const DAY = 86_400_000
const minus = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10)
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }

/** The falls of one name: the first close ≥ fallPct under the highest close of the `look` sessions before; one per `look` sessions. Pure. */
export function falls(closes, from = 0, rule = RULE) {
    const out = []
    let last = -Infinity
    for (let i = Math.max(from, rule.look); i < closes.length; i++) {
        if (i - last <= rule.look) continue
        let hi = -Infinity
        for (let j = i - rule.look; j < i; j++) hi = Math.max(hi, closes[j])
        if (closes[i] <= hi * (1 - rule.fallPct / 100)) { out.push({ i, hi }); last = i }
    }
    return out
}

/** The analysts on `day`: null when no notes in the window; else whether none downgraded and the median target's upside. Pure. */
export function analystsAt(grades, targets, day, close, rule = RULE) {
    const from = minus(day, rule.analystDays)
    const t = (targets ?? []).filter(r => r[0] > from && r[0] <= day && r[1] > 0).map(r => r[1])
    if (!t.length) return null
    const down = (grades ?? []).some(g => g[0] > from && g[0] <= day && g[1] === 'downgrade')
    const upside = (median(t) / close - 1) * 100
    return { down, upside, stayed: !down && upside >= rule.targetUpside }
}

if (process.argv[1]?.endsWith('lab-falls-count.mjs')) {   // run, not imported (the unit test imports it)
    const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
    const member = (sym, day) => memberOn(u.spans, sym, day)
    const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: TO }, extras: [], member })
    const days = data.spyDays.slice(WARMUP)
    const covered = []
    for (const sym of Object.keys(u.spans)) {
        const inIdx = days.filter(d => member(sym, d)), s = data.names.get(sym)
        if (!inIdx.length || !s) continue
        const have = new Set(s.ind.date)
        if (inIdx.filter(d => have.has(d)).length / inIdx.length >= COVERAGE) covered.push(sym)
    }
    const ew = equalWeightBars(data.names, data.spyDays, data.spyRealByDay, member)
    const spy = data.spyRealByDay
    const spyIdx = new Map(data.spyDays.map((d, k) => [d, k]))
    const readJsonl = (f) => new Map(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => [r.symbol, r.c]))
    const facts = readJsonl('data/lab/sec-facts.jsonl'), cash = readJsonl('data/lab/sec-cashflow.jsonl')
    const an = JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8'))

    const events = []
    for (const sym of covered) {
        const s = data.names.get(sym), rows = s.rows, date = s.ind.date, closes = rows.map(r => r.close)
        const f = prepareFundamentals(facts.get(sym)), cfq = prepareCashFlow(cash.get(sym))
        for (const { i, hi } of falls(closes, WARMUP)) {
            const day = date[i], end = i + RULE.forward
            if (!member(sym, day) || closes[i] < RULE.minPrice || end >= rows.length) continue
            const k = spyIdx.get(day), endDay = date[end]
            const sk = spyIdx.get(endDay)
            if (k == null || sk == null) continue
            const ret = closes[end] / closes[i] - 1
            const spyRet = spy.get(endDay).close / spy.get(day).close - 1, ewRet = ew.get(endDay).close / ew.get(day).close - 1
            const ni = lastQuarterNi(f, day), cf = cashFlowAt(cfq, day), fa = fundamentalsAt(f, day, closes[i])
            const mcap = fa.mcap_log != null ? 10 ** fa.mcap_log : null
            const known = ni != null && cf.ocf_q != null && cf.ocf_ttm != null && cf.ocf_q_end === ni.end
            const fcfy = mcap && cf.fcf_ttm != null ? cf.fcf_ttm / mcap * 100 : null
            const a = analystsAt(an.grades?.[sym], an.targets?.[sym], day, closes[i])
            events.push({
                sym, day, drop: (closes[i] / hi - 1) * 100, ret, netSpy: ret - spyRet, netEw: ret - ewRet,
                period: day < RULE.split ? '2019–2022' : '2023 →',
                paper: known ? (ni.val < 0 && cf.ocf_q > 0 && cf.ocf_ttm > 0) : null,
                fcfy, fcfBand: fcfy == null ? null : fcfy < 0 ? '< 0' : fcfy < 4 ? '0–4%' : fcfy < 8 ? '4–8%' : '≥ 8%',
                analysts: day >= RULE.analystFrom ? a : null,
            })
        }
    }

    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`)
    const row = (label, xs) => {
        if (!xs.length) return `  ${label.padEnd(30)} n 0`
        const m = (k) => xs.reduce((t, e) => t + e[k], 0) / xs.length
        return `  ${label.padEnd(30)} n ${String(xs.length).padStart(5)}  return ${pct(m('ret')).padStart(7)}  net SPY ${pct(m('netSpy')).padStart(7)} (median ${pct(median(xs.map(e => e.netSpy))).padStart(7)})  net EW ${pct(m('netEw')).padStart(7)}  beat SPY 5%+ ${(xs.filter(e => e.netSpy >= 0.05).length / xs.length * 100).toFixed(0)}%`
    }
    say(`# The fall with the business intact — a count (${new Date().toISOString().slice(0, 10)}) — screener-lab.md §52`)
    say(`S&P 500 point-in-time, ${covered.length} names, ${data.spyDays[WARMUP]} → ${TO}. A fall = a close ≥ ${RULE.fallPct}% under the ${RULE.look}-session high; what followed over ${RULE.forward} sessions.`)
    say(`facts known: paper-loss check ${events.filter(e => e.paper != null).length} of ${events.length} · FCF yield ${events.filter(e => e.fcfy != null).length} · analysts (screener names from ${RULE.analystFrom}) ${events.filter(e => e.analysts != null).length}`)

    say('\n## Sanity: LNG')
    for (const e of events.filter(x => x.sym === 'LNG')) say(`  ${e.day} drop ${e.drop.toFixed(1)}% · paper ${e.paper} · FCF yield ${e.fcfy?.toFixed(1) ?? '—'}% · analysts ${e.analysts ? `${e.analysts.stayed ? 'stayed' : 'no'} (upside ${e.analysts.upside.toFixed(0)}%, downgrade ${e.analysts.down})` : '—'} · next ${RULE.forward}: ${pct(e.ret)} (net SPY ${pct(e.netSpy)})`)

    for (const period of ['2019–2022', '2023 →']) {
        const P = events.filter(e => e.period === period)
        say(`\n## ${period}`)
        say(row('every fall', P))
        say('1. paper loss, cash in')
        say(row('   yes', P.filter(e => e.paper === true)))
        say(row('   no (same facts known)', P.filter(e => e.paper === false)))
        say('2. free-cash-flow yield')
        for (const b of ['< 0', '0–4%', '4–8%', '≥ 8%']) say(row(`   ${b}`, P.filter(e => e.fcfBand === b)))
        if (period === '2023 →') {
            say('3. the analysts stayed (no downgrade in 90 days, median target ≥ 20% over)')
            say(row('   yes', P.filter(e => e.analysts?.stayed === true)))
            say(row('   no (notes known)', P.filter(e => e.analysts?.stayed === false)))
            say('all three')
            say(row('   yes', P.filter(e => e.paper === true && e.fcfBand === '≥ 8%' && e.analysts?.stayed === true)))
            say(row('   ≥ 8% FCF and analysts stayed', P.filter(e => e.fcfBand === '≥ 8%' && e.analysts?.stayed === true)))
        }
    }

    say('\n## Worth a declared test? (§52: the fact\'s falls beat the falls without it by ≥ 2 points net of SPY, BOTH periods, ≥ 100 events each)')
    const gap = (yes, no) => (yes.length && no.length ? yes.reduce((t, e) => t + e.netSpy, 0) / yes.length - no.reduce((t, e) => t + e.netSpy, 0) / no.length : null)
    const check = (label, yesOf, noOf, periods) => {
        const parts = periods.map(p => { const P = events.filter(e => e.period === p), y = P.filter(yesOf), n = P.filter(noOf); return { p, y: y.length, n: n.length, g: gap(y, n) } })
        const ok = periods.length === 2 && parts.every(x => x.y >= 100 && x.n >= 100 && x.g != null && x.g >= 0.02)
        say(`  ${label}: ${parts.map(x => `${x.p} ${pct(x.g)} (${x.y} vs ${x.n})`).join(' · ')} → ${ok ? 'WORTH A TEST' : periods.length < 2 ? 'no (one period: §52 needs both)' : 'no'}`)
    }
    check('1. paper loss, cash in', e => e.paper === true, e => e.paper === false, ['2019–2022', '2023 →'])
    check('2. FCF yield ≥ 8%', e => e.fcfBand === '≥ 8%', e => e.fcfBand != null && e.fcfBand !== '≥ 8%', ['2019–2022', '2023 →'])
    check('3. analysts stayed (one period only — cannot pass "both")', e => e.analysts?.stayed === true, e => e.analysts?.stayed === false, ['2023 →'])
    fs.writeFileSync('data/lab/falls-count.out.txt', lines.join('\n') + '\n')
    console.log('→ data/lab/falls-count.out.txt')
    process.exit(0)
}
