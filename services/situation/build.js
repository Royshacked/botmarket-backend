// THE FULL BUILD (plan steps 1–8 end to end): the state → the network → each branch mapped to industries → the
// industries scored over every path → one run saved whole (store.saveRun). The monthly rebuild and the first build.
//
// Since 2026-11-23 the build makes BOTH layers (docs/design/situation-network-layers.md): the macro state and network as
// before, then the sector layer under it (layers.buildSectorLayer). A network built before the sector layer gets the
// layer ADDED on top of its latest run (`buildSectors`, run kind `sectors`): the macro questions keep their identity.
//
// Every stage's cost is summed (`stats.cost_usd`, by stage), every gap kept, and the would-be entries (§11.4: no trades,
// the record only) are logged against the previous complete run.

import { buildState } from './state.js'
import { buildNetwork } from './network.js'
import { buildExposures } from './exposure.js'
import { mapBranches, scoreIndustries, wouldBeEntries } from './industries.js'
import { buildSectorLayer, promote, capOut, anchorLinks, withMacroScores } from './layers.js'
import { buildDataSections } from './state.data.js'
import { MACRO, layerOf, originOf } from './sectors.js'
import { saveRun, latestRun, readRun } from './store.js'
import { config } from '../config.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.build]'

const _io = { buildState, buildNetwork, buildExposures, mapBranches, buildSectorLayer, saveRun, latestRun, readRun, data: (asOf) => buildDataSections(asOf), sectorsOn: () => config.situationSectors }
export function _setIO(io) { Object.assign(_io, io) }

/** The branches' industry effects, from the nodes they live on → `Map("node|option" → effects)`. Pure. */
export function effectsFromNodes(nodes) {
    const out = new Map()
    for (const n of nodes) for (const o of n.options) out.set(`${n.node_id}|${o.key}`, o.effects ?? [])
    return out
}

/** Put the mapped effects onto the nodes' options. Pure. */
export function withEffects(nodes, effects) {
    return nodes.map(n => ({ ...n, options: n.options.map(o => ({ ...o, effects: effects.get(`${n.node_id}|${o.key}`) ?? o.effects ?? [] })) }))
}

/**
 * Map nodes to industries, ONE mapping per layer group (macro, sectors) in parallel, so neither prompt holds every
 * branch → `{ ok, effects, cost_usd, dropped, disagreed, reason }`. A group that fails fails the whole mapping.
 */
export async function mapByLayer(nodes, industries, map = _io.mapBranches) {
    const groups = [nodes.filter(n => layerOf(n) === MACRO), nodes.filter(n => layerOf(n) !== MACRO)].filter(g => g.length)
    const res = await Promise.all(groups.map(g => map(g, industries)))
    const cost = res.reduce((s, r) => s + (r.cost_usd ?? 0), 0)
    const bad = res.find(r => !r.ok)
    if (bad) return { ok: false, reason: bad.reason, cost_usd: cost }
    const effects = new Map(res.flatMap(r => [...r.effects]))
    return { ok: true, effects, cost_usd: cost, dropped: res.reduce((s, r) => s + (r.dropped ?? 0), 0), disagreed: res.reduce((s, r) => s + (r.disagreed ?? 0), 0) }
}

/**
 * The shared end of a build: promotion, the caps per layer (children go with their parents), links between kept nodes,
 * new links counted from now, the forecasts of kept nodes with their final layer, the dropped list. Pure.
 */
export function settle({ nodes, links, forecasts, dropped, asOf }) {
    const pr = promote(nodes)
    const out = new Set(capOut(pr.nodes))
    const kept = pr.nodes.filter(n => !out.has(n.node_id))
    const ids = new Set(kept.map(n => n.node_id))
    const keptLinks = links.filter(l => ids.has(l.from.node_id) && ids.has(l.to.node_id))
    const anchored = anchorLinks(kept, keptLinks)
    // A forecast is graded by its question's ORIGIN (a promoted question stays the sector layer's work).
    const origin = new Map(kept.map(n => [n.node_id, originOf(n)]))
    const fc = forecasts.filter(f => ids.has(f.node_id)).map(f => ({ ...f, layer: origin.get(f.node_id) }))
    const capped = pr.nodes.filter(n => out.has(n.node_id)).map(n => ({ question: n.question, options: n.options.map(o => o.label), reason: 'cap', note: `moved out by the cap of its layer on ${asOf}`, flagged: true, layer: layerOf(n) }))
    const live = anchored.filter(n => n.status === 'live')
    const list = [...dropped, ...capped]
    const open = live.filter(n => n.kind === 'open').length, settledN = live.filter(n => n.kind === 'settled').length
    const resolved = anchored.filter(n => n.status === 'resolved').length
    return {
        nodes: anchored, links: keptLinks, forecasts: fc, promoted: pr.promoted,
        // Every question is kept or in the list (promotion and the cap move, never lose one), so the counts add up.
        dropped: { considered: open + settledN + resolved + list.length, open, settled: settledN, resolved, dropped: list },
    }
}

/**
 * Build and save → `{ ok: true, run_id, stats }` or `{ ok: false, stage, reason, cost_usd }`. `kind` is 'build' or
 * 'rebuild'. Never throws.
 */
export async function buildFull({ asOf = new Date().toISOString().slice(0, 10), kind = 'build' } = {}) {
    const cost = { state: 0, network: 0, sectors: 0, mapping: 0 }
    const total = () => cost.state + cost.network + cost.sectors + cost.mapping
    try {
        const st = await _io.buildState(asOf)
        cost.state = st.cost_usd ?? 0
        if (!st.ok) return { ok: false, stage: 'state', reason: st.reason, cost_usd: total() }
        const net = await _io.buildNetwork(st.state, st.questions)
        cost.network = net.cost_usd ?? 0
        if (!net.ok) return { ok: false, stage: 'network', reason: net.reason, cost_usd: total() }
        // The sector layer under it (situation-network-layers.md).
        let sec = { sector_states: [], nodes: [], links: [], dropped: [], considered: 0, forecasts: [], gaps: [], failed: [] }
        if (_io.sectorsOn()) {
            sec = await _io.buildSectorLayer({ asOf, state: st.state, rows: st.numbers?.industries ?? [], existing: net.nodes })
            cost.sectors = sec.cost_usd ?? 0
        }
        const names = new Map((st.numbers?.industries ?? []).map(r => [r.basket, r.name]))
        const exp = await _io.buildExposures(names)
        if (!exp.industries.length) return { ok: false, stage: 'exposures', reason: `no industries: ${exp.gaps.join('; ')}`, cost_usd: total() }
        const all = [...net.nodes, ...sec.nodes]
        const mapped = await mapByLayer(all, exp.industries, _io.mapBranches)
        cost.mapping = mapped.cost_usd ?? 0
        if (!mapped.ok) return { ok: false, stage: 'mapping', reason: mapped.reason, cost_usd: total() }
        const done = settle({
            nodes: withEffects(all, mapped.effects), links: [...net.links, ...sec.links], forecasts: [...net.forecasts, ...sec.forecasts],
            dropped: [...net.dropped.dropped, ...sec.dropped], asOf,
        })
        const effects = effectsFromNodes(done.nodes)
        const industries = withMacroScores(scoreIndustries(done.nodes, done.links, effects, exp.industries), done.nodes, done.links, effects, exp.industries)
        const prevRun = await _io.latestRun().catch(() => null)
        const prev = prevRun ? (await _io.readRun(prevRun.run_id).catch(() => null))?.industries ?? [] : []
        const entries = wouldBeEntries(prev, industries, asOf)
        const stats = {
            cost_usd: total(), cost_by_stage: cost, gaps: [...st.gaps, ...exp.gaps, ...sec.gaps], questions: st.questions.length,
            nodes: done.nodes.length, links: done.links.length, dropped: done.dropped.dropped.length, runs: net.runs,
            effects_dropped: mapped.dropped, entries, model_answers_dropped: st.dropped,
            sectors: { built: sec.sector_states.map(s => s.sector), failed: sec.failed, promoted: done.promoted },
        }
        const saved = await _io.saveRun({
            run: { kind, as_of: asOf, parent_run_id: prevRun?.run_id ?? null },
            state: st.state, sector_states: sec.sector_states, nodes: done.nodes, links: done.links, dropped: done.dropped, industries, forecasts: done.forecasts, stats,
        })
        if (!saved.ok) return { ok: false, stage: 'save', reason: saved.reason, cost_usd: total() }
        logger.info(LOG, 'built', { run_id: saved.run_id, cost_usd: total().toFixed(2), nodes: done.nodes.length, industries: industries.length, sectors: sec.sector_states.length })
        return { ok: true, run_id: saved.run_id, stats }
    } catch (err) {
        logger.warn(LOG, 'the build failed', { error: err.message })
        return { ok: false, stage: 'unexpected', reason: err.message, cost_usd: total() }
    }
}

/** Does this run carry the sector layer? (A run saved before it has no sector states.) Pure. */
export const hasSectors = (run) => Boolean(run?.stats?.sectors?.built?.length)

/**
 * ADD the sector layer to the latest run (a network built before it) → `{ ok, run_id, stats }` or `{ ok: false, stage,
 * reason, cost_usd }`. The macro nodes, links and state carry over unchanged; the sector questions are linked into them.
 * Run kind `sectors`. Never throws.
 */
export async function buildSectors({ asOf = new Date().toISOString().slice(0, 10) } = {}) {
    const cost = { sectors: 0, mapping: 0 }
    const total = () => cost.sectors + cost.mapping
    try {
        const head = await _io.latestRun()
        if (!head) return { ok: false, stage: 'head', reason: 'no complete run to add the sectors to — build first', cost_usd: 0 }
        const prev = await _io.readRun(head.run_id)
        const data = await _io.data(asOf).catch(err => ({ numbers: {}, gaps: [`data sections: ${err.message}`] }))
        const rows = data.numbers?.industries ?? []
        const existing = prev.nodes.filter(n => n.status !== 'dropped' && n.status !== 'split')
        const sec = await _io.buildSectorLayer({ asOf, state: prev.state, rows, existing })
        cost.sectors = sec.cost_usd ?? 0
        if (!sec.sector_states.length) return { ok: false, stage: 'sectors', reason: `no sector was built: ${sec.failed.map(f => `${f.sector} ${f.reason}`).join('; ')}`, cost_usd: total() }
        const names = new Map(rows.map(r => [r.basket, r.name]))
        const exp = await _io.buildExposures(names)
        if (!exp.industries.length) return { ok: false, stage: 'exposures', reason: `no industries: ${exp.gaps.join('; ')}`, cost_usd: total() }
        const mapped = await mapByLayer(sec.nodes, exp.industries, _io.mapBranches)
        cost.mapping = mapped.cost_usd ?? 0
        if (!mapped.ok) return { ok: false, stage: 'mapping', reason: mapped.reason, cost_usd: total() }
        const pd = prev.dropped ?? { dropped: [] }
        const done = settle({
            nodes: [...existing, ...withEffects(sec.nodes, mapped.effects)], links: [...(prev.links ?? []), ...sec.links], forecasts: sec.forecasts,
            dropped: [...(pd.dropped ?? []), ...sec.dropped], asOf,
        })
        const effects = effectsFromNodes(done.nodes)
        const industries = withMacroScores(scoreIndustries(done.nodes, done.links, effects, exp.industries), done.nodes, done.links, effects, exp.industries)
        const entries = wouldBeEntries(prev.industries ?? [], industries, asOf)
        const stats = {
            cost_usd: total(), cost_by_stage: cost, gaps: [...(data.gaps ?? []), ...exp.gaps, ...sec.gaps], nodes: done.nodes.length, links: done.links.length,
            entries, effects_dropped: mapped.dropped, sectors: { built: sec.sector_states.map(s => s.sector), failed: sec.failed, promoted: done.promoted },
        }
        const saved = await _io.saveRun({
            run: { kind: 'sectors', as_of: asOf, parent_run_id: head.run_id },
            state: prev.state ?? null, sector_states: sec.sector_states, nodes: done.nodes, links: done.links,
            dropped: done.dropped, industries, forecasts: done.forecasts, outside: [], stats,
        })
        if (!saved.ok) return { ok: false, stage: 'save', reason: saved.reason, cost_usd: total() }
        logger.info(LOG, 'sectors added', { run_id: saved.run_id, cost_usd: total().toFixed(2), sectors: sec.sector_states.length, nodes: done.nodes.length })
        return { ok: true, run_id: saved.run_id, stats }
    } catch (err) {
        logger.warn(LOG, 'adding the sectors failed', { error: err.message })
        return { ok: false, stage: 'unexpected', reason: err.message, cost_usd: total() }
    }
}
