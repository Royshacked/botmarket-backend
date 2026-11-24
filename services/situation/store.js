// THE SITUATION NETWORK'S STORE (docs/design/situation-network-plan.md step 1).
//
// One collection per record kind (model.js), every document stamped with its `run_id`. A run is written WHOLE and only
// then marked complete, so a reader never sees half a week: `latestRun()` reads complete runs only. Old runs are kept
// (the scorecard reads them); the live view is the latest complete run.
//
// The house's database (getDb), like Echo's: on Render that is `test`, on a laptop `axl_dev` — the forward test runs
// on Render only.

import { getDb } from '../../providers/mongodb.provider.js'
import { checkRun, checkState, checkSectorState, checkNode, checkLink, checkDropped, checkIndustry, checkForecast, checkOutside, newId } from './model.js'

export const COLLECTIONS = Object.freeze({
    runs: 'situation_runs', states: 'situation_states', nodes: 'situation_nodes', links: 'situation_links',
    dropped: 'situation_dropped', industries: 'situation_industries', forecasts: 'situation_forecasts',
    outside: 'situation_outside', sectorStates: 'situation_sector_states',
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
    await c('sectorStates').createIndex({ run_id: 1, sector: 1 }, { unique: true })
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
    // The sector layer's states (situation-network-layers.md §4.2), one per sector.
    out.sector_states = []
    for (const s of bundle.sector_states ?? []) {
        const c = checkSectorState(s)
        if (!c.ok) return { ok: false, reason: `sector state: ${c.reason}` }
        if (out.sector_states.some(x => x.sector === c.value.sector)) return { ok: false, reason: `sector state: two for sector ${c.value.sector}` }
        out.sector_states.push(c.value)
    }
    out.nodes = []
    for (const n of bundle.nodes ?? []) {
        const c = checkNode(n)
        if (!c.ok) return { ok: false, reason: `node: ${c.reason}` }
        out.nodes.push(c.value)
    }
    const byId = new Map(out.nodes.map(n => [n.node_id, n]))
    if (byId.size !== out.nodes.length) return { ok: false, reason: 'node: two nodes share an id' }
    for (const n of out.nodes) {
        if (!n.given) continue
        const parent = byId.get(n.given.node_id)
        if (!parent || !parent.options.some(o => o.key === n.given.option)) return { ok: false, reason: `node: "${n.question.slice(0, 40)}" hangs under ${n.given.node_id}.${n.given.option}, which is not in the run` }
    }
    // No node may hang under itself, however far up (a loop of givens has no path probability).
    for (const n of out.nodes) {
        const seen = new Set([n.node_id])
        for (let g = n.given; g; g = byId.get(g.node_id)?.given) {
            if (seen.has(g.node_id)) return { ok: false, reason: `node: the givens above "${n.question.slice(0, 40)}" loop` }
            seen.add(g.node_id)
        }
    }
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
    if (b.sector_states.length) await c('sectorStates').insertMany(stamp(b.sector_states))
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
    const [state, nodes, links, dropped, industries, outside, sector_states] = await Promise.all([
        c('states').findOne({ run_id }, p), c('nodes').find({ run_id }, p).toArray(), c('links').find({ run_id }, p).toArray(),
        c('dropped').findOne({ run_id }, p), c('industries').find({ run_id }, p).toArray(), c('outside').find({ run_id }, p).toArray(),
        c('sectorStates').find({ run_id }, p).sort({ sector: 1 }).toArray(),
    ])
    return { run, state, nodes, links, dropped, industries, outside, sector_states }
}

/**
 * The graded rows a resolution owes for runs whose forecast lacked the option that happened → one row per such run, p 0,
 * outcome 1, `absent: true`. Open rows are `{ forecast_id, run_id, node_id?, option, p, set_by?, llm_p?, layer?, resolve_by? }`. Pure.
 */
export function absentRows(open, option, on) {
    const byRun = new Map()
    for (const f of open) { if (!byRun.has(f.run_id)) byRun.set(f.run_id, []); byRun.get(f.run_id).push(f) }
    const out = []
    for (const [run_id, rows] of byRun) {
        if (rows.some(f => f.option === option)) continue
        const f = rows[0]
        out.push({ forecast_id: newId('fc'), run_id, node_id: f.node_id, option, p: 0, set_by: f.set_by ?? 'llm', llm_p: f.set_by === 'roy' ? 0 : null,
            reviewed: false, resolve_by: f.resolve_by ?? null, layer: f.layer ?? 'macro', outcome: 1, resolved_on: on, brier: 1, absent: true })
    }
    return out
}

/**
 * Grade every logged forecast of a node once it resolved (§9): outcome 1 for the option that happened, 0 for the rest,
 * and its Brier term (p − outcome)². Only forecasts not graded yet. → the number graded.
 */
export async function gradeForecasts(node_id, option, on, deps = _deps) {
    if (!node_id || !option) return 0
    const db = await deps.db()
    const coll = db.collection(COLLECTIONS.forecasts)
    const rows = await coll.find({ node_id, outcome: null }, { projection: { _id: 0, forecast_id: 1, node_id: 1, option: 1, p: 1, run_id: 1, set_by: 1, layer: 1, resolve_by: 1 } }).toArray()
    // Only forecasts of runs saved WHOLE: a save that failed part-way leaves rows no run stands behind.
    const runIds = [...new Set(rows.map(r => r.run_id))]
    const complete = new Set((await db.collection(COLLECTIONS.runs).find({ run_id: { $in: runIds }, complete: true }, { projection: { _id: 0, run_id: 1 } }).toArray()).map(r => r.run_id))
    const open = rows.filter(r => complete.has(r.run_id))
    for (const f of open) {
        const outcome = f.option === option ? 1 : 0
        await coll.updateOne({ forecast_id: f.forecast_id, outcome: null }, { $set: { outcome, resolved_on: on, brier: (f.p - outcome) ** 2 } })
    }
    // A run whose forecast had NO such option (it was added later — by an update, the outcomes review or the resolution
    // check) gave what happened 0%: one row says so, or the miss would grade as a good forecast (every row it had scored
    // against outcome 0). Marked `absent`; the scorecard counts these questions as unforeseen.
    const missing = absentRows(open, option, on)
    if (missing.length) await coll.insertMany(missing)
    return open.length + missing.length
}

/** Set fields on one node of one run (Roy's override from the board or the card). → true when it matched. */
export async function updateNode(run_id, node_id, set, deps = _deps) {
    const db = await deps.db()
    const r = await db.collection(COLLECTIONS.nodes).updateOne({ run_id, node_id }, { $set: set })
    return r.matchedCount > 0
}

/** Insert forecasts outside a run's save (an override's numbers). */
export async function addForecasts(rows, run_id, deps = _deps) {
    if (!rows?.length) return 0
    const db = await deps.db()
    await db.collection(COLLECTIONS.forecasts).insertMany(rows.map(r => ({ ...r, run_id })))
    return rows.length
}

/** The complete runs, newest first, headers only (the board's history). */
export async function listRuns({ limit = 60 } = {}, deps = _deps) {
    const db = await deps.db()
    return db.collection(COLLECTIONS.runs).find({ complete: true }, { projection: { _id: 0, run_id: 1, kind: 1, as_of: 1, trigger: 1, finished_at: 1, 'stats.cost_usd': 1 } }).sort({ as_of: -1, finished_at: -1 }).limit(limit).toArray()
}

/** One node's numbers run by run, oldest first → `[{ run_id, as_of, kind, status, options: [{ key, p }] }]`. */
export async function nodeHistory(node_id, deps = _deps) {
    const db = await deps.db()
    const rows = await db.collection(COLLECTIONS.nodes).find({ node_id }, { projection: { _id: 0, run_id: 1, status: 1, set_by: 1, options: 1 } }).toArray()
    const runs = await db.collection(COLLECTIONS.runs).find({ run_id: { $in: rows.map(r => r.run_id) }, complete: true }, { projection: { _id: 0, run_id: 1, as_of: 1, kind: 1, finished_at: 1 } }).toArray()
    const byRun = new Map(runs.map(r => [r.run_id, r]))
    return rows.filter(r => byRun.has(r.run_id))
        .map(r => ({ run_id: r.run_id, as_of: byRun.get(r.run_id).as_of, kind: byRun.get(r.run_id).kind, at: byRun.get(r.run_id).finished_at, status: r.status, set_by: r.set_by, options: r.options.map(o => ({ key: o.key, label: o.label, p: o.p })) }))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

// ─── the BUSY flag (code review 2026-11-23): a scheduled or event update takes minutes on Opus; an override saved in that
// window would be written over by the update's numbers. The watcher raises the flag around every update; an override
// waits for it. A crashed process cannot hold it longer than `maxMs`. ─────────────────────────────────────────────────
const BUSY = { coll: 'situation_watch', id: 'busy' }

export async function setBusy(kind, deps = _deps) {
    const db = await deps.db()
    await db.collection(BUSY.coll).updateOne({ _id: BUSY.id }, { $set: { kind, since: deps.now() } }, { upsert: true })
}
export async function clearBusy(deps = _deps) {
    const db = await deps.db()
    await db.collection(BUSY.coll).updateOne({ _id: BUSY.id }, { $set: { kind: null, since: null } }, { upsert: true })
}
/** → `{ kind, since }` while an update runs (and for at most `maxMs`), else null. */
export async function getBusy(maxMs = 30 * 60 * 1000, deps = _deps) {
    const db = await deps.db()
    const b = await db.collection(BUSY.coll).findOne({ _id: BUSY.id })
    if (!b?.kind || !b.since) return null
    return Date.parse(deps.now()) - Date.parse(b.since) < maxMs ? { kind: b.kind, since: b.since } : null
}
