// THE FULL BUILD (plan steps 1–8 end to end): the state → the network → each branch mapped to industries → the
// industries scored over every path → one run saved whole (store.saveRun). The monthly rebuild and the first build.
//
// Every stage's cost is summed (`stats.cost_usd`, by stage), every gap kept, and the would-be entries (§11.4: no trades,
// the record only) are logged against the previous complete run.

import { buildState } from './state.js'
import { buildNetwork } from './network.js'
import { buildExposures } from './exposure.js'
import { mapBranches, scoreIndustries, wouldBeEntries } from './industries.js'
import { saveRun, latestRun, readRun } from './store.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.build]'

const _io = { buildState, buildNetwork, buildExposures, mapBranches, saveRun, latestRun, readRun }
export function _setIO(io) { Object.assign(_io, io) }

/** The branches' industry effects, from the nodes they live on → `Map("node|option" → effects)`. Pure. */
export function effectsFromNodes(nodes) {
    const out = new Map()
    for (const n of nodes) for (const o of n.options) out.set(`${n.node_id}|${o.key}`, o.effects ?? [])
    return out
}

/** Put the mapped effects onto the nodes' options. Pure. */
export function withEffects(nodes, effects) {
    return nodes.map(n => ({ ...n, options: n.options.map(o => ({ ...o, effects: effects.get(`${n.node_id}|${o.key}`) ?? [] })) }))
}

/**
 * Build and save → `{ ok: true, run_id, stats }` or `{ ok: false, stage, reason, cost_usd }`. `kind` is 'build' or
 * 'rebuild'. Never throws.
 */
export async function buildFull({ asOf = new Date().toISOString().slice(0, 10), kind = 'build' } = {}) {
    const cost = { state: 0, network: 0, mapping: 0 }
    const total = () => cost.state + cost.network + cost.mapping
    try {
        const st = await _io.buildState(asOf)
        cost.state = st.cost_usd ?? 0
        if (!st.ok) return { ok: false, stage: 'state', reason: st.reason, cost_usd: total() }
        const net = await _io.buildNetwork(st.state, st.questions)
        cost.network = net.cost_usd ?? 0
        if (!net.ok) return { ok: false, stage: 'network', reason: net.reason, cost_usd: total() }
        const names = new Map((st.numbers?.industries ?? []).map(r => [r.basket, r.name]))
        const exp = await _io.buildExposures(names)
        if (!exp.industries.length) return { ok: false, stage: 'exposures', reason: `no industries: ${exp.gaps.join('; ')}`, cost_usd: total() }
        const mapped = await _io.mapBranches(net.nodes, exp.industries)
        cost.mapping = mapped.cost_usd ?? 0
        if (!mapped.ok) return { ok: false, stage: 'mapping', reason: mapped.reason, cost_usd: total() }
        const nodes = withEffects(net.nodes, mapped.effects)
        const industries = scoreIndustries(nodes, net.links, mapped.effects, exp.industries)
        const prevRun = await _io.latestRun().catch(() => null)
        const prev = prevRun ? (await _io.readRun(prevRun.run_id).catch(() => null))?.industries ?? [] : []
        const entries = wouldBeEntries(prev, industries, asOf)
        const stats = {
            cost_usd: total(), cost_by_stage: cost, gaps: [...st.gaps, ...exp.gaps], questions: st.questions.length,
            nodes: nodes.length, links: net.links.length, dropped: net.dropped.dropped.length, runs: net.runs,
            effects_dropped: mapped.dropped, entries, model_answers_dropped: st.dropped,
        }
        const saved = await _io.saveRun({
            run: { kind, as_of: asOf, parent_run_id: prevRun?.run_id ?? null },
            state: st.state, nodes, links: net.links, dropped: net.dropped, industries, forecasts: net.forecasts, stats,
        })
        if (!saved.ok) return { ok: false, stage: 'save', reason: saved.reason, cost_usd: total() }
        logger.info(LOG, 'built', { run_id: saved.run_id, cost_usd: total().toFixed(2), nodes: nodes.length, industries: industries.length })
        return { ok: true, run_id: saved.run_id, stats }
    } catch (err) {
        logger.warn(LOG, 'the build failed', { error: err.message })
        return { ok: false, stage: 'unexpected', reason: err.message, cost_usd: total() }
    }
}
