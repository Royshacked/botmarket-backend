// THE EVENT WATCHER AND THE SCHEDULE (docs/design/situation-network.md §11.2; plan step 9).
//
// One tick (the monitor's, every hour) decides what is due, cheapest first:
//   · nothing built yet → the FIRST BUILD (build.js);
//   · a build or rebuild 28+ days old → the monthly REBUILD: a fresh state whose questions reach the network as
//     candidates through the update (node identity, and so the forecast record, carries on);
//   · the last run 7+ days old → the WEEKLY update;
//   · otherwise, every WATCH_EVERY_MS, the news since the last look (the Federal Register and FMP's general news; no
//     GNews, its quota is the weekly build's) goes to ONE cheap triage call against the live questions and their dormant
//     signposts. Material news → an EVENT update, at most one a day.
// The weekly LLM budget (SITUATION_WEEKLY_USD) holds the event updates: past it, events wait for the weekly run.
// After every run, Roy's review card (review.js).

import { callAnthropicStructured } from '../../providers/anthropic.provider.js'
import { recordUsage, calcCost } from '../tokenUsage.service.js'
import { getDb } from '../../providers/mongodb.provider.js'
import { echoIntakeService } from '../echoIntake.service.js'
import { toArticle, mergeArticles, articleLines } from './news.js'
import { buildFull } from './build.js'
import { buildState } from './state.js'
import { runUpdate, numbered } from './update.js'
import { latestRun, readRun, COLLECTIONS, setBusy, clearBusy } from './store.js'
import { CONTROL } from './scorecard.js'
import { postReviewCard } from './review.js'
import { runControl } from './control.js'
import { config } from '../config.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.watch]'
export const TRIAGE_MODEL = 'claude-sonnet-5-5'
export const TRIAGE_EFFORT = 'low'
export const WATCH_EVERY_MS = 3 * 60 * 60 * 1000
export const WEEKLY_DAYS = 7
export const REBUILD_DAYS = 28
export const EVENT_MIN_GAP_MS = 24 * 60 * 60 * 1000
export const WATCH = 'situation_watch'

const _io = {
    now: () => new Date(),
    db: () => getDb(),
    latest: () => latestRun(), read: (id) => readRun(id),
    build: (o) => buildFull(o), state: (asOf) => buildState(asOf), update: (o) => runUpdate(o),
    policy: (now) => echoIntakeService.policy(now, { days: 1 }), fmpNews: (now) => echoIntakeService.news(now, { days: 1, pages: 2 }),
    call: (args) => callAnthropicStructured(args),
    record: (payer, model, usage) => recordUsage(payer, model, usage, 'situation', { monitor: true }),
    payer: async () => { const { houseLedgerUserId } = await import('../../api/user/user.model.js'); return houseLedgerUserId() },
    card: (run_id) => postReviewCard(run_id),
    busy: (kind) => setBusy(kind), free: () => clearBusy(),
    // The control, once per scheduled run, over the industries the network scored (the same universe).
    control: async (run_id) => { const run = await readRun(run_id); return run?.state ? runControl(run.state, (run.industries ?? []).map(i => ({ code: i.code, name: i.name, level: i.level })), run.run.as_of) : null },
    budget: () => config.situationWeeklyUsd,
}
export function _setIO(io) { Object.assign(_io, io) }

const day = (d) => d.toISOString().slice(0, 10)
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5)

/**
 * What is due → 'build' | 'rebuild' | 'weekly' | 'watch'. The weekly clock runs from the last SCHEDULED run (build,
 * rebuild or weekly), never from an event update or an override — those would push the week back indefinitely (code
 * review 2026-11-23). Pure.
 */
export function dueKind(head, lastBuildAsOf, today, lastScheduledAsOf = head?.as_of ?? null) {
    if (!head) return 'build'
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
    return { type: 'object', additionalProperties: false, required: ['material', 'why', 'articles'],
        properties: { material: { type: 'boolean' }, why: { type: 'string' }, articles: { type: 'array', items: { type: 'integer' } } } }
}

export const TRIAGE_SYSTEM = 'You watch the news for the house\'s situation network: a set of open questions about what happens next, each with '
    + 'options, some of them dormant with a signpost. Decide ONE thing: does any of these articles MATERIALLY change a question '
    + '(settles it, shifts its odds clearly, opens an outcome it lacks) or fire a dormant signpost? Routine news, opinion, recaps and '
    + 'small moves are not material — they wait for the weekly update. Answer in the JSON schema; cite the article numbers.'

export function triagePrompt(list, articles) {
    return [`THE LIVE QUESTIONS (${list.length}):`,
        ...list.map(({ n, node }) => `${n}. ${node.question} — ${node.options.map(o => `${o.label} ${Math.round(o.p * 100)}%${o.dormant ? ` (dormant: ${o.signpost})` : ''}`).join('; ')}`),
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

/** One tick. Never throws. → what it did. */
export async function tick() {
    if (!config.situationNetwork) return { off: true }
    const now = _io.now(), today = day(now)
    try {
        const head = await _io.latest()
        const db = await _io.db()
        const runs = db.collection(COLLECTIONS.runs)
        const latestOf = (kinds) => runs.find({ complete: true, kind: { $in: kinds } }, { projection: { as_of: 1 } }).sort({ as_of: -1 }).limit(1).next()
        const lastBuild = head ? await latestOf(['build', 'rebuild']) : null
        const lastScheduled = head ? await latestOf(['build', 'rebuild', 'weekly']) : null
        const kind = dueKind(head, lastBuild?.as_of ?? null, today, lastScheduled?.as_of ?? null)
        const w = await db.collection(WATCH).findOne({ _id: 'watch' }) ?? { _id: 'watch', last_at: null, last_event_at: null, seen: [], costs: [], failed: null }
        const save = (set) => db.collection(WATCH).updateOne({ _id: 'watch' }, { $set: set }, { upsert: true })
        const keepCosts = (extra) => [...(w.costs ?? []).filter(c => c.at >= new Date(now.getTime() - 8 * 864e5).toISOString()), ...extra]
        // A scheduled job, run under the busy flag (overrides wait for it), its failure recorded with its cost and backed off.
        const scheduled = async (k, job) => {
            if (backingOff(w.failed, k, now)) return { did: k, waiting: `the last ${k} failed at ${w.failed.at} (${w.failed.reason}); it is tried again a day later` }
            await _io.busy(k)
            let r
            try { r = await job() } finally { await _io.free() }
            if (r.ok) { await save({ failed: null }); await _io.card(r.run_id); await _io.control(r.run_id) }
            else await save({ failed: { kind: k, at: now.toISOString(), reason: String(r.reason ?? 'failed').slice(0, 300) }, costs: keepCosts([{ at: now.toISOString(), usd: r.cost_usd ?? 0, failed: k }]) })
            return { did: k, ...r }
        }
        if (kind === 'build') return scheduled('build', () => _io.build({ asOf: today, kind: 'build' }))
        if (kind === 'rebuild') return scheduled('rebuild', async () => {
            const st = await _io.state(today)
            return st.ok ? _io.update({ kind: 'rebuild', asOf: today, fresh: st }) : { ok: false, reason: st.reason, cost_usd: st.cost_usd ?? 0 }
        })
        if (kind === 'weekly') return scheduled('weekly', () => _io.update({ kind: 'weekly', asOf: today }))
        // The watch.
        if (w.last_at && now - new Date(w.last_at) < WATCH_EVERY_MS) return { did: 'nothing' }
        const raw = [...(await _io.policy(now).catch(() => [])).map(r => toArticle(r, 'Federal Register')), ...(await _io.fmpNews(now).catch(() => [])).map(r => toArticle(r, 'FMP news'))]
        const seen = new Set(w.seen ?? [])
        const fresh = mergeArticles([raw], today, 80).filter(a => !seen.has(a.url ?? a.title))
        const keepSeen = [...seen, ...fresh.map(a => a.url ?? a.title)].slice(-1000)
        if (!fresh.length) { await save({ last_at: now.toISOString(), seen: keepSeen }); return { did: 'watch', articles: 0 } }
        const prev = await _io.read(head.run_id)
        let cost = 0, payer = null
        try { payer = await _io.payer() } catch { /* unbooked */ }
        const res = await _io.call({ model: TRIAGE_MODEL, effort: TRIAGE_EFFORT, systemPrompt: TRIAGE_SYSTEM, user: triagePrompt(numbered(prev.nodes), fresh), schema: triageSchema(),
            onUsage: (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) } })
        await save({ last_at: now.toISOString(), seen: keepSeen, costs: keepCosts([{ at: now.toISOString(), usd: cost }]) })
        w.costs = keepCosts([{ at: now.toISOString(), usd: cost }])
        if (!res?.data?.material) return { did: 'watch', articles: fresh.length, material: false }
        if (w.last_event_at && now - new Date(w.last_event_at) < EVENT_MIN_GAP_MS) return { did: 'watch', material: true, waiting: 'one event update a day' }
        const spent = await spentThisWeek(db, now)
        if (spent >= _io.budget()) return { did: 'watch', material: true, waiting: `the weekly budget ($${_io.budget()}) is spent ($${spent.toFixed(2)})` }
        const trigger = String(res.data.why ?? 'material news').slice(0, 280)
        await _io.busy('event')
        let r
        try { r = await _io.update({ kind: 'event', trigger, asOf: today }) } finally { await _io.free() }
        // The day's one event update is spent whether it saved or not; a failure's cost is counted.
        await save({ last_event_at: now.toISOString(), ...(r.ok ? {} : { costs: keepCosts([{ at: now.toISOString(), usd: r.cost_usd ?? 0, failed: 'event' }]) }) })
        if (r.ok) await _io.card(r.run_id)
        return { did: 'event', trigger, ...r }
    } catch (err) {
        logger.warn(LOG, 'tick failed', { error: err.message })
        return { did: 'error', reason: err.message }
    }
}
