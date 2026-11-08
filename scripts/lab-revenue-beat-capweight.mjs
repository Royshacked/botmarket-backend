// THE REVENUE BEAT, WEIGHTED BY SIZE, AGAINST SPY — test W (declared in screener-lab.md §46, before the run). Roy,
// 2026-11-08: "yes declare test W". §45's one signal (a revenue beat of 10%+, test Q's picks) beats the average stock
// but not SPY, which is weighted by size: the same picks weighted by market cap, against SPY.
//
//   node --max-old-space-size=6000 scripts/lab-revenue-beat-capweight.mjs
//
// Offline: data/lab caches + sec-facts.jsonl. Always against SPY (LAB_BENCH is ignored: the equal-weight market is
// built here, for the overlay's arithmetic only).
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
delete process.env.LAB_BENCH
const { holdTrades, holdBook, bookBlocks } = await import('../services/holdToNext.service.js')
const { prepareFundamentals, fundamentalsAt } = await import('../services/secFundamentals.service.js')
const { loadLabData, equalWeightBars } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const FROM = '2020-01-01', SPLIT = '2024-01-01', MIN = 10, TOP = 100, BORROW_PER_MONTH = 0.5 / 12
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member, bench: 'spy' })
await closeDb()
const facts = new Map(fs.readFileSync('data/lab/sec-facts.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.c).map(r => [r.symbol, prepareFundamentals(r.c)]))
const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)

/** Shares outstanding as known on `day` (on today's split basis), from the market cap fundamentalsAt gives at a price. */
const sharesOn = (symbol, day) => { const m = fundamentalsAt(facts.get(symbol), day, 1).mcap_log; return m == null ? null : 10 ** m }

// Test Q's trades, its two holds.
const base = holdTrades(data, { from: FROM, member }).trades
for (const t of base) {
    const s = data.names.get(t.symbol), rep = s.reports.get(s.ind.date[t.i - 2])
    const a = Number(rep?.revenueActual), e = Number(rep?.revenueEstimated)
    t.rev = a > 0 && e > 0 ? (a / e - 1) * 100 : null
    t.shares = sharesOn(t.symbol, s.ind.date[t.i - 1])
    t.mcap = t.shares ? t.shares * s.rows[t.i - 1].close : null
}
function heldFor(t, h) {
    if (h === 'next') return t
    const x = Math.min(t.i + h - 1, t.x)
    const s = data.names.get(t.symbol), s0 = data.spyByDay.get(s.ind.date[t.i]), s1 = data.spyByDay.get(s.ind.date[x])
    const ret = pct(s.rows[x].close, s.rows[t.i].open), spy = pct(s1?.close, s0?.open)
    return ret == null || spy == null ? null : { ...t, x, held: x - t.i + 1, ret, spy, net: ret - spy - t.cost }
}
// The cap at the prior close: the shares known at entry × that session's prior close.
const capWeight = (t, j) => (t.shares ? t.shares * data.names.get(t.symbol).rows[j - 1].close : null)

// The 100 largest members, by month: the cut is the 100th-largest cap at the month's first session.
const topCut = new Map()
for (const d of data.spyDays.filter(x => x >= FROM)) {
    const m = d.slice(0, 7)
    if (topCut.has(m)) continue
    const caps = []
    for (const [symbol, s] of data.names) {
        if (!member(symbol, d) || !facts.has(symbol)) continue
        const k = s.ind.date.indexOf(d)
        if (k < 1) continue
        const sh = sharesOn(symbol, s.ind.date[k - 1])
        if (sh) caps.push(sh * s.rows[k - 1].close)
    }
    caps.sort((a, b) => b - a)
    topCut.set(m, caps[TOP - 1] ?? Infinity)
}
const inTop = (t) => t.mcap != null && t.mcap >= topCut.get(t.day.slice(0, 7))

const days = data.spyDays.filter(d => d >= FROM)
const dataEw = { ...data, spyByDay: equalWeightBars(data.names, data.spyDays, data.spyRealByDay, member) }
const read = (ts, opts, d = data) => {
    const b = holdBook(d, ts, opts)
    return { n: ts.length, whole: bookBlocks(b, days), before: bookBlocks(b, days.filter(x => x < SPLIT)), after: bookBlocks(b, days.filter(x => x >= SPLIT)) }
}
const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const line = (label, r) => console.log(`    ${label.padEnd(40)} ${String(r.n).padStart(5)} · book/mo ${f2(r.whole?.mean)} t ${r.whole?.t?.toFixed(2) ?? '—'} · before ${f2(r.before?.mean)} after ${f2(r.after?.mean)}`)

const sig = (t) => t.rev != null && t.rev >= MIN
console.log(`${base.length} reports · revenue beat ${MIN}%+ ${base.filter(sig).length} · with SEC shares ${base.filter(t => sig(t) && t.shares).length} · entries ${FROM} →, split ${SPLIT} · against SPY, net of the cost`)
const res = {}
for (const h of [40, 'next']) {
    const all = base.map(t => heldFor(t, h)).filter(Boolean), withCap = all.filter(t => t.shares), picks = withCap.filter(sig)
    console.log(`\n── HELD ${h === 'next' ? 'TO THE NEXT REPORT' : `${h} SESSIONS`}`)
    const cw = read(picks, { weight: capWeight }), ctl = read(withCap, { weight: capWeight })
    res[h] = { cw, ctl }
    line('PICKS, CAP-WEIGHTED (primary)', cw)
    line('picks, equal weight (same picks)', read(picks))
    line('every report, cap-weighted (control)', ctl)
    line('every report, equal weight', read(withCap))
    const top = picks.filter(inTop)
    line(`picks in the ${TOP} largest, cap-weighted`, read(top, { weight: capWeight }))
    line(`picks in the ${TOP} largest, equal weight`, read(top))
    line(`every report in the ${TOP} largest, cap-weighted`, read(withCap.filter(inTop), { weight: capWeight }))
    // The overlay: SPY + k × (long the picks, short the equal-weight market). Its excess over SPY is k × the picks'
    // equal-weight book against the equal-weight market, less the short's borrow (assumed 0.5% a year on the short).
    const ov = read(picks, {}, dataEw)
    console.log(`    overlay (SPY + long picks / short the equal-weight market; needs a short, e.g. RSP): the picks vs the equal-weight market ${f2(ov.whole?.mean)} t ${ov.whole?.t?.toFixed(2)} (before ${f2(ov.before?.mean)} after ${f2(ov.after?.mean)})`)
    for (const k of [0.25, 0.5, 1]) console.log(`      at ${(k * 100).toFixed(0).padStart(3)}% of the account: vs SPY ${f2(ov.whole?.mean == null ? null : k * (ov.whole.mean - BORROW_PER_MONTH))} a month (≈ ${f2(ov.whole?.mean == null ? null : 12 * k * (ov.whole.mean - BORROW_PER_MONTH))} a year)`)
}

const p = res[40], nx = res.next
const aboveSpy = p.cw.before?.mean > 0 && p.cw.after?.mean > 0, aboveCtl = p.cw.before?.mean > p.ctl.before?.mean && p.cw.after?.mean > p.ctl.after?.mean
const sigT = p.cw.whole?.t >= 2, nb = nx.cw.before?.mean > 0 && nx.cw.after?.mean > 0
console.log(`\nDECLARED BAR (cap-weighted, 40 sessions): above SPY in both periods ${aboveSpy} · above the cap-weighted control in both ${aboveCtl} · t ≥ 2 ${sigT} (${p.cw.whole?.t?.toFixed(2)}) · to the next report above SPY in both ${nb} → ${aboveSpy && aboveCtl && sigT && nb ? 'PASS' : 'FAIL'}`)
process.exit(0)
