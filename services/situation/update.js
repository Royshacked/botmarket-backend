// THE WEEKLY / EVENT UPDATE (docs/design/situation-network.md §5, §11.2; plan step 9).
//
// From the latest complete run and the news since it: ONE structured call (prompts/situation_update.md) logs a DECISION
// for every piece of news that matters (moves an option / a new option / a new question / resolves / outside / none —
// folding is a visible choice, §3), the dormant signposts that fired, and the due questions. Code then:
//   1. applies the decisions — a moved node gets its new numbers and a new ANCHOR; a new option or question is mapped
//      to industries (only those branches); a resolution is 100% on its option, its forecasts graded;
//   2. wakes the dormant branches whose signposts fired: an EARLY WARNING beside the scores, never inside (§11.9);
//   3. holds the cap: the open nodes over 20 lose the lowest-ranked, moved to the dropped list and flagged;
//   4. spreads until settled (propagate.js) and re-scores the industries over every path;
//   5. lists what goes on Roy's review card (§11.1 + the drift rule) and the would-be entries;
//   6. saves the run whole.
// The state carries over with the week's articles; the monthly REBUILD refreshes it (build.js).

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { callAnthropicStructured } from '../../providers/anthropic.provider.js'
import { recordUsage, calcCost } from '../tokenUsage.service.js'
import { makePromptLoader } from '../agentUtils.js'
import { checkNode, newId, SETTLED_AT, BUCKETS, KEY, snake, realDate } from './model.js'
import { propagate, resolve, anchorFor } from './propagate.js'
import { fetchNews, fetchSectorNews, articleLines } from './news.js'
import { buildExposures } from './exposure.js'
import { mapBranches, scoreIndustries, wouldBeEntries } from './industries.js'
import { effectsFromNodes } from './build.js'
import { NO_SIGNPOST, linksFor } from './network.js'
import { capOut, promote, anchorLinks, withMacroScores } from './layers.js'
import { mapByLayer } from './build.js'
import { macroBackdrop, sectorPriceItems, rewriteSectorState } from './sectorState.js'
import { rewriteState } from './state.js'
import { MACRO, SECTORS, layerOf, originOf, layerName, topNames } from './sectors.js'
import { config } from '../config.js'
import { buildDataSections } from './state.data.js'
import { saveRun, latestRun, readRun, gradeForecasts } from './store.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.update]'
const __dirname = dirname(fileURLToPath(import.meta.url))
const _system = makePromptLoader(join(__dirname, '../../prompts/situation_update.md'), LOG)

export const UPDATE_MODEL = 'claude-opus-5-5'
export const UPDATE_EFFORT = 'high'
export const DECISIONS = Object.freeze(['moves_option', 'new_option', 'new_question', 'resolves', 'outside', 'none'])
/** The review card's lines (§11.1): a move of more than this in one update, or since Roy's last review (drift). */
export const REVIEW_MOVE = 0.10

const _io = {
    latest: () => latestRun(), read: (id) => readRun(id),
    news: (days, asOf) => fetchNews({ days, asOf }),
    call: (args) => callAnthropicStructured(args),
    record: (payer, model, usage) => recordUsage(payer, model, usage, 'situation', { monitor: true }),
    payer: async () => { const { houseLedgerUserId } = await import('../../api/user/user.model.js'); return houseLedgerUserId() },
    system: () => _system(),
    exposures: (names) => buildExposures(names), map: (nodes, inds) => mapBranches(nodes, inds),
    sectorNews: (sector, days, asOf, names) => fetchSectorNews(sector, { days, asOf, names }), names: () => topNames(),
    rewrite: (asOf, o) => rewriteState(asOf, o),
    rewriteSector: (sector, asOf, macroState, rows, articles, questions) => rewriteSectorState(sector, asOf, macroState, rows, articles, questions),
    sectorsOn: () => config.situationSectors,
    links: (nodes, ids) => linksFor(nodes, ids), data: (asOf) => buildDataSections(asOf),
    save: (b) => saveRun(b), grade: (nodeId, option, on) => gradeForecasts(nodeId, option, on),
}
export function _setIO(io) { Object.assign(_io, io) }

const pList = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['option', 'value'], properties: { option: { type: 'string' }, value: { type: 'number' } } } }
const lag = { type: 'object', additionalProperties: false, required: ['min', 'max'], properties: { min: { type: 'integer' }, max: { type: 'integer' } } }
const nul = (s) => ({ anyOf: [s, { type: 'null' }] })

/** The update's schema. Pure. */
export function updateSchema() {
    const opt = { type: 'object', additionalProperties: false, required: ['key', 'label', 'signpost'], properties: { key: { type: 'string' }, label: { type: 'string' }, signpost: { type: 'string' } } }
    return {
        type: 'object', additionalProperties: false, required: ['events', 'signposts_fired', 'due'],
        properties: {
            events: { type: 'array', items: {
                type: 'object', additionalProperties: false,
                required: ['articles', 'summary', 'reasoning', 'decision', 'node', 'probabilities', 'new_option', 'resolution', 'new_question', 'outside'],
                properties: {
                    articles: { type: 'array', items: { type: 'integer' } }, summary: { type: 'string' }, reasoning: { type: 'string' },
                    decision: { type: 'string', enum: [...DECISIONS] }, node: { type: ['integer', 'null'] }, probabilities: pList,
                    new_option: nul(opt),
                    resolution: nul({ type: 'object', additionalProperties: false, required: ['option', 'evidence'], properties: { option: { type: 'string' }, evidence: { type: 'string' } } }),
                    new_question: nul({ type: 'object', additionalProperties: false,
                        required: ['question', 'tree', 'options', 'probabilities', 'impact', 'uncertainty', 'why', 'resolve_by', 'lag_days'],
                        properties: { question: { type: 'string' }, tree: { type: 'string' }, options: { type: 'array', items: opt }, probabilities: pList,
                            impact: { type: 'string', enum: ['low', 'medium', 'high'] }, uncertainty: { type: 'string', enum: ['low', 'medium', 'high'] },
                            why: { type: 'string' }, resolve_by: { type: 'string' }, lag_days: lag } }),
                    outside: nul({ type: 'object', additionalProperties: false, required: ['text', 'industries'], properties: { text: { type: 'string' }, industries: { type: 'array', items: { type: 'string' } } } }),
                },
            } },
            signposts_fired: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['node', 'option', 'evidence', 'articles'],
                properties: { node: { type: 'integer' }, option: { type: 'string' }, evidence: { type: 'string' }, articles: { type: 'array', items: { type: 'integer' } } } } },
            due: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['node', 'resolved', 'option', 'evidence', 'new_resolve_by'],
                properties: { node: { type: 'integer' }, resolved: { type: 'boolean' }, option: { type: ['string', 'null'] }, evidence: { type: 'string' }, new_resolve_by: { type: ['string', 'null'] } } } },
        },
    }
}

/** The live nodes, numbered for the prompt (1-based) → `[{ n, node }]`. Pure. */
export function numbered(nodes) {
    return nodes.filter(n => n.status === 'live').map((node, i) => ({ n: i + 1, node }))
}

/**
 * The update's user message. On the monthly REBUILD `candidates` are the fresh state's questions: each is either in the
 * network already (skip it) or a `new_question` decision. Pure.
 */
export function updatePrompt(asOf, prevAsOf, list, articles, candidates = [], header = null) {
    const lines = list.map(({ n, node }) => {
        const due = node.resolve_by && node.resolve_by <= asOf ? ' DUE' : ''
        const opts = node.options.map(o => `${o.key} = ${o.label} ${Math.round(o.p * 100)}%${o.dormant ? ` (dormant; signpost: ${o.signpost})` : ''}`).join('; ')
        return `${n}. [${node.tree}] ${node.question} (resolve by ${node.resolve_by ?? 'n/a'})${due}\n   ${opts}`
    })
    const cand = candidates.length ? ['', `CANDIDATE QUESTIONS from this month's fresh state (${candidates.length}): for each, it is already in the network (skip it) or it is a new_question decision.`,
        ...candidates.map((q, i) => `C${i + 1}. [${q.tree}] ${q.question} — options: ${q.options.map(o => o.label).join(' / ')}; impact ${q.impact}, uncertainty ${q.uncertainty}`)] : []
    return [...(header ? [header, ''] : []), `AS-OF DATE: ${asOf}. The last update was ${prevAsOf}.`, '', `THE NETWORK (${list.length} live questions):`, ...lines, ...cand, '',
        `THE NEW ARTICLES (${articles.length}):`, articleLines(articles), '', 'Decide every piece of news that matters; then the signposts; then the due questions.'].join('\n')
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)

// A missing signpost or evidence is SAID, never left empty: checkNode requires a signpost on every dormant option and
// evidence on every resolution, and a later week that turns an option dormant must not fail the save (code review
// 2026-11-23). The build's placeholder, the same words.
const signpostOr = (s) => (String(s ?? '').trim() ? s : NO_SIGNPOST)
const evidenceOr = (s, fallback) => (String(s ?? '').trim() || String(fallback ?? '').trim() || 'no evidence was given')

// withDescendants lives with the layer rules (layers.js) since the sector layer; re-exported for its callers.
export { withDescendants } from './layers.js'

/** Was this item written by CODE (state.data.js)? Its sources name a feed, never an article. Pure. */
export const isCodeItem = (i) => /^(FRED |FMP daily bars|FMP earnings calendar|engine |federalreserve\.gov)/.test(String(i?.source ?? ''))

/**
 * The code's data items replaced by fresh ones; everything the MODEL wrote (its readings, and its facts from articles in
 * money and calendar) kept. Pure.
 */
export function refreshSections(prev = {}, data = {}) {
    const out = { ...prev }
    for (const k of ['regime', 'prices', 'money', 'calendar']) {
        if (!Array.isArray(data[k])) continue
        out[k] = [...data[k], ...(prev[k] ?? []).filter(i => !isCodeItem(i))]
    }
    return out
}

/** A probabilities list over a node's option keys → numbers summing to 1, or null if it does not fit. Pure. */
export function fitProbabilities(keys, list) {
    const m = new Map((list ?? []).map(x => [x.option, Math.max(0, Number(x.value) || 0)]))
    const xs = keys.map(k => m.get(k) ?? 0)
    const s = xs.reduce((a, b) => a + b, 0)
    return s > 0 ? xs.map(x => x / s) : null
}

// The cap is held PER LAYER since the sector layer: layers.holdCaps / capOut.

/** What goes on Roy's review card (§11.1, the drift rule). Pure. */
export function reviewItems(prevNodes, nodes, { resolved = [], woken = [], created = [] } = {}) {
    const prev = new Map(prevNodes.map(n => [n.node_id, n]))
    const items = []
    for (const n of nodes) {
        if (n.status !== 'live' || n.kind !== 'open') continue
        const was = prev.get(n.node_id)
        const base = n.review?.p ?? null
        let moved = 0, drift = 0
        for (const o of n.options) {
            if (was) moved = Math.max(moved, Math.abs(o.p - (was.options.find(x => x.key === o.key)?.p ?? 0)))
            if (base) drift = Math.max(drift, Math.abs(o.p - (base[o.key] ?? 0)))
        }
        if (moved > REVIEW_MOVE) items.push({ node_id: n.node_id, why: 'moved', by: moved })
        else if (drift > REVIEW_MOVE) items.push({ node_id: n.node_id, why: 'drift', by: drift })
    }
    for (const id of created) items.push({ node_id: id, why: 'new' })
    for (const w of woken) items.push({ node_id: w.node_id, option: w.option, why: 'woken' })
    for (const r of resolved) items.push({ node_id: r.node_id, option: r.option, why: 'resolved' })
    return items
}

/**
 * Apply the model's answer to the network. Pure apart from new ids. → `{ nodes, decisions, woken, resolved, created,
 * outside, needMap }` — `needMap`: the node ids whose branches are new and must be mapped to industries.
 */
export function applyAnswer(data, list, nodes, asOf, layer = MACRO) {
    let cur = nodes.map(n => ({ ...n, options: n.options.map(o => ({ ...o })) }))
    const at = (k) => list.find(x => x.n === k)?.node.node_id ?? null
    const get = (id) => cur.find(n => n.node_id === id)
    const set = (id, f) => { cur = cur.map(n => (n.node_id === id ? f(n) : n)) }
    const decisions = [], woken = [], resolved = [], created = [], outside = [], needMap = new Set(), rejudged = new Set()
    for (const e of data?.events ?? []) {
        const id = e.node != null ? at(e.node) : null
        const log = { layer, decision: e.decision, node_id: id, summary: String(e.summary ?? '').slice(0, 300), reasoning: String(e.reasoning ?? '').slice(0, 1200), articles: e.articles ?? [], applied: false }
        // Only a LIVE node can move or grow: an earlier decision in this same answer may have resolved it (code review
        // 2026-11-23: a resolved node was saved at 70/30).
        const live = id && get(id)?.status === 'live'
        if (e.decision === 'moves_option' && live) {
            const n = get(id), p = fitProbabilities(n.options.map(o => o.key), e.probabilities)
            if (p) { set(id, x => ({ ...x, options: x.options.map((o, i) => ({ ...o, p: p[i] })) })); rejudged.add(id); log.applied = true }
        } else if (e.decision === 'new_option' && live && e.new_option) {
            const n = get(id), key = KEY.test(e.new_option.key) ? e.new_option.key : snake(e.new_option.key || e.new_option.label)
            if (key && n.options.length < 4 && !n.options.some(o => o.key === key)) {
                const keys = [...n.options.map(o => o.key), key], p = fitProbabilities(keys, e.probabilities)
                if (p) {
                    set(id, x => ({ ...x, options: [...x.options, { key, label: String(e.new_option.label).slice(0, 160), p: 0, signpost: signpostOr(e.new_option.signpost), effects: [] }].map((o, i) => ({ ...o, p: p[i] })) }))
                    rejudged.add(id); needMap.add(id); log.applied = true; log.option = key
                }
            }
        } else if (e.decision === 'resolves' && live && e.resolution) {
            const n = get(id)
            if (n.options.some(o => o.key === e.resolution.option)) {
                const evidence = evidenceOr(e.resolution.evidence, e.summary)
                cur = resolve(cur, id, e.resolution.option, { evidence, on: asOf, by: 'llm' })
                resolved.push({ node_id: id, option: e.resolution.option, evidence }); log.applied = true
            }
        } else if (e.decision === 'new_question' && e.new_question) {
            const q = e.new_question
            const opts = (q.options ?? []).map(o => ({ key: KEY.test(o.key) ? o.key : snake(o.key || o.label), label: o.label, signpost: signpostOr(o.signpost) }))
            const p = fitProbabilities(opts.map(o => o.key), q.probabilities)
            const checked = p ? checkNode({
                node_id: newId('node'), tree: snake(q.tree) || 'other', question: q.question, set_by: 'llm', layer,
                options: opts.map((o, i) => ({ ...o, p: p[i] })), lag: q.lag_days?.min <= q.lag_days?.max ? q.lag_days : null,
                resolve_by: realDate(q.resolve_by) && q.resolve_by >= asOf ? q.resolve_by : null, reasoning: e.reasoning,
            }) : { ok: false, reason: 'its probabilities did not fit its options' }
            if (checked.ok) {
                const node = { ...checked.value, impact: q.impact, review: null }
                cur.push(node); created.push(node.node_id); needMap.add(node.node_id); rejudged.add(node.node_id)
                log.applied = true; log.node_id = node.node_id
            } else log.reason = checked.reason
        } else if (e.decision === 'outside' && e.outside?.text && e.outside.industries?.length) {
            outside.push({ date: asOf, text: e.outside.text, industries: e.outside.industries, source: (e.articles ?? []).join(',') || null }); log.applied = true
        } else if (e.decision === 'none') log.applied = true
        decisions.push(log)
    }
    for (const s of data?.signposts_fired ?? []) {
        const id = at(s.node), n = id && get(id), o = n?.options.find(x => x.key === s.option)
        if (n?.status === 'live' && o?.dormant && !(n.woken ?? []).some(w => w.option === s.option)) {
            set(id, x => ({ ...x, woken: [...(x.woken ?? []), { option: s.option, on: asOf, evidence: String(s.evidence).slice(0, 400) }] }))
            woken.push({ node_id: id, option: s.option, evidence: s.evidence })
        }
    }
    for (const d of data?.due ?? []) {
        const id = at(d.node), n = id && get(id)
        if (!n || n.status !== 'live') continue
        if (d.resolved && n.options.some(o => o.key === d.option)) {
            const evidence = evidenceOr(d.evidence, 'its resolve-by date passed')
            cur = resolve(cur, id, d.option, { evidence, on: asOf, by: 'llm' })
            resolved.push({ node_id: id, option: d.option, evidence })
        } else {
            const next = realDate(d.new_resolve_by) && d.new_resolve_by > asOf ? d.new_resolve_by : addDays(asOf, 14)
            set(id, x => ({ ...x, resolve_by: next }))
        }
    }
    // Every node whose numbers were SET this update gets its kind, dormant flags and a fresh anchor; the rest keep theirs
    // and move only through their links.
    cur = cur.map(n => {
        if (!rejudged.has(n.node_id) || n.status !== 'live') return n
        const top = n.options.reduce((a, b) => (b.p > a.p ? b : a))
        const kind = top.p >= SETTLED_AT ? 'settled' : 'open'
        return { ...n, kind, options: n.options.map(o => ({ ...o, dormant: kind === 'settled' && o.key !== top.key })) }
    })
    return { nodes: cur, decisions, woken, resolved, created, outside, needMap, rejudged }
}

/** Run the update calls this many at a time (the macro one and one per sector). */
export const CALL_CONCURRENCY = 4
/** A sector call's header: its questions only; macro news is the macro layer's. */
export const sectorHeader = (s) => `SECTOR: ${s.name} (GICS ${s.code}). THE NETWORK below is THIS SECTOR's questions only; the macro questions are updated `
    + 'in their own call. A new_question here must be particular to this sector; news that is only macro is `none` here.'

/**
 * Run one update → `{ ok: true, run_id, stats }` or `{ ok: false, reason, cost_usd }`. `kind`: 'weekly', 'event' (then
 * `trigger` names it) or 'rebuild' (then `fresh` carries the fresh states: `{ state, questions, gaps, cost_usd,
 * sectors: [{ sector, state, questions }] }`). `layers` limits an event update to the layers its news touched ('macro'
 * and / or sector codes); a weekly update and a rebuild run every layer. Never throws.
 */
export async function runUpdate({ kind = 'weekly', trigger = null, asOf = new Date().toISOString().slice(0, 10), fresh = null, layers = null } = {}) {
    let cost = fresh?.cost_usd ?? 0
    try {
        const head = await _io.latest()
        if (!head) return { ok: false, reason: 'no complete run to update — build first', cost_usd: cost }
        const prev = await _io.read(head.run_id)
        const days = Math.min(14, Math.max(1, Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${head.as_of}T00:00:00Z`)) / 864e5)))
        let payer = null
        try { payer = await _io.payer() } catch { /* unbooked */ }
        const onUsage = (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) }
        // THE LAYERS this update runs: the macro one, and each sector the network has (or the rebuild brings fresh).
        const prevSS = new Map((prev.sector_states ?? []).map(x => [x.sector, x]))
        const freshSS = new Map((fresh?.sectors ?? []).map(x => [x.sector, x]))
        const want = layers ?? [MACRO, ...SECTORS.map(x => x.code)]
        const sectors = _io.sectorsOn() ? SECTORS.filter(x => want.includes(x.code) && (prevSS.has(x.code) || freshSS.has(x.code))) : []
        const names = sectors.length && !fresh ? await _io.names().catch(() => new Map()) : new Map()
        const jobs = []
        if (want.includes(MACRO)) jobs.push({ layer: MACRO, header: null, candidates: fresh?.questions ?? [] })
        for (const x of sectors) jobs.push({ layer: x.code, sector: x, header: sectorHeader(x), candidates: freshSS.get(x.code)?.questions ?? [] })
        // An event naming only a sector the network does not have still updates something: the macro layer.
        if (!jobs.length) jobs.push({ layer: MACRO, header: null, candidates: [] })
        const run = async (job) => {
            const news = job.layer === MACRO
                ? (fresh?.state ? { articles: fresh.state.articles ?? [], gaps: fresh.gaps ?? [] } : await _io.news(days, asOf))
                : (freshSS.has(job.layer) ? { articles: freshSS.get(job.layer).state.articles ?? [], gaps: [] } : await _io.sectorNews(job.sector, days, asOf, names.get(job.layer) ?? []))
            const mine = prev.nodes.filter(n => layerOf(n) === job.layer)
            const list = numbered(mine)
            // A sector with no live question and no news has nothing to decide.
            if (job.layer !== MACRO && !news.articles?.length && !job.candidates.length) return { ...job, news, list, data: null, skipped: true }
            try {
                const res = await _io.call({ model: UPDATE_MODEL, effort: UPDATE_EFFORT, systemPrompt: _io.system(), user: updatePrompt(asOf, head.as_of, list, news.articles ?? [], job.candidates, job.header), schema: updateSchema(), onUsage })
                return { ...job, news, list, data: res?.data ?? null, stop: res?.stopReason ?? null }
            } catch (err) {
                return { ...job, news, list, data: null, error: err.message }
            }
        }
        const results = []
        for (let i = 0; i < jobs.length; i += CALL_CONCURRENCY) results.push(...await Promise.all(jobs.slice(i, i + CALL_CONCURRENCY).map(run)))
        const macroRes = results.find(r => r.layer === MACRO)
        if (macroRes && !macroRes.data) return { ok: false, reason: `the update call returned no answer (${macroRes.error ?? macroRes.stop ?? 'unknown'})`, cost_usd: cost }
        if (!results.some(r => r.data)) return { ok: false, reason: 'no update call answered', cost_usd: cost }
        const layerGaps = results.filter(r => !r.data && !r.skipped).map(r => `${layerName(r.layer)}: the update call failed (${r.error ?? r.stop ?? 'no answer'}) — its questions carry over unchanged`)
        // Each layer's answer applied in turn; each call saw only its own layer's questions.
        let nodes = prev.nodes
        const applied = { decisions: [], woken: [], resolved: [], created: [], outside: [], needMap: new Set(), rejudged: new Set() }
        for (const r of results) {
            if (!r.data) continue
            const a = applyAnswer(r.data, r.list, nodes, asOf, r.layer)
            nodes = a.nodes
            applied.decisions.push(...a.decisions); applied.woken.push(...a.woken); applied.resolved.push(...a.resolved)
            applied.created.push(...a.created); applied.outside.push(...a.outside)
            for (const id of a.needMap) applied.needMap.add(id)
            for (const id of a.rejudged) applied.rejudged.add(id)
        }
        // The new branches mapped to industries (only them), one mapping per layer group. The industries keep their NAMES:
        // exposures are keyed by basket (`level:code`), as build.js keys them.
        const indNames = new Map((prev.industries ?? []).map(r => [r.code, r.name]))
        const basketNames = new Map((prev.industries ?? []).map(r => [`${r.level}:${r.code}`, r.name]))
        let exp = null
        if (applied.needMap.size) {
            exp = await _io.exposures(basketNames)
            const m = await mapByLayer(nodes.filter(n => applied.needMap.has(n.node_id)), exp.industries, _io.map)
            cost += m.cost_usd ?? 0
            if (m.ok) nodes = nodes.map(n => (applied.needMap.has(n.node_id) ? { ...n, options: n.options.map(o => ({ ...o, effects: m.effects.get(`${n.node_id}|${o.key}`) ?? o.effects ?? [] })) } : n))
        }
        // Promotion (a sector question reaching many sectors moves up), then the caps per layer — every node hanging under a
        // dropped one goes with it.
        const pr = promote(nodes)
        nodes = pr.nodes
        const out = capOut(nodes)
        const capDrops = out.map(id => nodes.find(n => n.node_id === id)).filter(Boolean)
        nodes = nodes.map(n => (out.includes(n.node_id) ? { ...n, status: 'dropped' } : n))
        // Links: the ones still between two kept nodes, plus new ones for the questions this update added.
        const keptIds = new Set(nodes.filter(n => n.status !== 'dropped').map(n => n.node_id))
        let links = (prev.links ?? []).filter(l => keptIds.has(l.from.node_id) && keptIds.has(l.to.node_id))
        const created = applied.created.filter(id => nodes.some(n => n.node_id === id && n.status === 'live'))
        let linksAdded = 0
        if (created.length) {
            const nl = await _io.links(nodes, created)
            cost += nl.cost_usd ?? 0
            linksAdded = nl.links?.length ?? 0
            links = [...links, ...(nl.links ?? [])]
        }
        // Anchors for every node whose numbers were set this update; a new link into any other node counts from now. Then spread.
        nodes = nodes.map(n => (applied.rejudged.has(n.node_id) ? { ...n, anchor: anchorFor(nodes, links, n.node_id, asOf) } : n))
        nodes = anchorLinks(nodes, links)
        const spread = propagate(nodes, links)
        nodes = spread.nodes
        // Industries re-scored over every path (and over the macro layer alone); early warnings beside the scores.
        const inds = (exp?.industries?.length ? exp.industries : (prev.industries ?? []).map(r => ({ code: r.code, name: r.name, level: r.level })))
        const effects = effectsFromNodes(nodes)
        const scored = withMacroScores(scoreIndustries(nodes, links, effects, inds), nodes, links, effects, inds)
        const early = applied.woken.map(w => {
            const n = nodes.find(x => x.node_id === w.node_id), o = n?.options.find(x => x.key === w.option)
            return { node_id: w.node_id, option: w.option, question: n?.question, label: o?.label, p: o?.p, evidence: w.evidence,
                effects: (o?.effects ?? []).filter(e => BUCKETS.includes(e.bucket)).map(e => ({ ...e, name: indNames.get(e.code) ?? e.code })) }
        })
        const industries = scored.map(r => ({ ...r, early_warning: early.filter(w => w.effects.some(e => e.code === r.code)).map(w => ({ node_id: w.node_id, option: w.option, direction: w.effects.find(e => e.code === r.code).direction })) }))
        const entries = wouldBeEntries(prev.industries ?? [], industries, asOf)
        const review = reviewItems(prev.nodes, nodes, applied)
        for (const p of pr.promoted) review.push({ node_id: p.node_id, why: 'promoted', from: p.from })
        // Forecasts: every number SET this update is logged, with its layer; resolutions grade every logged forecast of their node.
        const forecasts = nodes.filter(n => applied.rejudged.has(n.node_id) && n.status === 'live').flatMap(n => n.options.map(o => ({ node_id: n.node_id, option: o.key, p: o.p, set_by: 'llm', resolve_by: n.resolve_by, layer: originOf(n) })))
        const liveNow = nodes.filter(n => n.status === 'live')
        const prevDropped = prev.dropped?.dropped ?? []
        const dropped = {
            considered: 0,   // set below, once the parts are counted
            open: liveNow.filter(n => n.kind === 'open').length, settled: liveNow.filter(n => n.kind === 'settled').length,
            resolved: nodes.filter(n => n.status === 'resolved').length,
            dropped: [...prevDropped, ...capDrops.map(n => ({ question: n.question, options: n.options.map(o => o.label), reason: 'cap', note: `moved out by the cap of its layer (${layerName(layerOf(n))}) on ${asOf}`, flagged: true, layer: layerOf(n) }))],
        }
        dropped.considered = dropped.open + dropped.settled + dropped.resolved + dropped.dropped.length
        // Silence = accept (§11.1): what the card shows becomes Roy's new baseline for the drift rule.
        const onCard = new Set(review.map(r => r.node_id))
        const keep = nodes.filter(n => n.status !== 'dropped')
            .map(n => (onCard.has(n.node_id) ? { ...n, review: { on: asOf, p: Object.fromEntries(n.options.map(o => [o.key, o.p])) } } : n))
        // The macro state: a rebuild brings its own; a weekly update REFRESHES the code's data sections and keeps the model's
        // readings; an event update carries the state over with its news (or its old articles when the macro layer did not run).
        const macroNews = macroRes?.news ?? null
        let state = fresh?.state ?? (prev.state ? { as_of: asOf, sections: prev.state.sections, articles: macroNews ? macroNews.articles : (prev.state.articles ?? []) } : null)
        let dataGaps = [], rows = null
        const liveOf = (layer) => keep.filter(n => n.status === 'live' && layerOf(n) === layer)
        if (!fresh?.state && kind === 'weekly' && state) {
            const data = await _io.data(asOf).catch(err => ({ sections: null, gaps: [`data sections: ${err.message}`] }))
            dataGaps = data.gaps ?? []
            rows = data.numbers?.industries ?? null
            if (data.sections) {
                // THE WEEKLY REWRITE: the macro description from the week's news and the live macro questions (promoted ones
                // included), so it never lags the network. Failed → the code's sections refreshed, the readings carried over.
                const rw = await _io.rewrite(asOf, { data, articles: macroNews?.articles ?? [], gaps: macroNews?.gaps ?? [], questions: liveOf(MACRO) })
                cost += rw.cost_usd ?? 0
                if (rw.ok) state = rw.state
                else {
                    state = { ...state, sections: refreshSections(prev.state.sections, data.sections) }
                    dataGaps.push(`the macro description was not rewritten (${rw.reason}); its readings carry over`)
                }
            }
        }
        // The sector states: fresh on a rebuild; on a weekly update REWRITTEN from the week's articles and the sector's live
        // questions, under the new macro backdrop (failed → backdrop and prices refreshed, the readings carried over); on an
        // event update the articles; a sector that did not run carries over as it was.
        const sector_states = []
        const rewrites = []
        for (const x of SECTORS) {
            const r = results.find(y => y.layer === x.code)
            if (freshSS.has(x.code)) { sector_states.push(freshSS.get(x.code).state); continue }
            const old = prevSS.get(x.code)
            if (!old) continue
            if (!r || r.skipped || !r.data) { sector_states.push(old); continue }
            if (kind === 'weekly' && state) { rewrites.push({ x, old, r }); continue }
            sector_states.push({ ...old, as_of: asOf, articles: r.news?.articles ?? [] })
        }
        for (let i = 0; i < rewrites.length; i += CALL_CONCURRENCY) {
            const done = await Promise.all(rewrites.slice(i, i + CALL_CONCURRENCY).map(async ({ x, old, r }) => {
                const rw = await _io.rewriteSector(x, asOf, state, rows ?? [], r.news?.articles ?? [], liveOf(x.code))
                cost += rw.cost_usd ?? 0
                if (rw.ok) return rw.state
                dataGaps.push(`${x.name}: the description was not rewritten (${rw.reason}); its readings carry over`)
                const sections = { ...old.sections, backdrop: macroBackdrop(state), prices: rows ? sectorPriceItems(x.code, rows) : old.sections.prices }
                return { ...old, as_of: asOf, sections, articles: r.news?.articles ?? [] }
            }))
            sector_states.push(...done)
        }
        sector_states.sort((a, b) => a.sector.localeCompare(b.sector))
        const stats = {
            cost_usd: cost, decisions: applied.decisions, woken: early, resolved: applied.resolved, created: applied.created,
            changes: spread.changes, rounds: spread.rounds, settled: spread.settled, review, entries,
            gaps: [...results.flatMap(r => r.news?.gaps ?? []), ...layerGaps, ...dataGaps],
            links_added: linksAdded, promoted: pr.promoted,
            layers: results.map(r => ({ layer: r.layer, articles: r.news?.articles?.length ?? 0, decisions: (r.data?.events ?? []).length, ran: Boolean(r.data), skipped: Boolean(r.skipped) })),
            sectors: prev.run?.stats?.sectors ? { ...prev.run.stats.sectors, promoted: pr.promoted } : (sector_states.length ? { built: sector_states.map(x => x.sector), failed: [], promoted: pr.promoted } : null),
        }
        // The network must not have moved while this ran (minutes, on Opus): an override saved meanwhile would be written
        // over by numbers from before it (code review 2026-11-23). Moved → nothing saved; the next tick starts again.
        const nowHead = await _io.latest()
        if (nowHead?.run_id !== head.run_id) return { ok: false, reason: 'the network changed while the update ran (an override?) — not saved; the next tick re-runs it', cost_usd: cost }
        const saved = await _io.save({ run: { kind, as_of: asOf, trigger, parent_run_id: head.run_id }, state, sector_states, nodes: keep, links, dropped, industries, forecasts, outside: applied.outside, stats })
        if (!saved.ok) return { ok: false, reason: saved.reason, cost_usd: cost }
        // Grading only once the run that resolved them is SAVED: a failed save must leave no outcome behind.
        for (const r of applied.resolved) await _io.grade(r.node_id, r.option, asOf).catch(err => logger.warn(LOG, 'grading failed', { error: err.message }))
        logger.info(LOG, 'updated', { run_id: saved.run_id, kind, layers: results.filter(r => r.data).length, decisions: applied.decisions.length, review: review.length, cost_usd: cost.toFixed(2) })
        return { ok: true, run_id: saved.run_id, stats }
    } catch (err) {
        logger.warn(LOG, 'the update failed', { error: err.message })
        return { ok: false, reason: err.message, cost_usd: cost }
    }
}
