// BRANCHES → INDUSTRIES, AND THE INDUSTRY SCORES (docs/design/situation-network.md §6; plan steps 7–8).
//
// mapBranches: ONE structured call (prompts/situation_industries.md) maps every branch to industries — a direction and
// a size bucket, grounded in each industry's measured exposure and past reactions (exposure.js). Unknown codes dropped.
//
// scoreIndustries: summed over EVERY path, never the most probable one — by sampling the network. Each sample walks the
// nodes (a node under a branch only when that branch was drawn), drawing each node's option from its probabilities
// shifted by its links: a source branch that WAS drawn pushes its targets by shift × (1 − its marginal), one that was
// not by shift × (0 − its marginal), so a sample is a coherent path and the average stays at the network's numbers.
// Per industry: the chance it wins (net effect > 0), loses (< 0), the expected size, the agreement (the share of moving
// paths that point the majority way), and the branches behind it. Seeded, so one network always scores the same.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { callAnthropicStructured } from '../../providers/anthropic.provider.js'
import { recordUsage, calcCost } from '../tokenUsage.service.js'
import { makePromptLoader } from '../agentUtils.js'
import { BUCKETS, STARTS, LASTS } from './model.js'
import { agreeTimes, effectEnded } from './horizon.js'
import { marginal } from './propagate.js'
import { exposureLine } from './exposure.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.industries]'
const __dirname = dirname(fileURLToPath(import.meta.url))
const _system = makePromptLoader(join(__dirname, '../../prompts/situation_industries.md'), LOG)

export const MAP_MODEL = 'claude-opus-5-5'
export const MAP_EFFORT = 'high'
export const MAX_PER_BRANCH = 8
export const BUCKET_WEIGHT = Object.freeze({ small: 1, medium: 2, large: 3 })
export const SAMPLES = 5000
export const SEED = 20261123

const _io = {
    call: (args) => callAnthropicStructured(args),
    record: (payer, model, usage) => recordUsage(payer, model, usage, 'situation', { monitor: true }),
    payer: async () => { const { houseLedgerUserId } = await import('../../api/user/user.model.js'); return houseLedgerUserId() },
    system: () => _system(),
}
export function _setIO(io) { Object.assign(_io, io) }

/** The structured answer's schema. Pure. */
export function mapSchema() {
    return {
        type: 'object', additionalProperties: false, required: ['branches'],
        properties: { branches: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['branch', 'effects'],
            properties: {
                branch: { type: 'integer' },
                effects: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'direction', 'bucket', 'starts', 'lasts', 'why'],
                    properties: { code: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down'] }, bucket: { type: 'string', enum: [...BUCKETS] },
                        starts: { type: 'string', enum: [...STARTS] }, lasts: { type: 'string', enum: [...LASTS] }, why: { type: 'string' } } } },
            },
        } } },
    }
}

/** Every branch of the live network, numbered. Pure. */
export function branchList(nodes) {
    const out = []
    for (const n of nodes) {
        if (n.status === 'dropped' || n.status === 'split') continue
        for (const o of n.options) out.push({ node_id: n.node_id, option: o.key, question: n.question, label: o.label, p: o.p, dormant: Boolean(o.dormant) })
    }
    return out
}

/** The mapping's user message. Pure. */
export function mapPrompt(branches, industries) {
    return [
        `THE INDUSTRIES (${industries.length}; code, name, evidence):`, ...industries.map(exposureLine), '',
        `THE BRANCHES (${branches.length}):`,
        ...branches.map((b, i) => `${i + 1}. "${b.question}" → ${b.label} (${Math.round(b.p * 100)}%${b.dormant ? ', dormant' : ''})`), '',
        'Map every branch.',
    ].join('\n')
}

/** The model's answer → `Map("node|option" → [{ code, direction, bucket, why, starts, lasts }])`, unknown codes dropped. Pure. */
export function shapeEffects(data, branches, codes) {
    const out = new Map()
    let dropped = 0
    for (const b of data?.branches ?? []) {
        const br = branches[b.branch - 1]
        if (!br) continue
        const effects = []
        for (const e of b.effects ?? []) {
            if (!codes.has(String(e.code)) || !['up', 'down'].includes(e.direction) || !BUCKETS.includes(e.bucket)) { dropped++; continue }
            if (effects.some(x => x.code === String(e.code))) continue
            effects.push({ code: String(e.code), direction: e.direction, bucket: e.bucket, why: String(e.why ?? '').slice(0, 300),
                ...(STARTS.includes(e.starts) ? { starts: e.starts } : {}), ...(LASTS.includes(e.lasts) ? { lasts: e.lasts } : {}) })
            if (effects.length >= MAX_PER_BRANCH) break
        }
        out.set(`${br.node_id}|${br.option}`, effects)
    }
    return { effects: out, dropped }
}

/** The mapping runs: two, and an effect is kept only when both name it (Roy, 2026-11-23: "fix all"). */
export const MAP_RUNS = 2

/**
 * Two runs' effects → only those both runs name for the same branch, with the same direction; the size is the SMALLER
 * of the two buckets, the start the LATER and the length the SHORTER (the first live build mapped Health Care Technology up on US strikes on Iran — one run's noise).
 * Pure.
 */
export function agreeEffects(a, b) {
    const out = new Map()
    let disagreed = 0
    for (const [k, xs] of a) {
        const ys = b.get(k) ?? []
        const kept = []
        for (const x of xs) {
            const y = ys.find(e => e.code === x.code && e.direction === x.direction)
            if (!y) { disagreed++; continue }
            kept.push({ ...x, bucket: BUCKET_WEIGHT[y.bucket] < BUCKET_WEIGHT[x.bucket] ? y.bucket : x.bucket, ...agreeTimes(x, y) })
        }
        disagreed += ys.filter(y => !xs.some(x => x.code === y.code && x.direction === y.direction)).length
        out.set(k, kept)
    }
    return { effects: out, disagreed }
}

/** MAP_RUNS mapping calls → `{ ok, effects, cost_usd, dropped, disagreed, runs }`; one answer alone is used as it is. */
export async function mapBranches(nodes, industries) {
    const branches = branchList(nodes)
    let cost = 0, payer = null
    try { payer = await _io.payer() } catch { /* unbooked */ }
    const codes = new Set(industries.map(i => i.code))
    const one = () => _io.call({ model: MAP_MODEL, effort: MAP_EFFORT, systemPrompt: _io.system(), user: mapPrompt(branches, industries), schema: mapSchema(),
        onUsage: (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) } })
        .then(r => (r?.data ? shapeEffects(r.data, branches, codes) : null))
        .catch(err => { logger.warn(LOG, 'a mapping run failed', { error: err.message }); return null })
    const runs = (await Promise.all(Array.from({ length: MAP_RUNS }, one))).filter(Boolean)
    if (!runs.length) return { ok: false, reason: 'no mapping run answered', cost_usd: cost }
    if (runs.length === 1) return { ok: true, effects: runs[0].effects, dropped: runs[0].dropped, disagreed: null, runs: 1, cost_usd: cost }
    const agreed = agreeEffects(runs[0].effects, runs[1].effects)
    return { ok: true, effects: agreed.effects, dropped: runs[0].dropped + runs[1].dropped, disagreed: agreed.disagreed, runs: 2, cost_usd: cost }
}

/** A small seeded random generator (mulberry32). Pure. */
export function rng(seed) {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6D2B79F5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/** Nodes in walking order: roots first, then each node after the branch it hangs under. Pure. */
export function walkOrder(nodes) {
    const live = nodes.filter(n => n.status !== 'dropped' && n.status !== 'split')
    const ids = new Set(live.map(n => n.node_id))
    const out = [], placed = new Set()
    let pending = live
    while (pending.length) {
        const next = []
        for (const n of pending) {
            if (!n.given || placed.has(n.given.node_id) || !ids.has(n.given.node_id)) { out.push(n); placed.add(n.node_id) } else next.push(n)
        }
        if (next.length === pending.length) { out.push(...next); break }
        pending = next
    }
    return out
}

/**
 * Sample the network `samples` times and add up each industry's effects → rows for model.checkIndustry, best chance
 * of winning first. `industries` gives names; `effects` is mapBranches' map. With
 * `asOf`, a resolved question's effect that has ended (horizon.js) no longer counts. Pure.
 */
export function scoreIndustries(nodes, links, effects, industries, { samples = SAMPLES, seed = SEED, asOf = null } = {}) {
    const order = walkOrder(nodes)
    const map = new Map(nodes.map(n => [n.node_id, n]))
    const acting = new Map(order.flatMap(n => n.options.map(o => [`${n.node_id}|${o.key}`, (effects.get(`${n.node_id}|${o.key}`) ?? []).filter(e => !effectEnded(n, e, asOf))])))
    const marg = new Map(links.map(l => [l.link_id, marginal(nodes, l.from.node_id, l.from.option, map)]))
    const into = new Map()
    for (const l of links) if (l.live !== false) { if (!into.has(l.to.node_id)) into.set(l.to.node_id, []); into.get(l.to.node_id).push(l) }
    const names = new Map(industries.map(i => [i.code, i.name]))
    const levels = new Map(industries.map(i => [i.code, i.level]))
    // Only what a sample can draw: a dropped or split question's effects never fire, and an industry mapped only there
    // came out 0% / 0% with no path (prod, 2026-11-24: Rail and Cargo Ground, from a question dropped that run).
    const codes = [...new Set([...acting.values()].flat().map(e => e.code))]
    const win = new Map(codes.map(c => [c, 0])), lose = new Map(codes.map(c => [c, 0])), sumNet = new Map(codes.map(c => [c, 0]))
    const contrib = new Map(codes.map(c => [c, new Map()]))   // code → "node|option" → signed weight × count
    const rand = rng(seed)
    for (let s = 0; s < samples; s++) {
        const drawn = new Map()   // node_id → option
        for (const n of order) {
            if (n.given && drawn.get(n.given.node_id) !== n.given.option) continue
            const push = new Map(n.options.map(o => [o.key, 0]))
            for (const l of into.get(n.node_id) ?? []) {
                if (!push.has(l.to.option)) continue
                const src = drawn.has(l.from.node_id) ? (drawn.get(l.from.node_id) === l.from.option ? 1 : 0) : null
                if (src === null) continue
                push.set(l.to.option, push.get(l.to.option) + l.shift * (src - (marg.get(l.link_id) ?? 0)))
            }
            const w = n.options.map(o => Math.max(1e-9, o.p) * Math.exp(push.get(o.key)))
            const tot = w.reduce((a, b) => a + b, 0)
            let r = rand() * tot, pick = n.options.at(-1).key
            for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) { pick = n.options[i].key; break } }
            drawn.set(n.node_id, pick)
        }
        const net = new Map()
        for (const [id, opt] of drawn) {
            for (const e of acting.get(`${id}|${opt}`) ?? []) {
                const v = (e.direction === 'up' ? 1 : -1) * BUCKET_WEIGHT[e.bucket]
                net.set(e.code, (net.get(e.code) ?? 0) + v)
                const c = contrib.get(e.code)
                c.set(`${id}|${opt}`, (c.get(`${id}|${opt}`) ?? 0) + v)
            }
        }
        for (const [code, v] of net) {
            if (v > 0) win.set(code, win.get(code) + 1)
            else if (v < 0) lose.set(code, lose.get(code) + 1)
            sumNet.set(code, sumNet.get(code) + v)
        }
    }
    const rows = codes.map(code => {
        const pw = win.get(code) / samples, pl = lose.get(code) / samples
        const mean = sumNet.get(code) / samples
        const moving = pw + pl
        const paths = [...contrib.get(code).entries()].map(([k, v]) => {
            const [node_id, option] = k.split('|')
            const n = map.get(node_id)
            // The horizon of this branch: its question resolves by this date (the network has no single horizon).
            return { node_id, option, question: n?.question ?? null, label: n?.options.find(o => o.key === option)?.label ?? option, weight: v / samples, resolve_by: n?.resolve_by ?? null }
        }).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 6)
        return {
            level: levels.get(code) ?? 'sub_industry', code, name: names.get(code) ?? code, p_win: pw, p_lose: pl,
            bucket: Math.abs(mean) >= 2.5 ? 'large' : Math.abs(mean) >= 1 ? 'medium' : 'small',
            agreement: moving > 0 ? Math.max(pw, pl) / moving : null, expected: mean, paths,
        }
    })
    return rows.sort((a, b) => (b.p_win - b.p_lose) - (a.p_win - a.p_lose))
}

/**
 * The would-be entries (§11.4: no trades yet, the record only): an industry whose chance of winning (or losing) crossed
 * 30 / 50 / 70% since the previous run, upward. Pure.
 */
export const ENTRY_LEVELS = Object.freeze([0.3, 0.5, 0.7])
export function wouldBeEntries(prev, now, asOf) {
    const before = new Map((prev ?? []).map(r => [r.code, r]))
    const out = []
    for (const r of now) {
        const b = before.get(r.code)
        for (const side of ['win', 'lose']) {
            const was = b ? b[`p_${side}`] : 0, is = r[`p_${side}`]
            for (const lv of ENTRY_LEVELS) if (was < lv && is >= lv) out.push({ code: r.code, name: r.name, side, level: lv, p: is, on: asOf })
        }
    }
    return out
}
