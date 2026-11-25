// THE EVENT WATCHER AND THE SCHEDULE (docs/design/situation-network.md §11.2; plan step 9).
//
// One tick (the monitor's, every 10 minutes) decides what is due, cheapest first:
//   · nothing built yet → the FIRST BUILD (build.js);
//   · a build or rebuild 28+ days old → the monthly REBUILD: a fresh state whose questions reach the network as
//     candidates through the update (node identity, and so the forecast record, carries on);
//   · the last run 7+ days old → the WEEKLY update;
//   · otherwise, once a day from WATCH_HOUR_UTC (Roy, 2026-11-25; every 3 hours before), the news since the last look (the Federal Register and FMP's general news; no
//     GNews, its quota is the weekly build's) goes to ONE cheap triage call against the live questions and their dormant
//     signposts. Material news → an EVENT update, at most one a day.
// The weekly LLM budget (SITUATION_WEEKLY_USD) holds the event updates: past it, events wait for the weekly run.
// MATERIAL NEWS THAT MUST WAIT IS KEPT (2026-11-24): prod's triage saw Huang's reinstatement after the day's one event
// update was spent; the articles were marked seen and the story was lost. Now the triage's verdict is kept as `pending`
// and its event update runs on the first tick the gap (or the budget) allows; a scheduled run clears it (it reads the
// whole week). Every triage verdict is logged (`triages`, the last TRIAGES_KEPT).
// After every run, Roy's review card (review.js).

import { callAnthropicStructured } from '../../providers/anthropic.provider.js'
import { recordUsage, calcCost } from '../tokenUsage.service.js'
import { getDb } from '../../providers/mongodb.provider.js'
import { echoIntakeService } from '../echoIntake.service.js'
import { toArticle, mergeArticles, articleLines, fetchSectorNews, FMP_MAX_PAGES } from './news.js'
import { buildFull, buildSectors } from './build.js'
import { buildSectorStates } from './layers.js'
import { SECTORS, SECTOR_CODES, MACRO, layerOf, layerName, topNames } from './sectors.js'
import { buildState } from './state.js'
import { runUpdate, numbered } from './update.js'
import { latestRun, readRun, COLLECTIONS, setBusy, clearBusy, getBusy } from './store.js'
import { CONTROL } from './scorecard.js'
import { postReviewCard } from './review.js'
import { runControl } from './control.js'
import { config } from '../config.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.watch]'
export const TRIAGE_MODEL = 'claude-sonnet-5-5'
export const TRIAGE_EFFORT = 'low'
/** The daily look: after the US close and the day's releases. A look missed (a process down) is made at the next tick. */
export const WATCH_HOUR_UTC = 22
/** A look reads the news since the last one: at least a day, at most a week (a process that was down). */
export const LOOK_MAX_DAYS = 7
/** The unseen articles one look gives the triage, newest first; the rest are counted in its log. */
export const WATCH_MAX_ARTICLES = 300
export const SEEN_KEPT = 4000
export const WEEKLY_DAYS = 7
export const REBUILD_DAYS = 28
export const EVENT_MIN_GAP_MS = 24 * 60 * 60 * 1000
export const WATCH = 'situation_watch'

const _io = {
    now: () => new Date(),
    db: () => getDb(),
    latest: () => latestRun(), read: (id) => readRun(id),
    build: (o) => buildFull(o), state: (asOf) => buildState(asOf), update: (o) => runUpdate(o),
    sectors: (o) => buildSectors(o), sectorStates: (o) => buildSectorStates(o), sectorsOn: () => config.situationSectors,
    // The watcher's look at each sector: its Federal Register terms and its largest names' FMP news; no GNews.
    sectorNews: async (now, days = 1) => {
        const names = await topNames().catch(() => new Map())
        const out = []
        for (const x of SECTORS) out.push(...(await fetchSectorNews(x, { days, asOf: now.toISOString().slice(0, 10), names: names.get(x.code) ?? [], gnews: false })).articles)
        return out
    },
    policy: (now, days = 1) => echoIntakeService.policy(now, { days }), fmpNews: (now, days = 1) => echoIntakeService.news(now, { days, pages: FMP_MAX_PAGES }),
    call: (args) => callAnthropicStructured(args),
    record: (payer, model, usage) => recordUsage(payer, model, usage, 'situation', { monitor: true }),
    payer: async () => { const { houseLedgerUserId } = await import('../../api/user/user.model.js'); return houseLedgerUserId() },
    card: (run_id) => postReviewCard(run_id),
    busy: (kind) => setBusy(kind), free: () => clearBusy(),
    isBusy: () => getBusy(undefined, { db: () => _io.db(), now: () => _io.now().toISOString() }),
    // The control, once per scheduled run, over the industries the network scored (the same universe).
    control: async (run_id) => { const run = await readRun(run_id); return run?.state ? runControl(run.state, (run.industries ?? []).map(i => ({ code: i.code, name: i.name, level: i.level })), run.run.as_of) : null },
    budget: () => config.situationWeeklyUsd,
}
export function _setIO(io) { Object.assign(_io, io) }

const day = (d) => d.toISOString().slice(0, 10)
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5)

/**
 * What is due → 'build' | 'sectors' | 'rebuild' | 'weekly' | 'watch'. The weekly clock runs from the last SCHEDULED run
 * (build, rebuild, weekly or sectors), never from an event update or an override — those would push the week back
 * indefinitely (code review 2026-11-23). A network with no sector layer gets one (`needsSectors`). Pure.
 */
export function dueKind(head, lastBuildAsOf, today, lastScheduledAsOf = head?.as_of ?? null, needsSectors = false) {
    if (!head) return 'build'
    if (needsSectors) return 'sectors'
    if (lastBuildAsOf && daysBetween(lastBuildAsOf, today) >= REBUILD_DAYS) return 'rebuild'
    if (daysBetween(lastScheduledAsOf ?? head.as_of, today) >= WEEKLY_DAYS) return 'weekly'
    return 'watch'
}

/** A scheduled job that failed waits this long before it is tried again (it costs real money every try). */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000
/** The busy flag outlives a crashed process this long at most. */
export const BUSY_MAX_MS = 30 * 60 * 1000

/** Is this kind waiting after a failure? Pure. */
export function backingOff(failed, kind, now) {
    return Boolean(failed && failed.kind === kind && now - new Date(failed.at) < RETRY_AFTER_MS)
}

export function triageSchema() {
    return { type: 'object', additionalProperties: false, required: ['material', 'why', 'articles', 'layers'],
        properties: { material: { type: 'boolean' }, why: { type: 'string' }, articles: { type: 'array', items: { type: 'integer' } },
            layers: { type: 'array', items: { type: 'string', enum: [MACRO, ...SECTOR_CODES] } } } }
}

/** The watch's slot: one a day, from WATCH_HOUR_UTC to the next day's. Pure. */
export const lookSlot = (d) => Math.floor((d.getTime() - WATCH_HOUR_UTC * 36e5) / 864e5)
/** How many days back a look reads, from the last look. Pure. */
export const lookDays = (lastAt, now) => (lastAt ? Math.min(LOOK_MAX_DAYS, Math.max(1, Math.ceil((now - new Date(lastAt)) / 864e5))) : 1)

/** How many triage verdicts the watch keeps (its log). */
export const TRIAGES_KEPT = 30

/**
 * A material story that must wait, merged into what already waits → `{ since, why, layers }`: the earliest `since`, the
 * reasons joined (newest last, capped), the layers' union. Pure.
 */
export function mergePending(old, add) {
    if (!old) return { since: add.since, why: String(add.why).slice(0, 280), layers: eventLayers(add.layers) }
    const why = old.why.includes(add.why) ? old.why : `${old.why} · ${add.why}`
    return { since: old.since, why: why.length > 600 ? `…${why.slice(-599)}` : why, layers: eventLayers([...(old.layers ?? []), ...(add.layers ?? [])]) }
}

/** The triage's layers → the event update's: known layers only, each once; none named → the macro layer. Pure. */
export function eventLayers(xs) {
    const out = [...new Set((xs ?? []).filter(x => x === MACRO || SECTOR_CODES.includes(x)))]
    return out.length ? out : [MACRO]
}

export const TRIAGE_SYSTEM = 'You watch the news for the house\'s situation network: a set of open questions about what happens next, each with '
    + 'options, some of them dormant with a signpost. Decide ONE thing: does any of these articles MATERIALLY change a question '
    + '(settles it, shifts its odds clearly, opens an outcome it lacks) or fire a dormant signpost? Routine news, opinion, recaps and '
    + 'small moves are not material — they wait for the weekly update. The questions belong to LAYERS — macro, or a sector code '
    + '(GICS: 10 Energy, 15 Materials, 20 Industrials, 25 Consumer Discretionary, 30 Consumer Staples, 35 Health Care, 40 Financials, '
    + '45 Information Technology, 50 Communication Services, 55 Utilities, 60 Real Estate). When material, name every layer the news '
    + 'touches in `layers` (a sector also when the news opens a question that sector lacks). Answer in the JSON schema; cite the article numbers.'

export function triagePrompt(list, articles) {
    return [`THE LIVE QUESTIONS (${list.length}):`,
        ...list.map(({ n, node }) => `${n}. [${layerOf(node) === MACRO ? 'macro' : `${layerOf(node)} ${layerName(layerOf(node))}`}] ${node.question} — ${node.options.map(o => `${o.label} ${Math.round(o.p * 100)}%${o.dormant ? ` (dormant: ${o.signpost})` : ''}`).join('; ')}`),
        '', `THE ARTICLES (${articles.length}):`, articleLines(articles)].join('\n')
}

/**
 * Everything the network spent in the last seven days: saved runs (their stats), the watcher's own calls, FAILED attempts
 * (recorded in its costs too) and the control's calls (code review 2026-11-23: failures and the control went uncounted).
 */
async function spentThisWeek(db, now) {
    const since = new Date(now.getTime() - 7 * 864e5).toISOString()
    const runs = await db.collection(COLLECTIONS.runs).find({ complete: true, finished_at: { $gte: since } }, { projection: { 'stats.cost_usd': 1 } }).toArray()
    const w = await db.collection(WATCH).findOne({ _id: 'watch' })
    const watched = (w?.costs ?? []).filter(c => c.at >= since).reduce((s, c) => s + (c.usd ?? 0), 0)
    const control = (await db.collection(CONTROL).find({ as_of: { $gte: since.slice(0, 10) } }, { projection: { cost_usd: 1 } }).toArray()).reduce((s, c) => s + (c.cost_usd ?? 0), 0)
    return runs.reduce((s, r) => s + (r.stats?.cost_usd ?? 0), 0) + watched + control
}

// ─── ONE run at a time (Roy's "Run now" beside the schedule, 2026-11-25) ───
// In this process a claim, taken without waiting; across processes the store's BUSY flag, kept fresh while the run goes on
// (a fresh build can outlast the flag's half hour).

export const HEARTBEAT_MS = 5 * 60 * 1000
let _running = null
export const runningKind = () => _running
const claim = (kind) => { if (_running) return false; _running = kind; return true }

/** Run a claimed job under the busy flag. */
async function underFlag(kind, job) {
    let beat = null
    try {
        await _io.busy(kind)
        beat = setInterval(() => { Promise.resolve(_io.busy(kind)).catch(() => {}) }, HEARTBEAT_MS)
        beat.unref?.()
        return await job()
    } finally {
        clearInterval(beat)
        _running = null
        await Promise.resolve(_io.free()).catch(() => {})
    }
}

/** What "Run now" may start: a fresh BUILD (new questions; the old stay as history) or the WEEKLY update. */
export const MANUAL_KINDS = Object.freeze(['build', 'weekly'])

/**
 * Start a run now, outside the schedule → `{ ok: true, kind }` as soon as it has STARTED (it takes many minutes), or
 * `{ ok: false, reason }`. The run is the scheduler's own: the flag, Roy's card and the control after it, its cost
 * counted. How it went is kept as `manual` on the watch record (`manualStatus`). `done` is its promise, for a test.
 */
export async function runNow(kind) {
    if (!MANUAL_KINDS.includes(kind)) return { ok: false, reason: `run one of: ${MANUAL_KINDS.join(', ')}` }
    if (!claim(kind)) return { ok: false, reason: `a ${_running} run is going on already` }
    let coll, started
    try {
        const b = await _io.isBusy()
        if (b) { _running = null; return { ok: false, reason: `a ${b.kind} run is going on already (since ${b.since})` } }
        if (kind === 'weekly' && !(await _io.latest())) { _running = null; return { ok: false, reason: 'there is no network to update yet — build first' } }
        coll = (await _io.db()).collection(WATCH)
        started = _io.now().toISOString()
        await coll.updateOne({ _id: 'watch' }, { $set: { manual: { kind, started_at: started, finished_at: null } } }, { upsert: true })
    } catch (err) {
        _running = null
        return { ok: false, reason: err.message }
    }
    const asOf = started.slice(0, 10)
    const done = (async () => {
        let r
        try { r = await underFlag(kind, () => (kind === 'build' ? _io.build({ asOf, kind }) : _io.update({ kind, asOf }))) } catch (err) { r = { ok: false, reason: err.message } }
        const at = _io.now().toISOString()
        try {
            const w = await coll.findOne({ _id: 'watch' })
            await coll.updateOne({ _id: 'watch' }, { $set: {
                manual: { kind, started_at: started, finished_at: at, ok: Boolean(r?.ok), run_id: r?.run_id ?? null, cost_usd: r?.stats?.cost_usd ?? r?.cost_usd ?? null, reason: r?.ok ? null : String(r?.reason ?? 'failed').slice(0, 300) },
                ...(r?.ok ? { failed: null, pending: null } : { costs: [...(w?.costs ?? []), { at, usd: r?.cost_usd ?? 0, failed: kind }] }),
            } }, { upsert: true })
            if (r?.ok) { await _io.card(r.run_id); await _io.control(r.run_id) }
        } catch (err) { logger.warn(LOG, 'after a manual run', { error: err.message }) }
        logger.info(LOG, 'manual run', { kind, ok: r?.ok, run_id: r?.run_id, reason: r?.reason })
        return r
    })()
    return { ok: true, kind, done }
}

/** → `{ running: { kind, since } | null, last }`: what runs now, and the last manual run. */
export async function manualStatus() {
    const w = await (await _io.db()).collection(WATCH).findOne({ _id: 'watch' })
    const b = await _io.isBusy()
    return { running: b ?? (_running ? { kind: _running, since: null } : null), last: w?.manual ?? null }
}

/** One tick. Never throws. → what it did. */
export async function tick() {
    if (!config.situationNetwork) return { off: true }
    if (_running) return { did: 'busy' }
    const now = _io.now(), today = day(now)
    try {
        // Another process's run (or Roy's "Run now") goes on: the schedule waits for it.
        if (await _io.isBusy()) return { did: 'busy' }
        const head = await _io.latest()
        const db = await _io.db()
        const runs = db.collection(COLLECTIONS.runs)
        const latestOf = (kinds) => runs.find({ complete: true, kind: { $in: kinds } }, { projection: { as_of: 1 } }).sort({ as_of: -1 }).limit(1).next()
        const lastBuild = head ? await latestOf(['build', 'rebuild']) : null
        const lastScheduled = head ? await latestOf(['build', 'rebuild', 'weekly', 'sectors']) : null
        const w = await db.collection(WATCH).findOne({ _id: 'watch' }) ?? { _id: 'watch', last_at: null, last_event_at: null, seen: [], costs: [], failed: null }
        // The sector layer: on, and the head has no sector state → add it (situation-network-layers.md §13 step 7). While a
        // failed attempt waits its day, the macro layer's schedule goes on rather than wait behind it.
        const needsSectors = Boolean(head && _io.sectorsOn() && !backingOff(w.failed, 'sectors', now)
            && !(await db.collection(COLLECTIONS.sectorStates).countDocuments({ run_id: head.run_id }, { limit: 1 })))
        const kind = dueKind(head, lastBuild?.as_of ?? null, today, lastScheduled?.as_of ?? null, needsSectors)
        const save = (set) => db.collection(WATCH).updateOne({ _id: 'watch' }, { $set: set }, { upsert: true })
        const keepCosts = (extra) => [...(w.costs ?? []).filter(c => c.at >= new Date(now.getTime() - 8 * 864e5).toISOString()), ...extra]
        // A scheduled job, run under the busy flag (overrides wait for it), its failure recorded with its cost and backed off.
        const scheduled = async (k, job) => {
            if (backingOff(w.failed, k, now)) return { did: k, waiting: `the last ${k} failed at ${w.failed.at} (${w.failed.reason}); it is tried again a day later` }
            if (!claim(k)) return { did: 'busy' }
            const r = await underFlag(k, job)
            if (r.ok) { await save({ failed: null, pending: null }); await _io.card(r.run_id); await _io.control(r.run_id) }
            else await save({ failed: { kind: k, at: now.toISOString(), reason: String(r.reason ?? 'failed').slice(0, 300) }, costs: keepCosts([{ at: now.toISOString(), usd: r.cost_usd ?? 0, failed: k }]) })
            return { did: k, ...r }
        }
        if (kind === 'build') return scheduled('build', () => _io.build({ asOf: today, kind: 'build' }))
        if (kind === 'sectors') return scheduled('sectors', () => _io.sectors({ asOf: today }))
        if (kind === 'rebuild') return scheduled('rebuild', async () => {
            const st = await _io.state(today)
            if (!st.ok) return { ok: false, reason: st.reason, cost_usd: st.cost_usd ?? 0 }
            // The sectors' fresh states too: their questions reach the network as candidates, like the macro ones.
            const ss = _io.sectorsOn() ? await _io.sectorStates({ asOf: today, state: st.state, rows: st.numbers?.industries ?? [] }) : { sectors: [], cost_usd: 0, gaps: [] }
            const fresh = { ...st, cost_usd: (st.cost_usd ?? 0) + ss.cost_usd, gaps: [...(st.gaps ?? []), ...ss.gaps], sectors: ss.sectors.map(x => ({ sector: x.sector.code, state: x.state.state, questions: x.state.questions })) }
            return _io.update({ kind: 'rebuild', asOf: today, fresh })
        })
        if (kind === 'weekly') return scheduled('weekly', () => _io.update({ kind: 'weekly', asOf: today }))
        // An event update: the day's one, inside the weekly budget. Spent whether it saved or not (a failure's cost counted);
        // the pending story goes with it.
        const gapOpen = !w.last_event_at || now - new Date(w.last_event_at) >= EVENT_MIN_GAP_MS
        const runEvent = async (trigger, layers) => {
            if (!claim('event')) return { did: 'busy' }
            const r = await underFlag('event', () => _io.update({ kind: 'event', trigger, asOf: today, layers }))
            await save({ last_event_at: now.toISOString(), pending: null, ...(r.ok ? {} : { costs: keepCosts([{ at: now.toISOString(), usd: r.cost_usd ?? 0, failed: 'event' }]) }) })
            if (r.ok) await _io.card(r.run_id)
            return { did: 'event', trigger, layers, ...r }
        }
        // The material story that had to wait runs as soon as it may.
        if (w.pending && gapOpen && (await spentThisWeek(db, now)) < _io.budget()) return runEvent(w.pending.why, w.pending.layers)
        // The watch.
        // One look per fixed daily slot, not a day after the last look: two networks (prod and dev, aligned 2026-11-24) then
        // read the news in the same batches whatever time their processes started.
        if (w.last_at && lookSlot(new Date(w.last_at)) === lookSlot(now)) return { did: 'nothing' }
        const days = lookDays(w.last_at, now)
        const raw = [...(await _io.policy(now, days).catch(() => [])).map(r => toArticle(r, 'Federal Register')), ...(await _io.fmpNews(now, days).catch(() => [])).map(r => toArticle(r, 'FMP news'))]
        const sectorRaw = _io.sectorsOn() ? await _io.sectorNews(now, days).catch(() => []) : []
        const seen = new Set(w.seen ?? [])
        // Unseen first, THEN the cap: articles already read must not take its places.
        const unseen = mergeArticles([raw, sectorRaw], today, Infinity).filter(a => !seen.has(a.url ?? a.title))
        const fresh = unseen.slice(0, WATCH_MAX_ARTICLES)
        const keepSeen = [...seen, ...fresh.map(a => a.url ?? a.title)].slice(-SEEN_KEPT)
        if (!fresh.length) { await save({ last_at: now.toISOString(), seen: keepSeen }); return { did: 'watch', articles: 0 } }
        const prev = await _io.read(head.run_id)
        let cost = 0, payer = null
        try { payer = await _io.payer() } catch { /* unbooked */ }
        const res = await _io.call({ model: TRIAGE_MODEL, effort: TRIAGE_EFFORT, systemPrompt: TRIAGE_SYSTEM, user: triagePrompt(numbered(prev.nodes), fresh), schema: triageSchema(),
            onUsage: (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) } })
        const material = Boolean(res?.data?.material)
        const why = String(res?.data?.why ?? (res?.data ? '' : 'the triage returned no answer')).slice(0, 280)
        const layers = material ? eventLayers(res.data.layers) : []
        const triages = [...(w.triages ?? []), { at: now.toISOString(), articles: fresh.length, ...(unseen.length > fresh.length ? { cut: unseen.length - fresh.length } : {}), material, why, layers }].slice(-TRIAGES_KEPT)
        await save({ last_at: now.toISOString(), seen: keepSeen, costs: keepCosts([{ at: now.toISOString(), usd: cost }]), triages })
        w.costs = keepCosts([{ at: now.toISOString(), usd: cost }])
        if (!material) return { did: 'watch', articles: fresh.length, material: false }
        // The layers the news touched: an event update runs only those (the macro layer when the triage named none).
        const trigger = why || 'material news'
        const spent = await spentThisWeek(db, now)
        const wait = !gapOpen ? 'one event update a day' : spent >= _io.budget() ? `the weekly budget ($${_io.budget()}) is spent ($${spent.toFixed(2)})` : null
        if (wait) {
            await save({ pending: mergePending(w.pending, { since: now.toISOString(), why: trigger, layers }) })
            return { did: 'watch', material: true, waiting: wait, pending: true }
        }
        // A story already waiting rides along with this one.
        const p = mergePending(w.pending, { since: now.toISOString(), why: trigger, layers })
        return runEvent(p.why, p.layers)
    } catch (err) {
        logger.warn(LOG, 'tick failed', { error: err.message })
        return { did: 'error', reason: err.message }
    }
}
