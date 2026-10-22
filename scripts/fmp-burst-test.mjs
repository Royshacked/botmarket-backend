// FMP RATE-LIMIT BURST TEST (docs/design/daily-names.md §6, §10) — how many requests a minute this
// key takes before FMP answers 429, and how long it takes to answer again afterwards.
//
//   node scripts/fmp-burst-test.mjs                 the plan and the clock check only — sends nothing
//   node scripts/fmp-burst-test.mjs --run           run it
//     --rates 120,240,360,480,600,900,1200         requests/minute per step (default shown)
//     --step-sec 60                                 how long each step lasts
//     --out <file.json>                             also write every step and the result as JSON
//     --force                                       run inside the guarded hours anyway (don't)
//     --base <url>                                  a stand-in server instead of FMP (self-check only)
//
// WHY IT EXISTS. The DailyScreener (DAILY_SCREENER, off) paces itself at DAILY_SCREENER_RPM = 60 on a
// key it shares with live pricing — ~145 /quote a minute in session on the dev backend alone — and
// FMP publishes no rate-limit headers, so nobody knows what is left above that. This ramps the rate
// step by step on /quote (the endpoint live pricing uses, the cheapest one) until the first 429.
//
// WHAT IT REPORTS. FMP's window is not documented, so the number that matters is measured at the
// moment of the first 429: how many requests this script had sent in the 60 seconds (and the 1
// second) before it. That holds whatever the ramp — a step that trips because the previous step's
// requests are still in the window shows up as exactly that. Then it probes once every 5 seconds
// until FMP answers 200 again: the recovery time.
//
// THE KEY IS SHARED. Run it OUTSIDE market hours (refused 08:00–17:00 ET on weekdays without
// --force), with the local dev backend STOPPED. Render's production backend uses the same key; what
// it sends while this runs counts too, so the result is the headroom above it, not the plan's whole
// allowance. A 429 here can briefly starve production's pricing — that is why it stops at the first
// one, and why off-hours. Nothing is written to any database.

import dns from 'node:dns'
import fs from 'node:fs'
import { config } from '../services/config.js'

if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

// --base points the test at a stand-in server (the script's own self-check); FMP otherwise.
const BASE = (() => { const i = process.argv.indexOf('--base'); return i >= 0 ? process.argv[i + 1] : 'https://financialmodelingprep.com/stable' })()
const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'XOM', 'UNH', 'SPY', 'QQQ']
const MAX_IN_FLIGHT = 50
const TIMEOUT_MS = 15_000
const PROBE_EVERY_MS = 5_000
const PROBE_GIVE_UP_MS = 5 * 60_000
const FAILS_IN_A_ROW_STOP = 10

// ── Arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt }
const RUN     = flag('run')
const FORCE   = flag('force')
const RATES   = opt('rates', '120,240,360,480,600,900,1200').split(',').map(Number).filter(n => n > 0)
const STEP_MS = Number(opt('step-sec', '60')) * 1000
const OUT     = opt('out', null)
const KEY     = config.fmpApiKey

// ── The clock ────────────────────────────────────────────────────────────────

const _ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function guardedHours(ms = Date.now()) {
    const p = Object.fromEntries(_ET.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
    const min = Number(p.hour) * 60 + Number(p.minute)
    const weekday = !['Sat', 'Sun'].includes(p.weekday)
    return { guarded: weekday && min >= 8 * 60 && min < 17 * 60, et: `${p.weekday} ${p.hour}:${p.minute} ET` }
}

// ── One request ──────────────────────────────────────────────────────────────

const redact = (s) => String(s ?? '').replaceAll(KEY ?? '\u0000', '***')

async function hit(symbol) {
    const t0 = Date.now()
    try {
        const res = await fetch(`${BASE}/quote?symbol=${symbol}&apikey=${KEY}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        // Read the body so the socket is reusable; a 429's body is FMP's own wording, worth keeping.
        const body = await res.text().catch(() => '')
        const headers = {}
        for (const [k, v] of res.headers) if (/rate|limit|retry|remaining|reset/i.test(k)) headers[k] = v
        return { status: res.status, ms: Date.now() - t0, at: t0, headers, body: res.status === 200 ? null : redact(body).slice(0, 300) }
    } catch (err) {
        return { status: 0, ms: Date.now() - t0, at: t0, error: redact(err?.message ?? err) }
    }
}

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── The ramp ─────────────────────────────────────────────────────────────────

async function ramp() {
    const sent = []        // start times of every request, for the window counts at the first 429
    const steps = []
    let tripped = null, n = 0

    for (const rpm of RATES) {
        const gap = 60_000 / rpm
        const stepStart = Date.now()
        const results = []
        const inFlight = new Set()
        let failsInARow = 0, stop = null

        for (let i = 0; Date.now() - stepStart < STEP_MS && !stop; i++) {
            const due = stepStart + i * gap
            const wait = due - Date.now()
            if (wait > 0) await sleep(wait)
            if (tripped) break
            while (inFlight.size >= MAX_IN_FLIGHT) await Promise.race(inFlight)

            const symbol = SYMBOLS[n++ % SYMBOLS.length]
            sent.push(Date.now())
            const p = hit(symbol).then(r => {
                results.push(r)
                if (r.status === 429 && !tripped) {
                    const at = r.at
                    tripped = {
                        rpm_step: rpm,
                        at: new Date(at).toISOString(),
                        sent_last_60s: sent.filter(t => t <= at && t > at - 60_000).length,
                        sent_last_10s: sent.filter(t => t <= at && t > at - 10_000).length,
                        sent_last_1s:  sent.filter(t => t <= at && t > at - 1_000).length,
                        sent_total:    sent.filter(t => t <= at).length,
                        headers: r.headers, body: r.body,
                    }
                }
                failsInARow = r.status === 200 ? 0 : failsInARow + 1
                if (failsInARow >= FAILS_IN_A_ROW_STOP && !tripped) stop = `${FAILS_IN_A_ROW_STOP} failures in a row (last: ${r.status || r.error})`
            })
            inFlight.add(p)
            p.finally(() => inFlight.delete(p))
        }
        await Promise.all(inFlight)

        const ok = results.filter(r => r.status === 200)
        const step = {
            rpm,
            sent: results.length,
            ok: ok.length,
            r429: results.filter(r => r.status === 429).length,
            other: results.filter(r => r.status !== 200 && r.status !== 429).length,
            p50_ms: pct(ok.map(r => r.ms), 50),
            p95_ms: pct(ok.map(r => r.ms), 95),
            statuses: [...new Set(results.map(r => r.status))],
        }
        steps.push(step)
        console.log(`  ${String(rpm).padStart(5)}/min  sent ${String(step.sent).padStart(5)}  ok ${String(step.ok).padStart(5)}  429 ${String(step.r429).padStart(4)}  other ${String(step.other).padStart(3)}  p50 ${step.p50_ms ?? '—'}ms  p95 ${step.p95_ms ?? '—'}ms`)
        if (tripped) return { steps, tripped, stopped: null }
        if (stop) return { steps, tripped: null, stopped: stop }
    }
    return { steps, tripped: null, stopped: null }
}

async function recovery(trippedAt) {
    const start = Date.parse(trippedAt)
    let probes = 0
    while (Date.now() - start < PROBE_GIVE_UP_MS) {
        await sleep(PROBE_EVERY_MS)
        probes++
        const r = await hit('AAPL')
        if (r.status === 200) return { recovered_after_s: Math.round((Date.now() - start) / 1000), probes }
    }
    return { recovered_after_s: null, probes, note: `still refused after ${PROBE_GIVE_UP_MS / 60_000} min` }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const clock = guardedHours()
const maxRequests = RATES.reduce((s, r) => s + Math.ceil((r * STEP_MS) / 60_000), 0)
console.log('FMP burst test — /quote, one symbol per request')
console.log(`  now: ${clock.et}${clock.guarded ? '  (GUARDED HOURS — 08:00–17:00 ET weekdays)' : ''}`)
console.log(`  steps: ${RATES.join(' → ')} per minute, ${STEP_MS / 1000}s each; at most ${maxRequests} requests, ~${Math.round((RATES.length * STEP_MS) / 60_000)} min, stopping at the first 429`)
console.log(`  key: ${KEY ? 'set' : 'MISSING (FMP_API_KEY)'}`)

if (!KEY) process.exit(1)
if (!RUN) {
    console.log('\nPlan only — nothing sent. Stop the local dev backend, then add --run.')
    process.exit(0)
}
if (clock.guarded && !FORCE) {
    console.log('\nRefused: inside guarded hours — the key is shared with live pricing. Run after 17:00 ET or on a weekend (or --force).')
    process.exit(1)
}

console.log('\nRamping…')
const { steps, tripped, stopped } = await ramp()
let rec = null
if (tripped) {
    console.log(`\nFirst 429 during the ${tripped.rpm_step}/min step, at ${tripped.at}:`)
    console.log(`  sent in the 60s before it: ${tripped.sent_last_60s}   (10s: ${tripped.sent_last_10s}, 1s: ${tripped.sent_last_1s}, total: ${tripped.sent_total})`)
    if (Object.keys(tripped.headers).length) console.log(`  headers: ${JSON.stringify(tripped.headers)}`)
    if (tripped.body) console.log(`  body: ${tripped.body}`)
    console.log('\nProbing for recovery (one request every 5s)…')
    rec = await recovery(tripped.at)
    console.log(rec.recovered_after_s != null ? `  answering again after ~${rec.recovered_after_s}s (${rec.probes} probes)` : `  ${rec.note}`)
} else if (stopped) {
    console.log(`\nStopped without a 429: ${stopped}`)
} else {
    console.log(`\nNo 429 up to ${RATES.at(-1)}/min — the ceiling is above that (or FMP does not rate-limit this way).`)
}

const summary = {
    ran_at: new Date().toISOString(), clock: clock.et, step_sec: STEP_MS / 1000,
    steps, first_429: tripped, recovery: rec, stopped,
    note: 'Counts are this script\'s requests only — production\'s live pricing on the same key adds to them.',
}
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(summary, null, 2)); console.log(`\nWritten: ${OUT}`) }
