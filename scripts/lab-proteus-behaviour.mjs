#!/usr/bin/env node
// HOW ONE NAME MOVES — ITS BEHAVIOUR, NO HORIZON (Roy, 2026-11-21: "a behaviour — 1. best r:r 2. best standard dev for
// stops 3. maybe best standard dev for profits 4. the stock's regime behaviour; with r:r and levels I don't care about the
// horizon"). σ = the name's MONTHLY σ (the 60-day daily σ × √21), known at the entry.
//   A. STOPS × TARGETS in σ, held until one is hit (a 1-year cap only): win rate, never resolved, median days, return per
//      session held against holding, the two halves (split 2021-10), the years it beat holding. 0.1% cost.
//   B. ITS SWINGS: a zigzag on the closes that turns on a 1σ reversal — the runs up and the pullbacks, in σ and %, and
//      their sessions.
//   C. ITS REGIME BEHAVIOUR: after a strong 3-month fall / rise (the 63-session efficiency ratio in the top third of all
//      EARLIER days', by its sign), the next 63 / 126 sessions — counted as separate EPISODES (a new one only after 63
//      sessions without), not overlapping days.
//
//   node scripts/lab-proteus-behaviour.mjs [SYM=KO]

import fs from 'fs'

const SYM = (process.argv[2] ?? 'KO').toUpperCase()
const COST = 0.001, LOOK = 60, CAP = 252, HALF = Date.parse('2021-10-26T00:00:00Z') / 1000
const rows = JSON.parse(fs.readFileSync('data/lab/screener-10y.jsonl', 'utf8').split('\n').find(l => l.startsWith(`{"symbol":"${SYM}"`))).b
    .map(([t, , high, low, close]) => ({ t, high, low, close })).sort((a, b) => a.t - b.t)
const n = rows.length
const ret = rows.map((b, i) => (i ? b.close / rows[i - 1].close - 1 : 0))
const sdM = rows.map((_, i) => { if (i < LOOK) return null; const w = ret.slice(i - LOOK + 1, i + 1), m = w.reduce((s, x) => s + x, 0) / LOOK; return Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / (LOOK - 1)) * Math.sqrt(21) })
const yr = (i) => new Date(rows[i].t * 1000).getUTCFullYear()
const q = (xs, p) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null }
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`

console.log(`# ${SYM} — how it moves, no horizon (σ = its monthly σ, known at the entry; median ${pct(q(sdM.filter(Boolean), 0.5))})`)

// ─── A ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const STOPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3], TGTS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]
const cells = {}
const holdAcc = { all: [0, 0], older: [0, 0], recent: [0, 0] }, holdYr = {}
for (let i = LOOK; i + 1 < n; i++) {
    const s = sdM[i]
    if (!s) continue
    const c = rows[i].close, part = rows[i].t < HALF ? 'older' : 'recent', y = yr(i)
    for (const k of STOPS) for (const T of TGTS) {
        const stop = c * (1 - k * s), tgt = c * (1 + T * s)
        let r = null, h = null, how = 'open'
        const end = Math.min(n - 1, i + CAP)
        for (let j = i + 1; j <= end; j++) {
            if (rows[j].low <= stop) { r = stop / c - 1 - COST; h = j - i; how = 'stop'; break }
            if (rows[j].high >= tgt) { r = tgt / c - 1 - COST; h = j - i; how = 'win'; break }
        }
        if (how === 'open') { if (i + CAP >= n) continue; r = rows[end].close / c - 1 - COST; h = CAP }
        const key = `${k}|${T}`, cell = (cells[key] ??= { all: [0, 0], older: [0, 0], recent: [0, 0], yrs: {}, n: 0, win: 0, open: 0, days: [] })
        for (const p of ['all', part]) { cell[p][0] += r; cell[p][1] += h }
        const cy = (cell.yrs[y] ??= [0, 0]); cy[0] += r; cy[1] += h
        cell.n++; if (how === 'win') cell.win++; if (how === 'open') cell.open++; cell.days.push(h)
    }
    // Holding: the same entries, held a year (the cap) — per session.
    if (i + CAP < n) { const r = rows[i + CAP].close / c - 1 - COST; for (const p of ['all', part]) { holdAcc[p][0] += r; holdAcc[p][1] += CAP } const hy = (holdYr[y] ??= [0, 0]); hy[0] += r; hy[1] += CAP }
}
const perYr = (a) => (a[0] / a[1]) * 25200
const holdAll = perYr(holdAcc.all), holdO = perYr(holdAcc.older), holdR = perYr(holdAcc.recent)
const list = Object.entries(cells).map(([key, c]) => {
    const [k, T] = key.split('|').map(Number)
    const years = Object.keys(c.yrs).filter(y => holdYr[y])
    return { k, T, vs: perYr(c.all) - holdAll, o: perYr(c.older) - holdO, r: perYr(c.recent) - holdR, win: c.win / c.n, open: c.open / c.n, med: q(c.days, 0.5), beat: years.filter(y => perYr(c.yrs[y]) > perYr(holdYr[y])).length, nyr: years.length }
}).sort((a, b) => b.vs - a.vs)
console.log(`\n## A. Stops × targets in σ, held until one is hit (1-year cap) — holding ${holdAll.toFixed(1)}% a year (2016–21 ${holdO.toFixed(1)}%, 2021–26 ${holdR.toFixed(1)}%); ${list.filter(x => x.vs > 0).length} of ${list.length} beat it`)
console.log('  stop   target  r:r    vs hold    2016–21  2021–26   win   never   median days   years beat')
const row = (x) => `  ${`${x.k}σ`.padEnd(6)} ${`${x.T}σ`.padEnd(6)}  ${`1:${+(x.T / x.k).toFixed(2)}`.padEnd(6)} ${x.vs.toFixed(1).padStart(5)}%/yr  ${x.o.toFixed(1).padStart(6)}   ${x.r.toFixed(1).padStart(6)}   ${pct(x.win, 0).padStart(4)}  ${pct(x.open, 0).padStart(5)}   ${String(x.med).padStart(6)}        ${x.beat}/${x.nyr}`
for (const x of list.slice(0, 10)) console.log(row(x))
console.log('  …')
for (const x of list.slice(-3)) console.log(row(x))
const steady = [...list].sort((a, b) => Math.min(b.o, b.r) - Math.min(a.o, a.r))[0]
console.log(`  steadiest (the best of the worse half): ${steady.k}σ stop, ${steady.T}σ target — 2016–21 ${steady.o.toFixed(1)}, 2021–26 ${steady.r.toFixed(1)}% a year vs hold`)

// ─── B ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const legs = []
{
    let dir = 0, ext = LOOK, start = LOOK
    for (let i = LOOK + 1; i < n; i++) {
        const s = sdM[i], c = rows[i].close
        if (dir >= 0 && c >= rows[ext].close) { ext = i; if (dir === 0) dir = 1 }
        if (dir <= 0 && c <= rows[ext].close) { ext = i; if (dir === 0) dir = -1 }
        const turn = dir > 0 ? c <= rows[ext].close * (1 - s) : dir < 0 ? c >= rows[ext].close * (1 + s) : false
        if (turn) { legs.push({ up: dir > 0, size: rows[ext].close / rows[start].close - 1, sig: sdM[ext], bars: ext - start }); start = ext; ext = i; dir = -dir }
    }
}
const up = legs.filter(l => l.up && l.sig), dn = legs.filter(l => !l.up && l.sig)
const describe = (ls) => `median ${pct(q(ls.map(l => Math.abs(l.size)), 0.5))} = ${q(ls.map(l => Math.abs(l.size) / l.sig), 0.5).toFixed(2)}σ (middle half ${q(ls.map(l => Math.abs(l.size) / l.sig), 0.25).toFixed(2)}–${q(ls.map(l => Math.abs(l.size) / l.sig), 0.75).toFixed(2)}σ), ${q(ls.map(l => l.bars), 0.5)} sessions`
console.log(`\n## B. Its swings — a zigzag turning on a 1σ reversal (${legs.length} legs)`)
console.log(`  runs up:    ${describe(up)}  (${up.length})`)
console.log(`  pullbacks:  ${describe(dn)}  (${dn.length})`)

// ─── C ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ERL = 63, seen = [], reg = new Array(n).fill(null)
for (let i = ERL; i < n; i++) {
    let path = 0
    for (let k = i - ERL + 1; k <= i; k++) path += Math.abs(rows[k].close - rows[k - 1].close)
    const er = path ? (rows[i].close - rows[i - ERL].close) / path : 0, a = Math.abs(er)
    if (seen.length >= 250) { let below = 0; for (const x of seen) if (x < a) below++; if (below / seen.length > 2 / 3) reg[i] = er > 0 ? 'rise' : 'fall' }
    seen.push(a)
}
console.log('\n## C. After a strong 3-month move — the next 63 / 126 sessions, by EPISODE (a new one only after 63 sessions without)')
for (const kind of ['fall', 'rise']) {
    const eps = []
    let last = -Infinity
    for (let i = 0; i < n; i++) if (reg[i] === kind && i - last > 63) { eps.push(i); last = i } else if (reg[i] === kind) last = i
    const nx = (h) => eps.filter(i => i + h < n).map(i => rows[i + h].close / rows[i].close - 1)
    const r63 = nx(63), r126 = nx(126)
    console.log(`  after a strong ${kind}: ${eps.length} episodes — next 63: median ${r63.length ? pct(q(r63, 0.5)) : '—'}, up in ${r63.filter(x => x > 0).length}/${r63.length} · next 126: median ${r126.length ? pct(q(r126, 0.5)) : '—'}, up in ${r126.filter(x => x > 0).length}/${r126.length}`)
    console.log(`    ${eps.map(i => `${new Date(rows[i].t * 1000).toISOString().slice(0, 7)} ${i + 63 < n ? pct(rows[i + 63].close / rows[i].close - 1, 0) : '—'}`).join(' · ')}`)
}
const any63 = []
for (let i = 0; i + 63 < n; i += 63) any63.push(rows[i + 63].close / rows[i].close - 1)
console.log(`  any 63 sessions (non-overlapping): median ${pct(q(any63, 0.5))}, up in ${any63.filter(x => x > 0).length}/${any63.length}`)

// ─── D. REGRESSION LINES AND ANGLES (Roy, 2026-11-21: "also what about regression lines and angles?") ─────────────────
// Over the last 63 sessions of log closes: the line's ANGLE (% a month), its R² (how straight), and the STRETCH — the
// close's distance from the line in units of the line's residual σ. All known at the bar.
{
    const W = 63, lc = rows.map(b => Math.log(b.close))
    const fit = (i) => {
        let sx = 0, sy = 0, sxx = 0, sxy = 0
        for (let k = 0; k < W; k++) { const x = k, y = lc[i - W + 1 + k]; sx += x; sy += y; sxx += x * x; sxy += x * y }
        const b = (W * sxy - sx * sy) / (W * sxx - sx * sx), a = (sy - b * sx) / W
        let ssr = 0, sst = 0
        const my = sy / W
        for (let k = 0; k < W; k++) { const y = lc[i - W + 1 + k], e = y - (a + b * k); ssr += e * e; sst += (y - my) ** 2 }
        const rs = Math.sqrt(ssr / (W - 2))
        return { slope: b, r2: sst ? 1 - ssr / sst : 0, z: rs ? (lc[i] - (a + b * (W - 1))) / rs : 0 }
    }
    const F = rows.map((_, i) => (i >= W ? fit(i) : null))
    const month = (b) => Math.exp(b * 21) - 1
    console.log('\n## D. Regression lines and angles — the line through the last 63 sessions (log closes)')
    const all = F.filter(Boolean)
    console.log(`  its angle: median ${pct(month(q(all.map(f => f.slope), 0.5)))} a month (middle half ${pct(month(q(all.map(f => f.slope), 0.25)))} … ${pct(month(q(all.map(f => f.slope), 0.75)))}); R² median ${q(all.map(f => f.r2), 0.5).toFixed(2)} (a straight line 1, noise 0)`)

    // D2. Does the angle persist? Consecutive NON-overlapping 63-session windows: the angle, then the next window's angle and return.
    const wins = []
    for (let i = W; i + W < n; i += W) wins.push({ a: F[i].slope, r2: F[i].r2, nextA: F[i + W].slope, next: rows[i + W].close / rows[i].close - 1 })
    const corr = (xs, ys) => { const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length; let nu = 0, vx = 0, vy = 0; for (let k = 0; k < xs.length; k++) { nu += (xs[k] - mx) * (ys[k] - my); vx += (xs[k] - mx) ** 2; vy += (ys[k] - my) ** 2 } return nu / Math.sqrt(vx * vy) }
    console.log(`  does the angle persist? ${wins.length} separate 3-month windows — the angle's correlation with the next window's angle ${corr(wins.map(w => w.a), wins.map(w => w.nextA)).toFixed(2)}, with the next window's return ${corr(wins.map(w => w.a), wins.map(w => w.next)).toFixed(2)}`)
    const t3 = [...wins].sort((x, y) => x.a - y.a), third = Math.floor(t3.length / 3)
    const nextOf = (ws) => `median ${pct(q(ws.map(w => w.next), 0.5))}, up in ${ws.filter(w => w.next > 0).length}/${ws.length}`
    console.log(`    after the steepest-down third: ${nextOf(t3.slice(0, third))} · the middle: ${nextOf(t3.slice(third, t3.length - third))} · the steepest-up third: ${nextOf(t3.slice(t3.length - third))}`)
    const straight = wins.filter(w => w.r2 >= 0.6)
    console.log(`    when the line was STRAIGHT (R² ≥ 0.6, ${straight.length} windows): the angle vs the next return ${straight.length > 4 ? corr(straight.map(w => w.a), straight.map(w => w.next)).toFixed(2) : '—'}`)

    // D3. The stretch from the line: episodes of z ≤ −2 / ≥ +2 (a new one only after 21 sessions without), the next 21 / 63.
    for (const [name, test] of [['2 or more BELOW the line', (z) => z <= -2], ['2 or more ABOVE the line', (z) => z >= 2]]) {
        const eps = []
        let last = -Infinity
        for (let i = W; i < n; i++) if (test(F[i].z)) { if (i - last > 21) eps.push(i); last = i }
        const nx = (h) => eps.filter(i => i + h < n).map(i => rows[i + h].close / rows[i].close - 1)
        const r21 = nx(21), r63 = nx(63)
        console.log(`  stretched ${name}: ${eps.length} episodes — next 21: median ${r21.length ? pct(q(r21, 0.5)) : '—'}, up in ${r21.filter(x => x > 0).length}/${r21.length} · next 63: median ${r63.length ? pct(q(r63, 0.5)) : '—'}, up in ${r63.filter(x => x > 0).length}/${r63.length}`)
    }
    const any21 = []
    for (let i = W; i + 21 < n; i += 21) any21.push(rows[i + 21].close / rows[i].close - 1)
    console.log(`  any 21 sessions (non-overlapping): median ${pct(q(any21, 0.5))}, up in ${any21.filter(x => x > 0).length}/${any21.length}`)
}
