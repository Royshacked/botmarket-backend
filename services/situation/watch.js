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
import { latestRun, readRun, COLLECTIONS } from './store.js'
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
    // The control, once per scheduled run, over the industries the network scored (the same universe).
    control: async (run_id) => { const run = await readRun(run_id); return run?.state ? runControl(run.state, (run.industries ?? []).map(i => ({ code: i.code, name: i.name, level: i.level })), run.run.as_of) : null },
    budget: () => config.situationWeeklyUsd,
}
export function _setIO(io) { Object.assign(_io, io) }

const day = (d) => d.toISOString().slice(0, 10)
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5)

/** What is due → 'build' | 'rebuild' | 'weekly' | 'watch'. Pure. */
export function dueKind(head, lastBuildAsOf, today) {
    if (!head) return 'build'
    if (lastBuildAsOf && daysBetween(lastBuildAsOf, today) >= REBUILD_DAYS) return 'rebuild'
    if (daysBetween(head.as_of, today) >= WEEKLY_DAYS) return 'weekly'
    return 'watch'
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

/** The LLM spend of the runs in the last seven days (from their stats) plus the watcher's own. */
async function spentThisWeek(db, now) {
    const since = new Date(now.getTime() - 7 * 864e5).toISOString()
    const runs = await db.collection(COLLECTIONS.runs).find({ complete: true, finished_at: { $gte: since } }, { projection: { 'stats.cost_usd': 1 } }).toArray()
    const w = await db.collection(WATCH).findOne({ _id: 'watch' })
    const triage = (w?.costs ?? []).filter(c => c.at >= since).reduce((s, c) => s + c.usd, 0)
    return runs.reduce((s, r) => s + (r.stats?.cost_usd ?? 0), 0) + triage
}

/** One tick. Never throws. → what it did. */
export async function tick() {
    if (!config.situationNetwork) return { off: true }
    const now = _io.now(), today = day(now)
    try {
        const head = await _io.latest()
        const db = await _io.db()
        const lastBuild = head ? await db.collection(COLLECTIONS.runs).find({ complete: true, kind: { $in: ['build', 'rebuild'] } }, { projection: { as_of: 1 } }).sort({ as_of: -1 }).limit(1).next() : null
        const kind = dueKind(head, lastBuild?.as_of ?? null, today)
        if (kind === 'build') {
            const r = await _io.build({ asOf: today, kind: 'build' })
            if (r.ok) { await _io.card(r.run_id); await _io.control(r.run_id) }
            return { did: 'build', ...r }
        }
        if (kind === 'rebuild') {
            const st = await _io.state(today)
            if (!st.ok) return { did: 'rebuild', ok: false, reason: st.reason }
            const r = await _io.update({ kind: 'rebuild', asOf: today, fresh: st })
            if (r.ok) { await _io.card(r.run_id); await _io.control(r.run_id) }
            return { did: 'rebuild', ...r }
        }
        if (kind === 'weekly') {
            const r = await _io.update({ kind: 'weekly', asOf: today })
            if (r.ok) { await _io.card(r.run_id); await _io.control(r.run_id) }
            return { did: 'weekly', ...r }
        }
        // The watch.
        const w = await db.collection(WATCH).findOne({ _id: 'watch' }) ?? { _id: 'watch', last_at: null, last_event_at: null, seen: [], costs: [] }
        if (w.last_at && now - new Date(w.last_at) < WATCH_EVERY_MS) return { did: 'nothing' }
        const raw = [...(await _io.policy(now).catch(() => [])).map(r => toArticle(r, 'Federal Register')), ...(await _io.fmpNews(now).catch(() => [])).map(r => toArticle(r, 'FMP news'))]
        const seen = new Set(w.seen ?? [])
        const fresh = mergeArticles([raw], today, 80).filter(a => !seen.has(a.url ?? a.title))
        const save = (set) => db.collection(WATCH).updateOne({ _id: 'watch' }, { $set: set }, { upsert: true })
        const keepSeen = [...seen, ...fresh.map(a => a.url ?? a.title)].slice(-1000)
        if (!fresh.length) { await save({ last_at: now.toISOString(), seen: keepSeen }); return { did: 'watch', articles: 0 } }
        const prev = await _io.read(head.run_id)
        let cost = 0, payer = null
        try { payer = await _io.payer() } catch { /* unbooked */ }
        const res = await _io.call({ model: TRIAGE_MODEL, effort: TRIAGE_EFFORT, systemPrompt: TRIAGE_SYSTEM, user: triagePrompt(numbered(prev.nodes), fresh), schema: triageSchema(),
            onUsage: (usage, m) => { cost += calcCost(m, usage); if (payer) _io.record(payer, m, usage).catch(() => {}) } })
        const costs = [...(w.costs ?? []).filter(c => c.at >= new Date(now.getTime() - 8 * 864e5).toISOString()), { at: now.toISOString(), usd: cost }]
        await save({ last_at: now.toISOString(), seen: keepSeen, costs })
        if (!res?.data?.material) return { did: 'watch', articles: fresh.length, material: false }
        if (w.last_event_at && now - new Date(w.last_event_at) < EVENT_MIN_GAP_MS) return { did: 'watch', material: true, waiting: 'one event update a day' }
        const spent = await spentThisWeek(db, now)
        if (spent >= _io.budget()) return { did: 'watch', material: true, waiting: `the weekly budget ($${_io.budget()}) is spent ($${spent.toFixed(2)})` }
        const trigger = String(res.data.why ?? 'material news').slice(0, 280)
        const r = await _io.update({ kind: 'event', trigger, asOf: today })
        await save({ last_event_at: now.toISOString() })
        if (r.ok) await _io.card(r.run_id)
        return { did: 'event', trigger, ...r }
    } catch (err) {
        logger.warn(LOG, 'tick failed', { error: err.message })
        return { did: 'error', reason: err.message }
    }
}
