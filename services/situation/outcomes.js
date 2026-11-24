// THE MISSING-OUTCOMES REVIEW (docs/design/situation-network-outcomes.md §2).
//
// An option that is not there holds no probability, moves no link and pushes no industry from the day its question is
// asked (Roy, 2026-11-24, on "Does Nvidia name a permanent CEO? Yes / No" when the old CEO came back). So the options are
// attacked by a SEPARATE call whose only job is to find what their author missed: an outcome missing, or two outcomes
// lumped into one option that would move industries differently. It runs on every weekly update and every rebuild
// (update.js), over every live question, and its changes go through the paths an update's own use:
//   add_option → the question gains the option (≤ 4), its numbers re-set, the node mapped to industries, the option LINKED;
//   reword     → the question is replaced by a better-framed one (the old one dropped as `reworded`), mapped and linked.
// What still slips through is caught at resolution (update.js: the resolution check) and counted (`unforeseen`).

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { callAnthropicStructured } from '../../providers/anthropic.provider.js'
import { recordUsage, calcCost } from '../tokenUsage.service.js'
import { makePromptLoader } from '../agentUtils.js'
import { checkNode, newId, KEY, snake, fitProbabilities, withKind, MAX_OPTIONS, BUCKETS } from './model.js'
import { NO_SIGNPOST } from './network.js'
import { layerOf, layerName } from './sectors.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.outcomes]'
const __dirname = dirname(fileURLToPath(import.meta.url))
const _system = makePromptLoader(join(__dirname, '../../prompts/situation_outcomes.md'), LOG)

// A different vendor would share fewer blind spots; no structured-output path to one exists yet (openaiCompat has none),
// so this is a separate Claude call with an adversarial brief. The model is the one place to swap.
export const OUTCOMES_MODEL = 'claude-opus-5-5'
export const OUTCOMES_EFFORT = 'high'
/** At most this many questions changed by one review: the most consequential first. */
export const MAX_CHANGES = 8
/** How many of an option's effects the prompt shows (largest first). */
export const EFFECTS_SHOWN = 3
export const VERDICTS = Object.freeze(['add_option', 'reword'])

const _io = {
    call: (args) => callAnthropicStructured(args),
    record: (payer, model, usage) => recordUsage(payer, model, usage, 'situation', { monitor: true }),
    payer: async () => { const { houseLedgerUserId } = await import('../../api/user/user.model.js'); return houseLedgerUserId() },
    system: () => _system(),
}
export function _setIO(io) { Object.assign(_io, io) }

const signpostOr = (s) => (String(s ?? '').trim() ? s : NO_SIGNPOST)
const pct = (p) => `${Math.round((p ?? 0) * 100)}%`

/** What an option ASSUMES: its largest industry effects, named → "Semiconductors up, Software down". Pure. */
export function effectLine(o, names = new Map()) {
    const fx = (o.effects ?? []).filter(e => BUCKETS.includes(e.bucket))
        .sort((a, b) => BUCKETS.indexOf(b.bucket) - BUCKETS.indexOf(a.bucket)).slice(0, EFFECTS_SHOWN)
    return fx.length ? fx.map(e => `${names.get(e.code) ?? e.code} ${e.direction}`).join(', ') : 'no industry effect mapped'
}

/** The live nodes, numbered (1-based) → `[{ n, node }]`. Pure. */
export const numberedLive = (nodes) => nodes.filter(n => n.status === 'live').map((node, i) => ({ n: i + 1, node }))

/** The review's user message. Pure. */
export function outcomesPrompt(asOf, list, names = new Map()) {
    return [`AS-OF DATE: ${asOf}. Nothing after it exists.`, '', `THE QUESTIONS (${list.length}):`,
        ...list.map(({ n, node }) => [`${n}. [${layerName(layerOf(node))} · ${node.tree}] ${node.question} (resolve by ${node.resolve_by ?? 'n/a'}; ${node.options.length} options)`,
            ...node.options.map(o => `   ${o.key} = ${o.label} ${pct(o.p)}; assumes: ${effectLine(o, names)}`)].join('\n')),
        '', `Attack every question's options. Change at most ${MAX_CHANGES}.`].join('\n')
}

const pList = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['option', 'value'], properties: { option: { type: 'string' }, value: { type: 'number' } } } }
const opt = { type: 'object', additionalProperties: false, required: ['key', 'label', 'signpost'], properties: { key: { type: 'string' }, label: { type: 'string' }, signpost: { type: 'string' } } }
const nul = (s) => ({ anyOf: [s, { type: 'null' }] })

/** The review's schema. Pure. */
export function outcomesSchema() {
    return {
        type: 'object', additionalProperties: false, required: ['changes'],
        properties: {
            changes: { type: 'array', items: {
                type: 'object', additionalProperties: false, required: ['node', 'reasoning', 'verdict', 'new_option', 'reworded', 'probabilities'],
                properties: {
                    node: { type: 'integer' }, reasoning: { type: 'string' }, verdict: { type: 'string', enum: [...VERDICTS] },
                    new_option: nul(opt),
                    reworded: nul({ type: 'object', additionalProperties: false, required: ['question', 'options'], properties: { question: { type: 'string' }, options: { type: 'array', items: opt } } }),
                    probabilities: pList,
                },
            } },
        },
    }
}

/**
 * Review every live question's options → `{ ok: true, data, list, cost_usd }` or `{ ok: false, reason, cost_usd }`.
 * `names`: industry code → name, for the effects. Never throws.
 */
export async function reviewOutcomes(nodes, asOf, names = new Map()) {
    const list = numberedLive(nodes)
    if (!list.length) return { ok: true, data: { changes: [] }, list, cost_usd: 0 }
    let cost = 0, payer = null
    try { payer = await _io.payer() } catch { /* unbooked */ }
    try {
        const res = await _io.call({ model: OUTCOMES_MODEL, effort: OUTCOMES_EFFORT, systemPrompt: _io.system(), user: outcomesPrompt(asOf, list, names), schema: outcomesSchema(),
            onUsage: (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) } })
        if (!res?.data) return { ok: false, reason: `the outcomes review returned no answer (${res?.stopReason ?? 'unknown'})`, cost_usd: cost }
        return { ok: true, data: res.data, list, cost_usd: cost }
    } catch (err) {
        logger.warn(LOG, 'the outcomes review failed', { error: err.message })
        return { ok: false, reason: `the outcomes review failed: ${err.message}`, cost_usd: cost }
    }
}

/**
 * Apply the review → `{ nodes, added, reworded, dropped, created, newOptions, needMap, rejudged, skipped }`. Pure apart
 * from new ids. A change that does not fit (a full question, probabilities that do not fit, a question with sub-questions
 * hanging under it reworded) is SKIPPED with its reason, never forced.
 */
export function applyOutcomes(data, list, nodes, asOf) {
    let cur = nodes
    const at = (k) => list.find(x => x.n === k)?.node.node_id ?? null
    const get = (id) => cur.find(n => n.node_id === id)
    const added = [], reworded = [], dropped = [], created = [], newOptions = [], skipped = [], needMap = new Set(), rejudged = new Set()
    const done = new Set()
    for (const c of (data?.changes ?? []).slice(0, MAX_CHANGES)) {
        const id = at(c.node), n = id && get(id)
        const reasoning = String(c.reasoning ?? '').slice(0, 1200)
        const skip = (reason) => skipped.push({ node_id: id, verdict: c.verdict, reason })
        if (!n || n.status !== 'live') { skip('no such live question'); continue }
        if (done.has(id)) { skip('changed once already in this review'); continue }
        if (c.verdict === 'add_option' && c.new_option) {
            const key = KEY.test(c.new_option.key) ? c.new_option.key : snake(c.new_option.key || c.new_option.label)
            if (!key || n.options.some(o => o.key === key)) { skip('the option is there already'); continue }
            if (n.options.length >= MAX_OPTIONS) { skip(`the question has ${MAX_OPTIONS} options already`); continue }
            const p = fitProbabilities([...n.options.map(o => o.key), key], c.probabilities)
            if (!p || p[p.length - 1] <= 0) { skip('its probabilities did not fit, or gave the new option nothing'); continue }
            const option = { key, label: String(c.new_option.label).slice(0, 160), p: 0, signpost: signpostOr(c.new_option.signpost), effects: [] }
            cur = cur.map(x => (x.node_id !== id ? x : withKind({ ...x, options: [...x.options, option].map((o, i) => ({ ...o, p: p[i] })) })))
            added.push({ node_id: id, option: key, label: option.label, reasoning })
            newOptions.push({ node_id: id, option: key }); needMap.add(id); rejudged.add(id); done.add(id)
        } else if (c.verdict === 'reword' && c.reworded?.question) {
            if (cur.some(x => x.status === 'live' && x.given?.node_id === id)) { skip('sub-questions hang under it; reword them with it by hand'); continue }
            const opts = (c.reworded.options ?? []).map(o => ({ key: KEY.test(o.key) ? o.key : snake(o.key || o.label), label: o.label, signpost: signpostOr(o.signpost) }))
            const p = fitProbabilities(opts.map(o => o.key), c.probabilities)
            const checked = p ? checkNode({
                node_id: newId('node'), tree: n.tree, question: c.reworded.question, set_by: 'llm', layer: n.layer, origin: n.origin, given: n.given,
                options: opts.map((o, i) => ({ ...o, p: p[i] })), lag: n.lag, resolve_by: n.resolve_by, reasoning, split_from: id,
            }) : { ok: false, reason: 'its probabilities did not fit its options' }
            if (!checked.ok) { skip(checked.reason); continue }
            const node = { ...checked.value, impact: n.impact, review: null }
            cur = cur.map(x => (x.node_id === id ? { ...x, status: 'dropped' } : x)).concat(node)
            dropped.push({ question: n.question, options: n.options.map(o => o.label), reason: 'reworded', note: `reworded on ${asOf} as "${node.question.slice(0, 160)}"`, flagged: false, layer: layerOf(n) })
            reworded.push({ from: id, node_id: node.node_id, question: node.question, reasoning })
            created.push(node.node_id); needMap.add(node.node_id); rejudged.add(node.node_id); done.add(id)
        } else skip('the change named no option or question')
    }
    return { nodes: cur, added, reworded, dropped, created, newOptions, needMap, rejudged, skipped }
}
