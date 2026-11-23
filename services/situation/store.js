// THE SITUATION NETWORK'S STORE (docs/design/situation-network-plan.md step 1).
//
// One collection per record kind (model.js), every document stamped with its `run_id`. A run is written WHOLE and only
// then marked complete, so a reader never sees half a week: `latestRun()` reads complete runs only. Old runs are kept
// (the scorecard reads them); the live view is the latest complete run.
//
// The house's database (getDb), like Echo's: on Render that is `test`, on a laptop `axl_dev` — the forward test runs
// on Render only.

import { getDb } from '../../providers/mongodb.provider.js'
import { checkRun, checkState, checkNode, checkLink, checkDropped, checkIndustry, checkForecast, checkOutside } from './model.js'

export const COLLECTIONS = Object.freeze({
    runs: 'situation_runs', states: 'situation_states', nodes: 'situation_nodes', links: 'situation_links',
    dropped: 'situation_dropped', industries: 'situation_industries', forecasts: 'situation_forecasts',
    outside: 'situation_outside',
})

const _deps = { db: () => getDb(), now: () => new Date().toISOString() }
export function _setDeps(d) { Object.assign(_deps, d) }

let _indexed = false
export function _resetIndexes() { _indexed = false }
async function _ensureIndexes(db) {
    if (_indexed) return
    const c = (k) => db.collection(COLLECTIONS[k])
    await c('runs').createIndex({ run_id: 1 }, { unique: true })
    await c('runs').createIndex({ complete: 1, as_of: -1, finished_at: -1 })
    await c('states').createIndex({ run_id: 1 }, { unique: true })
    await c('nodes').createIndex({ run_id: 1, node_id: 1 }, { unique: true })
    await c('nodes').createIndex({ node_id: 1, run_id: 1 })
    await c('links').createIndex({ run_id: 1, link_id: 1 }, { unique: true })
    await c('dropped').createIndex({ run_id: 1 }, { unique: true })
    await c('industries').createIndex({ run_id: 1, code: 1 }, { unique: true })
    await c('industries').createIndex({ code: 1, run_id: 1 })
    await c('forecasts').createIndex({ forecast_id: 1 }, { unique: true })
    await c('forecasts').createIndex({ outcome: 1, resolve_by: 1 })
    await c('outside').createIndex({ event_id: 1 }, { unique: true })
    _indexed = true
}

/** Check every record of a run; the first failure is returned with where it was. Pure. */
export function checkBundle(bundle = {}) {
    const run = checkRun(bundle.run)
    if (!run.ok) return { ok: false, reason: `run: ${run.reason}` }
    const out = { run: run.value }
    if (bundle.state) {
        const s = checkState(bundle.state)
        if (!s.ok) return { ok: false, reason: `state: ${s.reason}` }
        out.state = s.value
    }
    out.nodes = []
    for (const n of bundle.nodes ?? []) {
        const c = checkNode(n)
        if (!c.ok) return { ok: false, reason: `node: ${c.reason}` }
        out.nodes.push(c.value)
    }
    const byId = new Map(out.nodes.map(n => [n.node_id, n]))
    if (byId.size !== out.nodes.length) return { ok: false, reason: 'node: two nodes share an id' }
    out.links = []
    for (const l of bundle.links ?? []) {
        const c = checkLink(l, byId)
        if (!c.ok) return { ok: false, reason: `link: ${c.reason}` }
        out.links.push(c.value)
    }
    if (bundle.dropped) {
        const d = checkDropped(bundle.dropped)
        if (!d.ok) return { ok: false, reason: `dropped: ${d.reason}` }
        out.dropped = d.value
    }
    out.industries = []
    for (const i of bundle.industries ?? []) {
        const c = checkIndustry(i)
        if (!c.ok) return { ok: false, reason: `industry: ${c.reason}` }
        out.industries.push(c.value)
    }
    out.forecasts = []
    for (const f of bundle.forecasts ?? []) {
        const c = checkForecast(f)
        if (!c.ok) return { ok: false, reason: `forecast: ${c.reason}` }
        out.forecasts.push(c.value)
    }
    out.outside = []
    for (const o of bundle.outside ?? []) {
        const c = checkOutside(o)
        if (!c.ok) return { ok: false, reason: `outside: ${c.reason}` }
        out.outside.push(c.value)
    }
    return { ok: true, value: out }
}

/**
 * Write a whole run, then mark it complete. → `{ ok: true, run_id }` or `{ ok: false, reason }` (nothing written when
 * a check fails). A write that fails part-way leaves the run INCOMPLETE, which every reader skips.
 */
export async function saveRun(bundle, deps = _deps) {
    const checked = checkBundle(bundle)
    if (!checked.ok) return checked
    const b = checked.value
    const db = await deps.db()
    await _ensureIndexes(db)
    const run_id = b.run.run_id
    const stamp = (docs) => docs.map(d => ({ ...d, run_id }))
    const c = (k) => db.collection(COLLECTIONS[k])
    await c('runs').insertOne({ ...b.run, complete: false, started_at: deps.now(), finished_at: null })
    if (b.state) await c('states').insertOne({ ...b.state, run_id })
    if (b.nodes.length) await c('nodes').insertMany(stamp(b.nodes))
    if (b.links.length) await c('links').insertMany(stamp(b.links))
    if (b.dropped) await c('dropped').insertOne({ ...b.dropped, run_id })
    if (b.industries.length) await c('industries').insertMany(stamp(b.industries))
    if (b.forecasts.length) await c('forecasts').insertMany(stamp(b.forecasts))
    if (b.outside.length) await c('outside').insertMany(stamp(b.outside))
    await c('runs').updateOne({ run_id }, { $set: { complete: true, finished_at: deps.now(), stats: bundle.stats ?? null } })
    return { ok: true, run_id }
}

/** The latest COMPLETE run's header, or null. */
export async function latestRun(deps = _deps) {
    const db = await deps.db()
    return db.collection(COLLECTIONS.runs).find({ complete: true }, { projection: { _id: 0 } })
        .sort({ as_of: -1, finished_at: -1 }).limit(1).next()
}

/** Everything one run wrote, read back whole. Null when the run is unknown or incomplete. */
export async function readRun(run_id, deps = _deps) {
    if (!run_id) return null
    const db = await deps.db()
    const c = (k) => db.collection(COLLECTIONS[k])
    const run = await c('runs').findOne({ run_id, complete: true }, { projection: { _id: 0 } })
    if (!run) return null
    const p = { projection: { _id: 0 } }
    const [state, nodes, links, dropped, industries, outside] = await Promise.all([
        c('states').findOne({ run_id }, p), c('nodes').find({ run_id }, p).toArray(), c('links').find({ run_id }, p).toArray(),
        c('dropped').findOne({ run_id }, p), c('industries').find({ run_id }, p).toArray(), c('outside').find({ run_id }, p).toArray(),
    ])
    return { run, state, nodes, links, dropped, industries, outside }
}
