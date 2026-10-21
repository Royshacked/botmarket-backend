/**
 * Replay the CHEAP tier (monitoring/talos.cheap.js) over recorded Talos reads, on two or more
 * models, and score each against what the full read actually decided.
 *
 *   node scripts/eval/talos-replay/cheap-tier-replay.mjs [--models=haiku,luna] [--dbs=test,axl_dev]
 *        [--limit=N] [--repeat=5] [--concurrency=4] [--out=data/eval/cheap-replay.json]
 *
 * WHAT IS REPLAYED. Every recorded `candle` wake (first looks, guards and expiry reviews are never
 * triaged in production — talos.tiers). The cheap prompt is the REAL one: `cheapRead` runs with its
 * candles injected from the bundle's frozen data pack and its model call swapped per candidate, so
 * nothing about the prompt or the escalation rule differs from what runs live. Read-only: bundles
 * carry no userId, so `bookAssessUsage` books nothing, and no setup is touched.
 *
 * PLUS THE EXPD CASE (2026-10-19) — the miss this was built for, which no bundle holds because the
 * recorder records only full reads. Rebuilt from FMP history, twice: AS IT HAPPENED (13:24 ET, 4hr
 * bars counted in fours from the newest) and AS IT WOULD NOW (13:30 ET, session-anchored bars), each
 * `--repeat` times per model. Its truth is the condition's own words: met at the 13:30 close.
 *
 * SCORED, per model:
 *   slept        — escalate false: the full read it saves
 *   missed_act   — slept where the full read said enter / edit (an action lost)
 *   missed_aside — slept where it said stand_aside
 *   contradicted — a condition called `not_fired` that the full read marked met
 *   failed       — io / unparseable (these escalate, so they cost money, not safety)
 *   cost, latency
 *
 * The bundles' 2hr/4hr bars are frozen in the PRE-2026-10-21 grouping (no hourlies are kept to
 * rebuild them). Both models see the same bars, so the comparison is fair; the absolute numbers are
 * on the old bars.
 */

import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../../../services/config.js'

if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { MongoClient } = await import('mongodb')
const Anthropic = (await import('@anthropic-ai/sdk')).default
const { cheapRead, cheapWatch } = await import('../../../monitoring/talos.cheap.js')
const { callOpenAICompatOnce, toSystemText } = await import('../../../providers/openaiCompat.provider.js')
const { calcCost } = await import('../../../services/tokenUsage.service.js')
const { getFmpCandles } = await import('../../../providers/fmp.price.provider.js')
const { aggregateCandles } = await import('../../../services/candleInterval.util.js')
const { barBucketOf } = await import('../../../services/market.service.js')

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const MODELS      = arg('models', 'haiku,luna').split(',')
const DBS         = arg('dbs', 'test,axl_dev').split(',')
const LIMIT       = Number(arg('limit', 0)) || Infinity
const REPEAT      = Number(arg('repeat', 5))
const CONCURRENCY = Number(arg('concurrency', 4))
const OUT         = arg('out', 'data/eval/cheap-replay.json')

// ─── The candidates ─────────────────────────────────────────────────────────────
// Each `send` returns what cheapRead expects from the Anthropic SDK: { content:[{type,text}], usage }.

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })
const CANDIDATES = {
    haiku: {
        pricing: 'claude-haiku-4-5-20251001',
        send: async ({ system, userText }) => anthropic.messages.create({
            model: 'claude-haiku-4-5', max_tokens: 1024, system, messages: [{ role: 'user', content: userText }],
        }),
    },
    luna: {
        pricing: 'gpt-6-luna',
        send: async ({ system, userText }) => {
            let usage = null
            const text = await callOpenAICompatOnce({
                endpoint: 'openrouter', wire: 'openai/gpt-6-luna', model: 'gpt-6-luna',
                systemText: toSystemText(system), userText, maxTokens: 1024, onUsage: u => { usage = u },
            })
            return { content: [{ type: 'text', text }], usage }
        },
    },
}
for (const m of MODELS) if (!CANDIDATES[m]) throw new Error(`unknown model "${m}" (have: ${Object.keys(CANDIDATES).join(', ')})`)

// ─── One cheap read on one candidate ────────────────────────────────────────────

async function runOne(model, { setup, scenario, price, bars }) {
    let usage = null
    const t0 = Date.now()
    const out = await cheapRead(setup, { price, scenario }, {
        rows: async () => bars,
        send: async (p) => { const r = await CANDIDATES[model].send(p); usage = r?.usage ?? null; return r },
    })
    const cost = usage ? (usage.cost_usd ?? calcCost(CANDIDATES[model].pricing, usage)) : 0
    return { ...out, ms: Date.now() - t0, cost, usage }
}

async function pool(items, n, fn) {
    const results = new Array(items.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) { const i = next++; results[i] = await fn(items[i], i) }
    }))
    return results
}

// ─── The recorded reads ─────────────────────────────────────────────────────────

const client = new MongoClient(config.mongoUri)
await client.connect()
const cases = []
for (const dbn of DBS) {
    const docs = await client.db(dbn).collection('talos_reads')
        .find({ kind: 'pre_entry', 'wake.reason': 'candle', 'result.verdict': { $ne: null } })
        .project({ _id: 0, readId: 1, setup: 1, wake: 1, result: 1, 'pack.bars': 1 })
        .toArray()
    // Sorted here, not by the server: these documents are large and the M0 tier refuses an
    // in-memory sort over them (QueryExceededMemoryLimitNoDiskUseAllowed). The readId leads with
    // its timestamp, so it orders by time.
    docs.sort((a, b) => String(a.readId).localeCompare(String(b.readId)))
    for (const d of docs) {
        const rung = cheapWatch(d.setup).rung
        const byRung = d.pack?.bars?.[String(d.setup.asset).toUpperCase()] ?? {}
        const bars = byRung[rung] ?? byRung[d.wake?.rung] ?? null
        if (!bars?.length) continue
        cases.push({
            id: `${dbn}:${d.readId}`, setup: d.setup, scenario: d.wake?.scenario ?? null, price: d.wake?.price ?? null, bars,
            verdict: d.result?.verdict, met: new Map((d.result?.conditions ?? []).map(c => [c.id, c.met])),
        })
    }
}
const recorded = cases.slice(0, LIMIT)

// ─── The EXPD case, rebuilt ─────────────────────────────────────────────────────
// The setup as Talos held it on 2026-10-19 (its Oct 20 bundle: nothing between the two reads changed
// it), the hourlies FMP serves, cut where the 13:30 bar closes.

const expdBundle = await client.db('axl_dev').collection('talos_reads')
    .findOne({ readId: /^20261020T16.*EXPD/ }, { projection: { _id: 0, setup: 1, wake: 1 } })
await client.close()

let expd = []
if (expdBundle) {
    const cut = Date.parse('2026-10-19T17:30:00Z') / 1000          // 13:30 ET: the 12:30 hourly is the last one in
    const hourly = (await getFmpCandles('EXPD', { timeSpan: 'hour', multiplier: 1, from: Date.parse('2026-09-24'), to: Date.parse('2026-10-20') }))
        .filter(b => b.timestamp < cut)
    const asHappened = aggregateCandles(hourly, 4).slice(-24)
    const asNow      = aggregateCandles(hourly, 4, barBucketOf('EXPD', null, 240)).slice(-24)
    const base = { setup: expdBundle.setup, scenario: expdBundle.wake?.scenario ?? null }
    expd = [
        { id: 'EXPD 10-19 as it happened (13:24 ET, counted bars)', ...base, price: 197.65, bars: asHappened },
        { id: 'EXPD 10-19 as it would now (13:30 ET, session bars)', ...base, price: 197.6, bars: asNow },
    ]
}

// ─── Run ────────────────────────────────────────────────────────────────────────

console.log(`\nCHEAP-TIER REPLAY — ${recorded.length} recorded candle wakes (${DBS.join(' + ')}) + ${expd.length} EXPD cases × ${REPEAT}, models: ${MODELS.join(' vs ')}\n`)

const ACT = new Set(['enter', 'edit'])
const report = {}
for (const model of MODELS) {
    const rows = await pool(recorded, CONCURRENCY, async (c) => {
        const r = await runOne(model, c)
        const contradicted = r.conditions.filter(x => x.state === 'not_fired' && c.met.get(x.id) === 'yes').map(x => x.id)
        return { id: c.id, verdict: c.verdict, escalate: r.escalate, fail: r._failReason ?? null, contradicted, cost: r.cost, ms: r.ms, read: r.read }
    })
    const expdRuns = []
    for (const c of expd) {
        const runs = await pool(Array.from({ length: REPEAT }, () => c), CONCURRENCY, () => runOne(model, c))
        expdRuns.push({ id: c.id, escalated: runs.filter(r => r.escalate).length, of: runs.length,
            states: runs.map(r => r.conditions.map(x => x.state).join('/')), reads: runs.map(r => r.read), cost: runs.reduce((s, r) => s + r.cost, 0) })
    }

    const slept = rows.filter(r => !r.escalate)
    const sum   = rows.reduce((s, r) => s + r.cost, 0)
    report[model] = {
        n: rows.length,
        slept: slept.length,
        missed_act:   slept.filter(r => ACT.has(r.verdict)).map(r => r.id),
        missed_aside: slept.filter(r => r.verdict === 'stand_aside').map(r => r.id),
        contradicted: rows.filter(r => r.contradicted.length).map(r => ({ id: r.id, verdict: r.verdict, conditions: r.contradicted })),
        failed: rows.filter(r => r.fail).length,
        cost_total: sum, cost_per_read: rows.length ? sum / rows.length : 0,
        ms_median: rows.map(r => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? null,
        expd: expdRuns,
        rows,
    }
}

// ─── Print ──────────────────────────────────────────────────────────────────────

const pct = (a, b) => b ? `${(100 * a / b).toFixed(0)}%` : '—'
const acts  = recorded.filter(c => ACT.has(c.verdict)).length
const asides = recorded.filter(c => c.verdict === 'stand_aside').length
console.log(`truth: ${acts} enter/edit · ${asides} stand_aside · ${recorded.length - acts - asides} wait\n`)
for (const [m, r] of Object.entries(report)) {
    console.log(`── ${m}`)
    console.log(`   slept (full reads saved)   ${r.slept}/${r.n}  ${pct(r.slept, r.n)}`)
    console.log(`   missed enter/edit          ${r.missed_act.length}/${acts}   ${r.missed_act.join(', ')}`)
    console.log(`   missed stand_aside         ${r.missed_aside.length}/${asides}`)
    console.log(`   not_fired vs full read met ${r.contradicted.length}`)
    console.log(`   failed (escalated)         ${r.failed}`)
    console.log(`   cost                       $${r.cost_total.toFixed(3)} total · $${r.cost_per_read.toFixed(5)}/read · median ${r.ms_median}ms`)
    for (const e of r.expd) {
        console.log(`   ${e.id}: escalated ${e.escalated}/${e.of}  [${e.states.join(' ')}]`)
        console.log(`      e.g. "${e.reads.find(Boolean) ?? '—'}"`)
    }
    console.log()
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(report, null, 1))
console.log(`full rows → ${OUT}\n`)
process.exit(0)
