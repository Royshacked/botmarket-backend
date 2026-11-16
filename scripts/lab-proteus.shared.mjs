// THE PROTEUS LABS' SHARED PIPE (docs/design/proteus.md §10.2–10.3): the bars, the noise control, the per-name tally and
// the pooled report — one copy for lab-proteus-combos.mjs and lab-proteus-stops.mjs. The JUDGMENT is the engine's own
// (`judge`, PROFILE as built); this file only feeds it and counts.

import fs from 'fs'
import readline from 'readline'

const ROOT = new URL('../', import.meta.url)
export const E = await import(new URL('services/behaviourProfile.engine.js', ROOT))
export const { calcATRSeries, calcSMASeries, calcEMASeries, calcRSISeries, calcMACDSeries } = await import(new URL('monitoring/evaluators/structured.evaluator.js', ROOT))
export const P = E.PROFILE
/** The pooled split, by date — like §10.1 and tests 4–4d. */
export const HELD_OUT = Date.parse('2026-03-01T00:00:00Z') / 1000

export const atrsOf = (bars) => calcATRSeries(bars.map(b => ({ t: b.timestamp * 1000, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })), P.atrPeriod)
export const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null }
export const seedOf = (s) => String(s).split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
export const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`)

/** The weakest of several judge() verdicts — a combination must beat EVERY baseline (wyckoffTest's spring rule). */
export function weakest(verdicts) {
    for (const v of ['thin', 'no', 'faded', 'unconfirmed']) if (verdicts.includes(v)) return v
    return 'respects'
}

/** Every screener name's daily bars (cleaned, ≥ 260), one at a time. */
export function* dailyNames(file = 'data/lab/screener-3y.json') {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const [sym, bars0] of Object.entries(raw.names)) {
        const bars = (bars0 ?? []).filter(b => b?.close > 0 && b?.open > 0 && b.high >= b.low)
        if (bars.length >= 260) yield [sym, bars]
    }
}

/** The 10-year daily bars (lab-proteus-fetch10y.mjs), one name at a time (cleaned, ≥ 260; SPY left out). */
export async function* dailyNames10y(file = 'data/lab/screener-10y.jsonl') {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
        if (!line) continue
        const { symbol, b } = JSON.parse(line)
        if (!b?.length || symbol === 'SPY') continue
        const bars = b.map(([t, o, h, l, c, v]) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v }))
            .filter(x => x.close > 0 && x.open > 0 && x.high >= x.low).sort((x, y) => x.timestamp - y.timestamp)
        if (bars.length >= 260) yield [symbol, bars]
    }
}

/** Test 4's 5-minute name-weeks (regular hours), one at a time. */
export async function* fiveMinuteWeeks(file = 'data/lab/daytrade-5m.jsonl') {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
        if (!line) continue
        const { key, bars } = JSON.parse(line)
        if (!bars?.length) continue
        const b5 = bars.map(([t, o, h, l, c, v]) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v })).filter(b => b.close > 0 && b.high >= b.low)
        if (b5.length >= 260) yield [key, b5]
    }
}

/**
 * The tally: per test, the per-name verdicts (real / shuffled) and the pooled outcomes (real / shuffled × older /
 * recent × group). A test's groups: 'event' plus its baselines (any names).
 */
export function makeTally() {
    const verdicts = {}, flagged = {}, pooled = {}
    const inc = (o, k) => { o[k] = (o[k] ?? 0) + 1 }
    return {
        verdict(test, side, v, sym) {
            inc((verdicts[test] ??= { real: {}, shuf: {} })[side], v)
            if (side === 'real' && v === 'respects') (flagged[test] ??= []).push(sym)
        },
        pool(test, side, group, bars, events) {
            const t = (pooled[test] ??= { real: {}, shuf: {} })
            for (const e of events) {
                if (!e.out) continue
                const part = bars[e.i].timestamp >= HELD_OUT ? 'recent' : 'older'
                const c = ((t[side][part] ??= {})[group] ??= [0, 0])
                c[0]++
                if (e.out === 'win') c[1]++
            }
        },
        verdicts, flagged, pooled,
    }
}

const order = (o) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'

/**
 * The report and the declared PASS (§10.2): per name — real `respects` ≥ 2× the shuffled AND ≥ 10 more; pooled — the
 * event beats its STRONGEST baseline by ≥ 3 points, the 95% interval above 0, older AND recent.
 */
export function report(tally, tests, say, { perName = true } = {}) {
    const verdictOf = {}
    for (const { key, label } of tests) {
        say(`\n### ${label}`)
        let traitPass = false
        if (perName) {
            const v = tally.verdicts[key] ?? { real: {}, shuf: {} }
            const r = v.real.respects ?? 0, s = v.shuf.respects ?? 0
            traitPass = r >= 2 * s && r >= s + 10
            say(`per name — real:     ${order(v.real)}`)
            say(`           shuffled: ${order(v.shuf)}`)
            say(`respects: real ${r} vs shuffled ${s} → ${traitPass ? 'PASS (a trait of some names)' : 'no'}${(tally.flagged[key] ?? []).length ? `  [${tally.flagged[key].slice(0, 40).join(' ')}${tally.flagged[key].length > 40 ? ' …' : ''}]` : ''}`)
        }
        const pl = tally.pooled[key] ?? {}
        let edgePass = { real: true, shuf: true }
        for (const side of ['real', 'shuf']) for (const part of ['older', 'recent']) {
            const g = pl[side]?.[part] ?? {}
            const [en, ew] = g.event ?? [0, 0]
            const a = en ? ew / en : null
            const bases = Object.entries(g).filter(([k]) => k !== 'event').map(([k, [n, w]]) => ({ k, n, rate: n ? w / n : null }))
            const strongest = bases.filter(b => b.rate != null).sort((x, y) => y.rate - x.rate)[0]
            let line = `  ${(side === 'real' ? 'real' : 'shuffled').padEnd(9)} ${part.padEnd(7)} event ${pct(a)} (n ${en})`
            for (const b of bases) line += `  ${b.k} ${pct(b.rate)} (n ${b.n})`
            if (a != null && strongest) {
                const d = a - strongest.rate, se = Math.sqrt(a * (1 - a) / en + strongest.rate * (1 - strongest.rate) / strongest.n)
                line += `  vs strongest (${strongest.k}) ${(d * 100).toFixed(1)} pts [${((d - 1.96 * se) * 100).toFixed(1)} … ${((d + 1.96 * se) * 100).toFixed(1)}]`
                if (!(d >= 0.03 && d - 1.96 * se > 0)) edgePass[side] = false
            } else edgePass[side] = false
            say(line)
        }
        say(`pooled edge: ${edgePass.real ? 'PASS (an edge everywhere)' : 'no'}${edgePass.shuf ? '  — WARNING: the shuffled control passes too' : ''}`)
        verdictOf[key] = { trait: traitPass, edge: edgePass.real }
    }
    return verdictOf
}
