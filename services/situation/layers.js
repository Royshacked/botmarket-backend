// THE SECTOR LAYER (docs/design/situation-network-layers.md; build steps 6–7).
//
// buildSectorLayer: every sector's state (sectorState.js) and its small network (network.buildNetwork with the sector's
// cap and layer), then ONE links call joining the new sector questions to every live question, macro and sector
// (network.linksFor). A sector that fails is a named gap, never the whole run.
//
// And the pure rules both layers share, used by the build, the sector run and the update:
//   · holdCaps      — the cap PER LAYER: macro 30, with places kept for the core stories and a limit per story; each
//                     sector 3; every sector together 30 (lowest-ranked out first; situation-network-horizons.md §2);
//   · promote       — a sector question whose branches move industries in PROMOTE_AT+ sectors moves to the macro layer;
//   · anchorLinks   — a link added to a node with an anchor counts from NOW (else it would wait for the next anchor);
//   · macroOnly     — the industries scored over the macro branches alone, kept beside the full score (§6).

import { buildSectorState } from './sectorState.js'
import { buildNetwork, linksFor, uncertainty, IMPACT_WEIGHT, OPEN_CAP, BUILD_SLACK } from './network.js'
import { marginal } from './propagate.js'
import { scoreIndustries } from './industries.js'
import { SECTORS, SECTOR_CAP, SECTORS_TOTAL_CAP, PROMOTE_AT, MACRO, layerOf, originOf, sectorOf, layerName, topNames } from './sectors.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.layers]'
/** Sectors built at once (each is a state call and three network runs). */
export const SECTOR_CONCURRENCY = 3

const _io = { state: buildSectorState, network: buildNetwork, links: linksFor, names: () => topNames() }
export function _setIO(io) { Object.assign(_io, io) }

/** The stories always heard: the best CORE_PLACES open questions of each hold a macro place before the rest compete. */
export const CORE_TREES = Object.freeze(['inflation_fed_rates', 'growth_jobs', 'energy', 'tariffs_trade', 'geopolitics'])
export const CORE_PLACES = 2
/** At most this many open macro questions on one story (tree): the scores add up, so a story asked ten times counts ten times. */
export const PER_TREE = 6
/** The tree of a question that named none: not a story, so never limited. */
const NO_TREE = 'other'
/** Reach: how many industries the branches move, as a factor — REACH_MIN at one or none, REACH_MAX at REACH_FULL or more. */
export const REACH_MIN = 0.5
export const REACH_MAX = 1.5
export const REACH_FULL = 10

/** A question's reach factor from its mapped effects. Pure. */
export function reachFactor(node) {
    const n = new Set(node.options.flatMap(o => (o.effects ?? []).map(e => e.code))).size
    return REACH_MIN + (REACH_MAX - REACH_MIN) * Math.min(1, Math.max(0, n - 1) / (REACH_FULL - 1))
}

/** Impact × uncertainty × reach; a question not mapped yet (`unmapped`: its mapping failed) has a reach of 1. Pure. */
export function rankOf(node, unmapped = new Set()) {
    return IMPACT_WEIGHT[node.impact ?? 'medium'] * uncertainty(node.options.map(o => o.p)) * (unmapped.has(node.node_id) ? 1 : reachFactor(node))
}

/** The macro places: the core stories' best first, then by rank, at most PER_TREE a story → `Map(id → reason)` moved out. Pure. */
function macroOut(sorted, cap) {
    const core = new Set(CORE_TREES.flatMap(t => sorted.filter(n => n.tree === t).slice(0, CORE_PLACES)))
    const kept = new Set(), perTree = new Map(), out = new Map()
    for (const n of [...sorted.filter(x => core.has(x)), ...sorted.filter(x => !core.has(x))]) {
        const used = perTree.get(n.tree) ?? 0
        if (n.tree !== NO_TREE && used >= PER_TREE) { out.set(n.node_id, 'story_full'); continue }
        if (kept.size >= cap) { out.set(n.node_id, 'cap'); continue }
        kept.add(n.node_id)
        perTree.set(n.tree, used + 1)
    }
    return out
}

/**
 * The cap per layer → `Map(node id → 'cap' | 'story_full')` of those moved out, lowest-ranked first in each layer: macro
 * over OPEN_CAP (macroOut); each sector over SECTOR_CAP; then every sector together over SECTORS_TOTAL_CAP. Only LIVE,
 * OPEN nodes count. Pure.
 */
export function holdCaps(nodes, { macro = OPEN_CAP, sector = SECTOR_CAP, total = SECTORS_TOTAL_CAP, unmapped = new Set() } = {}) {
    const open = nodes.filter(n => n.status === 'live' && n.kind === 'open')
    const rank = (n) => rankOf(n, unmapped)
    const out = new Map()
    const byLayer = new Map()
    for (const n of open) { const l = layerOf(n); if (!byLayer.has(l)) byLayer.set(l, []); byLayer.get(l).push(n) }
    const kept = []
    for (const [l, ns] of byLayer) {
        const sorted = [...ns].sort((a, b) => rank(b) - rank(a))
        if (l === MACRO) { for (const [id, reason] of macroOut(sorted, macro)) out.set(id, reason); continue }
        for (const n of sorted.slice(sector)) out.set(n.node_id, 'cap')
        kept.push(...sorted.slice(0, sector))
    }
    for (const n of kept.sort((a, b) => rank(b) - rank(a)).slice(total)) out.set(n.node_id, 'cap')
    return out
}

/**
 * The ids to drop with these: every node hanging (by `given`) under one of them, however far down. A dropped parent
 * cannot leave its children behind — the save would reject them (code review 2026-11-23). Pure.
 */
export function withDescendants(nodes, ids) {
    const out = new Set(ids)
    let grew = true
    while (grew) {
        grew = false
        for (const n of nodes) if (n.given && out.has(n.given.node_id) && !out.has(n.node_id)) { out.add(n.node_id); grew = true }
    }
    return [...out]
}

/** The cap per layer, and every node hanging under one moved out with it → `Map(node id → reason)`. Pure. */
export function capOut(nodes, caps) {
    const held = holdCaps(nodes, caps)
    return new Map(withDescendants(nodes, held.keys()).map(id => [id, held.get(id) ?? 'cap']))
}

/** A question moved out by the caps, as the dropped list keeps it. Pure. */
export function capDrop(node, reason, asOf) {
    const layer = layerOf(node)
    const note = reason === 'story_full' ? `its story (${node.tree}) already has ${PER_TREE} open questions on ${asOf}` : `moved out by the cap of its layer (${layerName(layer)}) on ${asOf}`
    return { question: node.question, options: node.options.map(o => o.label), reason, note, flagged: true, layer }
}

/** The sectors a node's branches reach through their mapped effects. Pure. */
export function sectorsReached(node) {
    return new Set(node.options.flatMap(o => (o.effects ?? []).map(e => sectorOf(e.code))).filter(Boolean))
}

/** A sector question that moves industries in `at`+ sectors moves up to the macro layer (§5.1) → `{ nodes, promoted }`. Pure. */
export function promote(nodes, at = PROMOTE_AT) {
    const promoted = []
    const out = nodes.map(n => {
        if (n.status !== 'live' || layerOf(n) === MACRO) return n
        const reached = sectorsReached(n)
        if (reached.size < at) return n
        promoted.push({ node_id: n.node_id, from: layerOf(n), sectors: [...reached].sort() })
        return { ...n, layer: MACRO, origin: originOf(n) }
    })
    return { nodes: out, promoted }
}

/**
 * New links counted from NOW: each one into a node that has an anchor, and that its anchor does not know yet, gets its
 * source's marginal written into that anchor (propagate.recompute skips a link the anchor does not know). Pure.
 */
export function anchorLinks(nodes, newLinks) {
    if (!newLinks.length) return nodes
    const map = new Map(nodes.map(n => [n.node_id, n]))
    const add = new Map()
    for (const l of newLinks) {
        const a = map.get(l.to.node_id)?.anchor
        if (!a || typeof a.src?.[l.link_id] === 'number') continue   // already counted
        if (!add.has(l.to.node_id)) add.set(l.to.node_id, {})
        add.get(l.to.node_id)[l.link_id] = marginal(nodes, l.from.node_id, l.from.option, map)
    }
    return nodes.map(n => (add.has(n.node_id) ? { ...n, anchor: { ...n.anchor, src: { ...n.anchor.src, ...add.get(n.node_id) } } } : n))
}

/**
 * The industries scored over the MACRO layer alone — the questions BORN macro (a promoted sector question is the sector
 * layer's work), the links between them, their effects — written onto each row as `macro: { p_win, p_lose }` (0 / 0
 * where no macro branch reaches it). Pure.
 */
export function withMacroScores(rows, nodes, links, effects, industries, opts = {}) {
    const macroNodes = nodes.filter(n => originOf(n) === MACRO)
    const ids = new Set(macroNodes.map(n => n.node_id))
    const macroEffects = new Map([...effects].filter(([k]) => ids.has(k.split('|')[0])))
    const macroLinks = links.filter(l => ids.has(l.from.node_id) && ids.has(l.to.node_id))
    const m = new Map(scoreIndustries(macroNodes, macroLinks, macroEffects, industries, opts).map(r => [r.code, r]))
    const of = (x) => ({ p_win: x?.p_win ?? 0, p_lose: x?.p_lose ?? 0 })
    return rows.map(r => ({ ...r, macro: of(m.get(r.code)), ...(r.far ? { far: { ...r.far, macro: of(m.get(r.code)?.far) } } : {}) }))
}

/** Run `fn` over `xs`, `k` at a time, in order. */
async function inBatches(xs, k, fn) {
    const out = []
    for (let i = 0; i < xs.length; i += k) out.push(...await Promise.all(xs.slice(i, i + k).map(fn)))
    return out
}

/**
 * Every sector's STATE (no network) → `{ sectors: [{ sector, state: { state, questions } }], cost_usd, gaps, failed }`.
 * The monthly rebuild's fresh sector states, and the first half of buildSectorLayer. Never throws.
 */
export async function buildSectorStates({ asOf, state, rows = [], only = null }) {
    const sectors = only ? SECTORS.filter(s => only.includes(s.code)) : SECTORS
    const names = await _io.names().catch(() => new Map())
    let cost = 0
    const gaps = [], failed = []
    const built = await inBatches(sectors, SECTOR_CONCURRENCY, async (sector) => {
        const st = await _io.state(sector, asOf, state, rows, names.get(sector.code) ?? [])
        cost += st.cost_usd ?? 0
        gaps.push(...(st.gaps ?? []))
        if (!st.ok) { failed.push({ sector: sector.code, stage: 'state', reason: st.reason }); return null }
        return { sector, state: st }
    })
    return { sectors: built.filter(Boolean), cost_usd: cost, gaps, failed }
}

/**
 * Build the sector layer under a macro state → `{ sector_states, nodes, links, dropped, forecasts, questions, cost_usd,
 * gaps, failed }`. `existing` are the live nodes already in the network (macro, and any sectors not rebuilt): the new
 * sector questions are linked to them. `only` limits the sectors built. Never throws.
 */
export async function buildSectorLayer({ asOf, state, rows = [], existing = [], only = null }) {
    const states = await buildSectorStates({ asOf, state, rows, only })
    let cost = states.cost_usd
    const gaps = [...states.gaps], failed = [...states.failed]
    const built = await inBatches(states.sectors, SECTOR_CONCURRENCY, async ({ sector, state: st }) => {
        if (!st.questions.length) return { sector, state: st.state, net: { nodes: [], links: [], dropped: { considered: 0, dropped: [] }, forecasts: [] } }
        const net = await _io.network(st.state, st.questions, { cap: Math.ceil(SECTOR_CAP * BUILD_SLACK), layer: sector.code, title: `SECTOR: ${sector.name} (GICS ${sector.code}). Its questions only; the macro layer is linked later.` })
        cost += net.cost_usd ?? 0
        if (!net.ok) { failed.push({ sector: sector.code, stage: 'network', reason: net.reason }); return { sector, state: st.state, net: null } }
        return { sector, state: st.state, net }
    })
    const ok = built.filter(Boolean)
    const nodes = ok.flatMap(b => b.net?.nodes ?? [])
    let links = ok.flatMap(b => b.net?.links ?? [])
    const dropped = ok.flatMap(b => b.net?.dropped?.dropped ?? [])
    const considered = ok.reduce((s, b) => s + (b.net?.dropped?.considered ?? 0), 0)
    const forecasts = ok.flatMap(b => b.net?.forecasts ?? [])
    // ONE links call over the whole network, for the new sector questions: macro → sector, sector → sector, sector → macro.
    if (nodes.length) {
        const all = [...existing.filter(n => n.status === 'live'), ...nodes]
        const nl = await _io.links(all, nodes.map(n => n.node_id))
        cost += nl.cost_usd ?? 0
        if (!nl.ok) gaps.push('the cross-layer links call failed: the sector questions are linked inside their sector only')
        const seen = new Set(links.map(l => `${l.from.node_id}.${l.from.option}>${l.to.node_id}.${l.to.option}`))
        for (const l of nl.links ?? []) {
            const k = `${l.from.node_id}.${l.from.option}>${l.to.node_id}.${l.to.option}`
            if (!seen.has(k)) { seen.add(k); links.push(l) }
        }
    }
    if (failed.length) logger.warn(LOG, 'sectors failed', { failed })
    return { sector_states: ok.map(b => b.state), nodes, links, dropped, considered, forecasts, cost_usd: cost, gaps, failed }
}
