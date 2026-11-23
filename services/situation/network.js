// QUESTIONS → THE NETWORK (docs/design/situation-network.md §3–4; plan step 5).
//
// The model, RUNS times independently (prompts/situation_network.md): each question's probabilities (reasoning first,
// a base rate where one exists), confidence, lag, resolve-by date, a signpost per option, the branch it hangs under
// (`given`), a duplicate mark, and the links between questions. Code then:
//   · combines the runs: the MEDIAN of each option, renormalised; a given / duplicate / link kept when most runs agree;
//     confidence low when the runs spread by more than SPREAD_LOW;
//   · ranks: impact × uncertainty (the normalised entropy of the numbers); low impact and duplicates are dropped; the
//     OPEN nodes past the cap of 20 are dropped as `cap`; settled nodes stay outside the cap; a node under a dropped
//     branch goes with it;
//   · anchors every node (propagate.anchorFor) and logs every probability as a forecast.
// The result is a bundle store.saveRun takes whole.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { callAnthropicStructured } from '../../providers/anthropic.provider.js'
import { recordUsage, calcCost } from '../tokenUsage.service.js'
import { makePromptLoader } from '../agentUtils.js'
import { checkNode, newId, SETTLED_AT, realDate } from './model.js'
import { anchorFor } from './propagate.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.network]'
const __dirname = dirname(fileURLToPath(import.meta.url))
const _system = makePromptLoader(join(__dirname, '../../prompts/situation_network.md'), LOG)

export const NETWORK_MODEL = 'claude-opus-5-5'
export const NETWORK_EFFORT = 'high'
export const RUNS = 3
export const OPEN_CAP = 20
/**
 * Runs that disagree by more than this on any option mark the node's confidence low; so does a majority of runs saying
 * low. (0.15 and "any run low" marked 22 of 24 low on the first live build, 2026-11-23: three runs on three options
 * spread that much by themselves.)
 */
export const SPREAD_LOW = 0.2
/** A link's strength as a log-odds shift. */
export const STRENGTH_SHIFT = Object.freeze({ small: 0.4, medium: 0.8, large: 1.4 })
export const IMPACT_WEIGHT = Object.freeze({ low: 1, medium: 2, high: 3 })
export const NO_SIGNPOST = 'No signpost was given; the weekly update checks this branch by name.'

const _io = {
    call: (args) => callAnthropicStructured(args),
    record: (payer, model, usage) => recordUsage(payer, model, usage, 'situation', { monitor: true }),
    payer: async () => { const { houseLedgerUserId } = await import('../../api/user/user.model.js'); return houseLedgerUserId() },
    system: () => _system(),
}
export function _setIO(io) { Object.assign(_io, io) }

const ref = { type: 'object', additionalProperties: false, required: ['question', 'option'], properties: { question: { type: 'integer' }, option: { type: 'string' } } }
const lag = { type: 'object', additionalProperties: false, required: ['min', 'max'], properties: { min: { type: 'integer' }, max: { type: 'integer' } } }

/** The structured answer's schema. Pure. */
export function networkSchema() {
    const kv = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['option', 'value'], properties: { option: { type: 'string' }, value: { type: 'number' } } } }
    const sign = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['option', 'signpost'], properties: { option: { type: 'string' }, signpost: { type: 'string' } } } }
    return {
        type: 'object', additionalProperties: false, required: ['nodes', 'links'],
        properties: {
            nodes: { type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['question', 'reasoning', 'probabilities', 'base_rate', 'confidence', 'lag_days', 'resolve_by', 'signposts', 'given', 'duplicate_of'],
                properties: {
                    question: { type: 'integer' }, reasoning: { type: 'string' }, probabilities: kv, base_rate: { type: ['string', 'null'] },
                    confidence: { type: 'string', enum: ['low', 'high'] }, lag_days: lag, resolve_by: { type: 'string' }, signposts: sign,
                    given: { anyOf: [ref, { type: 'null' }] }, duplicate_of: { type: ['integer', 'null'] },
                },
            } },
            links: { type: 'array', items: {
                type: 'object', additionalProperties: false, required: ['from', 'to', 'direction', 'strength', 'lag_days', 'why'],
                properties: { from: ref, to: ref, direction: { type: 'string', enum: ['raises', 'lowers'] }, strength: { type: 'string', enum: ['small', 'medium', 'large'] }, lag_days: lag, why: { type: 'string' } },
            } },
        },
    }
}

/** The user message: the state as dated lines, then the numbered questions with their options. Pure. */
export function networkPrompt(state, questions) {
    const sec = Object.entries(state.sections).map(([name, items]) => `${name.toUpperCase()}:\n${items.map(i => `- ${i.as_of} [${i.tag}] ${i.text}`).join('\n') || '- (none)'}`)
    const qs = questions.map((q, i) => `${i + 1}. [${q.tree}] ${q.question}\n   options: ${q.options.map(o => `${o.key} = ${o.label}`).join('; ')}\n   impact ${q.impact}, uncertainty ${q.uncertainty}. ${q.why}`)
    return [`AS-OF DATE: ${state.as_of}.`, '', 'THE STATE:', ...sec, '', `THE QUESTIONS (${questions.length}):`, ...qs, '', 'Answer every question, then the links.'].join('\n')
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const majority = (xs) => {
    const c = new Map()
    for (const x of xs) { const k = JSON.stringify(x); c.set(k, (c.get(k) ?? 0) + 1) }
    let best = null, n = 0
    for (const [k, v] of c) if (v > n) { best = k; n = v }
    return n * 2 > xs.length ? JSON.parse(best) : null
}

/** The uncertainty of a node's numbers: entropy over the maximum for its option count, 0–1. Pure. */
export function uncertainty(ps) {
    const h = -ps.filter(p => p > 0).reduce((s, p) => s + p * Math.log(p), 0)
    return ps.length > 1 ? h / Math.log(ps.length) : 0
}

/**
 * The runs combined, per question (1-based) → `{ nodes: Map(q → combined), links: [...] }`. Options the model left
 * out count as 0; a question no run answered is absent. Pure.
 */
export function combineRuns(runs, questions, asOf) {
    const nodes = new Map()
    questions.forEach((q, i) => {
        const n = i + 1
        const answers = runs.map(r => (r?.nodes ?? []).find(x => x.question === n)).filter(Boolean)
        if (!answers.length) return
        const per = q.options.map(o => answers.map(a => Math.max(0, Number(a.probabilities?.find(p => p.option === o.key)?.value) || 0)))
        const runSums = answers.map((_, j) => per.reduce((s, xs) => s + xs[j], 0))
        const norm = per.map(xs => xs.map((v, j) => (runSums[j] > 0 ? v / runSums[j] : 1 / q.options.length)))
        const med = norm.map(median)
        const tot = med.reduce((s, x) => s + x, 0) || 1
        const p = med.map(x => x / tot)
        const spread = Math.max(...norm.map(xs => Math.max(...xs) - Math.min(...xs)))
        const lags = answers.map(a => a.lag_days).filter(l => Number.isInteger(l?.min) && Number.isInteger(l?.max) && l.min >= 0 && l.min <= l.max)
        const dates = answers.map(a => a.resolve_by).filter(d => realDate(d) && d >= asOf).sort()
        nodes.set(n, {
            q: n, p, spread,
            confidence: spread > SPREAD_LOW || answers.filter(a => a.confidence === 'low').length * 2 > answers.length ? 'low' : 'high',
            reasoning: answers[0].reasoning ?? null, base_rate: answers.find(a => a.base_rate)?.base_rate ?? null,
            lag: lags.length ? { min: Math.round(median(lags.map(l => l.min))), max: Math.round(median(lags.map(l => l.max))) } : null,
            resolve_by: dates.length ? dates[dates.length >> 1] : null,
            signposts: Object.fromEntries(q.options.map(o => [o.key, answers.map(a => a.signposts?.find(s => s.option === o.key)?.signpost).find(Boolean) ?? null])),
            given: majority(answers.map(a => (a.given ? { question: a.given.question, option: a.given.option } : null))),
            duplicate_of: majority(answers.map(a => a.duplicate_of ?? null)),
        })
    })
    // Links: kept when most runs name the same from → to; direction by majority, strength by median.
    const seen = new Map()
    runs.forEach((r) => {
        const mine = new Set()
        for (const l of r?.links ?? []) {
            const k = `${l.from?.question}.${l.from?.option}>${l.to?.question}.${l.to?.option}`
            if (mine.has(k)) continue
            mine.add(k)
            if (!seen.has(k)) seen.set(k, [])
            seen.get(k).push(l)
        }
    })
    const links = []
    for (const ls of seen.values()) {
        if (ls.length * 2 <= runs.length) continue
        const dir = majority(ls.map(l => l.direction))
        if (!dir) continue
        const shift = median(ls.map(l => STRENGTH_SHIFT[l.strength] ?? STRENGTH_SHIFT.small)) * (dir === 'lowers' ? -1 : 1)
        const lg = ls.map(l => l.lag_days).filter(x => Number.isInteger(x?.min) && Number.isInteger(x?.max) && x.min >= 0 && x.min <= x.max)
        links.push({ from: ls[0].from, to: ls[0].to, shift, lag: lg.length ? { min: Math.round(median(lg.map(x => x.min))), max: Math.round(median(lg.map(x => x.max))) } : null, why: ls[0].why ?? null })
    }
    return { nodes, links }
}

/**
 * Combined answers → the run's records: nodes (with ids, givens, anchors), links, the dropped list and the forecasts.
 * The cap holds on OPEN nodes; settled nodes are outside it. Pure apart from new ids.
 */
export function assemble(questions, combined, asOf) {
    const ids = new Map(questions.map((_, i) => [i + 1, newId('node')]))
    const drops = new Map()   // q → { reason, note }
    const kinds = new Map()
    for (const [q, c] of combined.nodes) kinds.set(q, Math.max(...c.p) >= SETTLED_AT ? 'settled' : 'open')
    questions.forEach((q, i) => {
        const n = i + 1, c = combined.nodes.get(n)
        if (!c) drops.set(n, { reason: 'low_impact', note: 'no run answered it' })
        else if (c.duplicate_of && c.duplicate_of !== n && combined.nodes.has(c.duplicate_of)) drops.set(n, { reason: 'duplicate', duplicate_of: c.duplicate_of })
        else if (q.impact === 'low') drops.set(n, { reason: 'low_impact', note: q.why || null })
    })
    // The cap: open nodes ranked by impact × uncertainty.
    const open = [...combined.nodes.keys()].filter(n => !drops.has(n) && kinds.get(n) === 'open')
        .map(n => ({ n, score: IMPACT_WEIGHT[questions[n - 1].impact] * uncertainty(combined.nodes.get(n).p) }))
        .sort((a, b) => b.score - a.score)
    for (const { n } of open.slice(OPEN_CAP)) drops.set(n, { reason: 'cap', note: `ranked below the ${OPEN_CAP} open nodes kept` })
    // Each surviving node checked (model.checkNode) BEFORE the chains are walked, so a node that fails takes the nodes
    // under it along. A missing signpost is said, not invented.
    const checkedBy = new Map()
    for (const [n, c] of combined.nodes) {
        if (drops.has(n)) continue
        const q = questions[n - 1]
        const input = {
            node_id: ids.get(n), tree: q.tree, question: q.question, set_by: 'llm', confidence: c.confidence, impact: q.impact,
            // The drift rule's first baseline: the build's numbers (Roy reviews the open nodes from the first card).
            review: { on: asOf, p: Object.fromEntries(q.options.map((o, i) => [o.key, c.p[i]])) },
            options: q.options.map((o, i) => ({ key: o.key, label: o.label, p: c.p[i], signpost: c.signposts[o.key] ?? NO_SIGNPOST })),
            lag: c.lag, resolve_by: c.resolve_by, reasoning: [c.reasoning, c.base_rate ? `Base rate: ${c.base_rate}` : null].filter(Boolean).join(' '),
            given: c.given ? { node_id: ids.get(c.given.question), option: c.given.option } : null,
        }
        const checked = checkNode(input)
        if (!checked.ok) drops.set(n, { reason: 'low_impact', note: `not usable: ${checked.reason}` })
        else checkedBy.set(n, checked.value)
    }
    // A node under a dropped branch (or an unknown one) goes with it, as far down as it reaches.
    let changed = true
    while (changed) {
        changed = false
        for (const [n, c] of combined.nodes) {
            if (drops.has(n) || !c.given) continue
            const parentQ = c.given.question
            const parentOk = checkedBy.has(parentQ) && !drops.has(parentQ) && questions[parentQ - 1]?.options.some(o => o.key === c.given.option)
            if (!parentOk) { drops.set(n, { reason: drops.get(parentQ)?.reason ?? 'low_impact', note: `it hangs under question ${parentQ}, which was dropped` }); changed = true }
        }
    }
    const nodes = [...checkedBy.entries()].filter(([n]) => !drops.has(n)).map(([n, v]) => ({ ...v, q: n }))
    const kept = new Map(nodes.map(x => [x.q, x]))
    const links = combined.links.filter(l => kept.has(l.from.question) && kept.has(l.to.question) && l.from.question !== l.to.question
        && kept.get(l.from.question).options.some(o => o.key === l.from.option) && kept.get(l.to.question).options.some(o => o.key === l.to.option))
        .map(l => ({ link_id: newId('link'), from: { node_id: ids.get(l.from.question), option: l.from.option }, to: { node_id: ids.get(l.to.question), option: l.to.option }, shift: l.shift, lag: l.lag, why: l.why, live: true }))
    const anchored = nodes.map(x => { const { q, ...rest } = x; return rest })
    for (const x of anchored) x.anchor = anchorFor(anchored, links, x.node_id, asOf)
    const dropped = {
        considered: questions.length, open: anchored.filter(x => x.kind === 'open').length, settled: anchored.filter(x => x.kind === 'settled').length,
        dropped: [...drops.entries()].sort((a, b) => a[0] - b[0]).map(([n, d]) => ({
            question: questions[n - 1].question, options: questions[n - 1].options.map(o => o.label), reason: d.reason, note: d.note ?? null,
            duplicate_of: d.duplicate_of ? questions[d.duplicate_of - 1]?.question ?? null : null, flagged: d.reason === 'cap',
        })),
    }
    const forecasts = anchored.flatMap(x => x.options.map(o => ({ node_id: x.node_id, option: o.key, p: o.p, set_by: 'llm', resolve_by: x.resolve_by })))
    return { nodes: anchored, links, dropped, forecasts }
}

/**
 * The state and its questions → `{ ok: true, nodes, links, dropped, forecasts, cost_usd, runs }` or `{ ok: false,
 * reason, cost_usd }`. RUNS calls in parallel; a failed run is left out, and fewer than two answers is a failure.
 */
export async function buildNetwork(state, questions) {
    if (!questions?.length) return { ok: false, reason: 'no questions', cost_usd: 0 }
    let cost = 0, payer = null
    try { payer = await _io.payer() } catch { /* unbooked */ }
    const user = networkPrompt(state, questions)
    const one = () => _io.call({
        model: NETWORK_MODEL, effort: NETWORK_EFFORT, systemPrompt: _io.system(), user, schema: networkSchema(),
        onUsage: (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) },
    }).then(r => r?.data ?? null).catch(err => { logger.warn(LOG, 'a network run failed', { error: err.message }); return null })
    const runs = (await Promise.all(Array.from({ length: RUNS }, one))).filter(Boolean)
    if (runs.length < 2) return { ok: false, reason: `only ${runs.length} of ${RUNS} network runs answered`, cost_usd: cost }
    const combined = combineRuns(runs, questions, state.as_of)
    return { ok: true, ...assemble(questions, combined, state.as_of), cost_usd: cost, runs: runs.length }
}

// ─── links for NEW nodes (code review 2026-11-23, Roy's "fix all"): an update or a rebuild that adds a question used to
// leave it with no links, so it never took part in spreading. One call, only for the new nodes. ───────────────────────

export const LINKS_EFFORT = 'medium'
export const LINKS_SYSTEM = 'You link NEW questions into the house\'s situation network: questions about what happens next, each with options. '
    + 'Give only the LINKS that start or end on a question marked NEW: where one question\'s option, if it happens, makes an option of '
    + 'ANOTHER question more or less likely — a direct channel only, with its direction (raises / lowers), strength (small / medium / '
    + 'large), lag in days and why in one sentence. Not every pair is linked; none is fine. Answer in the JSON schema.'

export function linksSchema() {
    return { type: 'object', additionalProperties: false, required: ['links'], properties: { links: networkSchema().properties.links } }
}

/** The live nodes numbered, the new ones marked NEW. Pure. */
export function linksPrompt(nodes, newIds) {
    const fresh = new Set(newIds)
    return [`THE QUESTIONS (${nodes.length}):`,
        ...nodes.map((n, i) => `${i + 1}. ${fresh.has(n.node_id) ? 'NEW ' : ''}[${n.tree}] ${n.question}\n   options: ${n.options.map(o => `${o.key} = ${o.label}`).join('; ')}`),
        '', 'Give the links that start or end on a NEW question.'].join('\n')
}

/**
 * The links for `newIds` among the live `nodes` → `{ ok, links, cost_usd }`: each link from or to a new node, between two
 * different live nodes, on options that exist, its strength as a log-odds shift. Never throws.
 */
export async function linksFor(nodes, newIds) {
    const live = nodes.filter(n => n.status === 'live')
    if (!newIds?.length || live.length < 2) return { ok: true, links: [], cost_usd: 0 }
    let cost = 0, payer = null
    try { payer = await _io.payer() } catch { /* unbooked */ }
    try {
        const res = await _io.call({ model: NETWORK_MODEL, effort: LINKS_EFFORT, systemPrompt: LINKS_SYSTEM, user: linksPrompt(live, newIds), schema: linksSchema(),
            onUsage: (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) } })
        const fresh = new Set(newIds)
        const at = (k) => live[k - 1]
        const links = []
        for (const l of res?.data?.links ?? []) {
            const f = at(l.from?.question), t = at(l.to?.question)
            if (!f || !t || f.node_id === t.node_id || !(fresh.has(f.node_id) || fresh.has(t.node_id))) continue
            if (!f.options.some(o => o.key === l.from.option) || !t.options.some(o => o.key === l.to.option)) continue
            const shift = (STRENGTH_SHIFT[l.strength] ?? STRENGTH_SHIFT.small) * (l.direction === 'lowers' ? -1 : 1)
            const lag = Number.isInteger(l.lag_days?.min) && Number.isInteger(l.lag_days?.max) && l.lag_days.min >= 0 && l.lag_days.min <= l.lag_days.max ? l.lag_days : null
            links.push({ link_id: newId('link'), from: { node_id: f.node_id, option: l.from.option }, to: { node_id: t.node_id, option: l.to.option }, shift, lag, why: l.why ?? null, live: true })
        }
        return { ok: true, links, cost_usd: cost }
    } catch (err) {
        logger.warn(LOG, 'the links call failed', { error: err.message })
        return { ok: false, links: [], cost_usd: cost }
    }
}
