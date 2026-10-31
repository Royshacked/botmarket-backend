// Pythia's WEEK, headless — the change scan, then the assessments it asks for (docs/design/pythia-assessment.md
// §8, build step 6; replaced the weekly industry screen).
//
// When the engine has written a new COMPLETE price run (industry_timing):
//   1. scan every sub-industry and every approved theme against its standing assessment (changeScan — code, no
//      model): flag what moved, what expired, and what was never assessed
//   2. assess the flagged ones, biggest change first, up to the week's cap (PYTHIA_WEEKLY_CAP) and stopping
//      early at the week's spend ceiling (PYTHIA_WEEKLY_MAX_USD); the rest wait for next week's scan, where they
//      are still flagged — queued, never lost
//   3. write the week (`pythia_weekly`, one document per run date): what was flagged and why, what was
//      assessed with its outcome and cost, what waits
//
// A run that dies half-way (a deploy, a crash) is RESUMED by the next tick: the week's document is still
// `running`, and a subject already reassessed carries this run's facts, so the scan no longer flags it.
// Runs are booked to the first admin's token ledger, like "Assess now", so the spend is measured. Never
// throws: the callers are a monitor tick and a fire-and-forget admin route.

import { latestRun, readRun } from '../api/strategy/screenerData.service.js'
import { readAllMoney, readAllFlows } from '../api/strategy/industryData.service.js'
import { readAllGeo } from '../api/strategy/geopoliticsData.service.js'
import { factsFor, industryAssessmentService } from '../api/strategy/industryAssessment.service.js'
import { themeService } from '../api/strategy/theme.service.js'
import { scanIndustry, scanTheme, pickForWeek } from '../api/strategy/changeScan.service.js'
import { assessIndustry, assessTheme } from './industryAssessmentRun.service.js'
import { runHouseScan } from './houseScan.service.js'
import { houseResearchService, RESUME_WEEKS } from './houseResearch.service.js'
import { houseLedgerUserId, listAdminUserIds } from '../api/user/user.model.js'
import { postCard } from './notifyCard.js'
import { getDb } from '../providers/mongodb.provider.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[pythiaWeekly]'
export const COLLECTION = 'pythia_weekly'
/** Weeks of history kept; older weeks are deleted when a week completes. */
export const KEEP_WEEKS = 26
/** The waiting list stored on the week: its length is always kept, the names up to this many. */
export const WAITING_SHOWN = 40

const _deps = {
    latestRun: () => latestRun(),
    readRun: (asof) => readRun(asof),
    readMoney: () => readAllMoney(),
    // Step 8's flows; a failed read scans without them (the price and money legs still run).
    readFlows: () => readAllFlows().catch(err => { logger.warn(LOG, 'flows not read — the scan runs without them', { error: err.message }); return new Map() }),
    readGeo: () => readAllGeo().catch(err => { logger.warn(LOG, 'geopolitics not read — the scan runs without it', { error: err.message }); return () => null }),
    listAssessments: () => industryAssessmentService.listAssessments(),
    listThemes: () => themeService.listThemes({ statuses: ['approved'] }),
    assessIndustry: (code, opts) => assessIndustry(code, opts),
    assessTheme: (id, opts) => assessTheme(id, opts),
    // The FIRST admin by id, so the same ledger every week (user.model houseLedgerUserId).
    bookTo: () => houseLedgerUserId(),
    cap: () => config.pythiaWeeklyCap,
    maxUsd: () => config.pythiaWeeklyMaxUsd,
    // Step 7: the week's FOR SWING / FOR LONG TERM verdicts send names to Prometheus's research queue.
    houseScan: (results, opts) => runHouseScan(results, undefined, opts),
    // ...and Prometheus researches them by himself (house-research-chain.md steps 5-6).
    research: (week) => houseResearchService.researchWeek(week),
    resumeResearch: (weeks) => houseResearchService.resumeWeeks(weeks),
    db: () => getDb(),
    now: () => new Date().toISOString(),
    // The stale-engine card (pythia-two-verdicts.md §3.2): every admin, through the one card transport.
    adminUserIds: () => listAdminUserIds(),
    post: (card, ctx) => postCard(card, ctx),
}
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * The engine's price run is STALE past this many days (pythia-two-verdicts.md §3; 2026-10: it stood at 10-07 for three
 * weeks, the Sunday cron never scheduled, and nothing said so). Weekly, so a week and a day of slack.
 */
export const ENGINE_STALE_DAYS = 8
/** What a DUE pass assesses while the engine is stale (§3.3): what is due by the clock, never what "moved" on old prices. */
export const DUE_KEYS = Object.freeze(['long_term_due', 'expired', 'decider_due'])
/** A due pass skips a subject this week's results already tried within this many days (a refusal is not bought daily). */
export const DUE_RETRY_DAYS = 7

/**
 * How old the latest complete price run is → `{ stale, days, asof }`, or null without one. Pure. Counted from when the
 * run FINISHED, not its price date: a Sunday run prices Friday, so by its price date every Sunday morning before the new
 * run lands reads 9 days and would cry stale weekly (bug hunt 2026-10-31). A run without `finished_at` counts its asof.
 */
export function engineAge(latest, nowIso) {
    if (!latest?.asof) return null
    const finished = new Date(latest.run?.finished_at ?? NaN).getTime()
    const from = Number.isFinite(finished) ? finished : Date.parse(`${latest.asof}T00:00:00Z`)
    const days = Math.floor((Date.parse(nowIso) - from) / 86_400_000)
    return { stale: days > ENGINE_STALE_DAYS, days, asof: latest.asof }
}

/** The stale-engine card for one admin. Pure. */
export function engineStaleCard(age, userId) {
    if (!userId || !age?.stale) return null
    return {
        userId, botId: 'strategy', type: 'pythia_engine_stale',
        content: `Pythia is waiting on the engine — the last industry price run is ${age.asof}, finished ${age.days} days ago. `
            + 'Her weekly reassessments start from a new run (aether-engine\'s Sunday job, engine-weekly); until one comes, '
            + 'only what is due by the clock — long-term reviews, expired assessments — is assessed, on the old prices.',
        payload: { kind: 'pythia_engine', asof: age.asof, days: age.days },
    }
}

/**
 * Is the engine stale? → `{ stale, days, asof, carded }`, or null without a run. The FIRST check that finds a run stale
 * posts one card to every admin — once per stale run, claimed on that run's week document (`stale_card_at`), so a
 * restart or a second process does not post it again. Never throws.
 */
export async function checkEngine(deps = _deps) {
    try {
        const age = engineAge(await deps.latestRun(), deps.now())
        if (!age?.stale) return age
        const db = await deps.db()
        const r = await db.collection(COLLECTION).updateOne({ id: _weekId(age.asof), stale_card_at: { $exists: false } }, { $set: { stale_card_at: deps.now() } })
        // The filter itself requires no card yet, so a match IS the claim.
        if (!(r?.matchedCount > 0)) return { ...age, carded: false }
        logger.warn(LOG, 'the engine is stale — Pythia is waiting on a new price run', { asof: age.asof, days: age.days })
        for (const userId of await deps.adminUserIds()) await deps.post(engineStaleCard(age, userId), { tag: 'Pythia engine-stale card', log: LOG })
        return { ...age, carded: true }
    } catch (err) {
        logger.warn(LOG, 'engine check failed', { error: err.message })
        return null
    }
}

const _weekId = (asof) => `pw_${asof}`

export async function ensurePythiaWeeklyIndexes() {
    const db = await _deps.db()
    await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
    await db.collection(COLLECTION).createIndex({ asof: -1 })
}

/**
 * The scan for one price run → every flag, industries and themes. Today's facts per sub-industry are the
 * run's moves (factsFor) and the latest metrics' money — the same shapes an assessment freezes, so the
 * comparison is like for like.
 */
export async function scanWeek(asof, deps = _deps) {
    const [{ rows, regime }, money, flows, geo, assessments, themes] = await Promise.all([deps.readRun(asof), deps.readMoney(),
        deps.readFlows ? Promise.resolve().then(() => deps.readFlows()).catch(() => new Map()) : new Map(),
        deps.readGeo ? Promise.resolve().then(() => deps.readGeo()).catch(() => () => null) : () => null,
        deps.listAssessments(), deps.listThemes()])
    const at = deps.now()
    const nowByCode = new Map((rows ?? []).map(r => [r.code, { moved: factsFor(r).moved, money: money.get(r.code) ?? null, flows: flows.get(r.code) ?? null, geopolitics: geo(r.code) }]))
    const byCode = new Map(), byTheme = new Map()
    for (const a of assessments ?? []) {
        if (a.subject?.kind === 'theme') byTheme.set(a.subject.id, a)
        else if (a.subject?.code) byCode.set(a.subject.code, a)
    }
    const flags = []
    for (const r of rows ?? []) {
        const f = scanIndustry({ code: r.code, name: r.name, now: nowByCode.get(r.code), assessment: byCode.get(r.code) ?? null, at })
        if (f) flags.push({ ...f, previous_verdict: byCode.get(r.code)?.verdict ?? null })
    }
    for (const t of themes ?? []) {
        if (t.status !== 'approved') continue
        const f = scanTheme({ theme: t, nowByCode, assessment: byTheme.get(t.id) ?? null, at })
        if (f) flags.push({ ...f, previous_verdict: byTheme.get(t.id)?.verdict ?? null })
    }
    return { flags, regime: regime?.regime ?? null, scanned: { industries: rows?.length ?? 0, themes: (themes ?? []).filter(t => t.status === 'approved').length } }
}

/**
 * A published document's long-term call, as the week's result row records it → `{ long_term, long_term_new }`, or {}
 * when this run made no long-term call (the stored one stands). NEW = a yes whose previous call was not. Pure.
 */
export function longTermResult(doc) {
    const lt = doc?.long_term
    if (!lt?.call || lt.reviewed_at !== doc.assessed_at) return {}
    return { long_term: lt.call, long_term_new: lt.call === 'yes' && lt.previous !== 'yes' }
}

const _subject = (f) => (f.kind === 'theme' ? { kind: 'theme', id: f.id, name: f.name } : { kind: 'industry', code: f.code, name: f.name })
const _flagRow = (f) => ({ ..._subject(f), reasons: f.reasons, score: f.score, previous_verdict: f.previous_verdict ?? null })

let _active = false
/** Test seam. */
export function _resetActive() { _active = false }

/**
 * A week marked running whose document has not moved for this long has no run behind it — the process died
 * (a deploy, a crash). One assessment times out at 10 minutes and every result bumps `updated_at`, so a live
 * run never goes this quiet. Read across processes: a run from a script or another instance counts as live.
 */
export const STALE_MS = 30 * 60 * 1000

/**
 * The week's real state → done | paused | running | interrupted (`active`: a week runs in THIS process). Pure.
 * `paused` is a week a limited run stopped on purpose (scripts/run-week.mjs --limit), resumable like an
 * interrupted one. A week this process is running reads `running` whatever is stored — its document says so
 * only after the claim and the scan, and the board asks straight away (code review 2026-10-11).
 */
export function weekStatus(week, { active = false, now = Date.now() } = {}) {
    if (active) return 'running'
    if (!week?.status) return null
    if (week.status !== 'running') return week.status
    const at = Date.parse(week.updated_at ?? week.started_at ?? '')
    return Number.isFinite(at) && now - at < STALE_MS ? 'running' : 'interrupted'
}

/** Outcomes that are the desk's fault, not the infrastructure's: a run that answered without a usable block. */
const REFUSALS = new Set(['refused', 'no_block'])
const _key = (s) => `${s.kind}:${s.code ?? s.id}`

/**
 * Subjects refused in BOTH of the two weeks before this one (`previous`: those weeks, newest first). Held back
 * this week so a subject the desk cannot answer does not take a paid run every week; the week after, the
 * newer of its two weeks has no attempt, so it is tried again — once every third week while it keeps failing.
 * Pure → Set of `kind:code|id`.
 */
export function refusedTwice(previous) {
    if ((previous?.length ?? 0) < 2) return new Set()
    const refusedIn = (w) => new Set((w.results ?? []).filter(r => REFUSALS.has(r.outcome)).map(_key))
    const [a, b] = previous.slice(0, 2).map(refusedIn)
    return new Set([...a].filter(k => b.has(k)))
}

/** The week's flag list after a resume or rerun: the new scan, plus what the earlier pass flagged and no longer does. */
export function mergeFlagged(before, now) {
    const seen = new Set(now.map(_key))
    return [...now, ...(before ?? []).filter(f => !seen.has(_key(f)))]
}

/** A per-run limit: a positive whole number, or none (Infinity). Anything else is refused. Pure. */
export function validLimit(limit) {
    if (limit == null || limit === Infinity) return Infinity
    const n = Number(limit)
    return Number.isInteger(n) && n > 0 ? n : null
}

const _token = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/**
 * CLAIM the week, atomically across processes (code review 2026-10-11: the monitor and a script reading the same
 * week could both run it and pay twice). The write matches only the claim this process read; a second claimant
 * matches nothing, and its upsert hits the unique `id` index. → true when this process owns the week.
 */
async function _claim(coll, { id, asof, week, token, now, by, userId }) {
    try {
        const r = await coll.updateOne({ id, claim: week?.claim ?? null }, {
            // `started_at` is the week's FIRST start: the names its house scan queued are read from it, and a resume or a
            // forced rerun that moved it hid the first finish's names from the research pick-up (code review 2026-10-23).
            // Each claim's own time is `claimed_at`.
            $setOnInsert: { id, asof, created_at: now, results: [], started_at: now },
            $set: { claim: token, status: 'running', claimed_at: now, updated_at: now, by, booked_to: String(userId) },
        }, { upsert: true })
        return (r?.matchedCount ?? 0) + (r?.upsertedCount ?? 0) > 0
    } catch (err) {
        if (err?.code === 11000) return false      // another process inserted the week first
        throw err
    }
}

/**
 * Run the week for the latest complete price run, unless it is done (`force` runs it again: the scan then
 * flags only what is still due). A week left `running` by a dead process, or `paused` by a limited run, is
 * resumed; one still running in another process is left alone. `limit` assesses at most that many this run and
 * PAUSES the week if more wait. The spend ceiling is per WEEK — a resume and a forced rerun both count what the
 * week already spent. → `{ ok, outcome, asof?, assessed?, waiting?, held_back?, cost_usd?, stopped? }`, outcome
 * one of done | paused | exists | week_open (a due pass on a week not yet done) | no_run | already_running | no_ledger |
 * bad_limit | error.
 */
export async function runWeekly({ force = false, dueOnly = false, by = null, limit = Infinity, deps = _deps } = {}) {
    const max = validLimit(limit)
    if (max == null) return { ok: false, outcome: 'bad_limit', detail: `limit must be a positive whole number, not ${limit}` }
    if (_active) return { ok: false, outcome: 'already_running' }
    _active = true
    try {
        const latest = await deps.latestRun()
        if (!latest) return { ok: false, outcome: 'no_run' }
        const { asof } = latest
        // Every spend check reads the ledger of the admin the run is booked to; without one each run reads $0 and the
        // ceiling never fires (code review 2026-10-11) — so no admin, no run.
        const userId = await deps.bookTo()
        if (!userId) return { ok: false, outcome: 'no_ledger', detail: 'no admin to book the run to — the spend ceiling could not be enforced' }
        const db = await deps.db()
        const coll = db.collection(COLLECTION)
        const id = _weekId(asof)
        const week = await coll.findOne({ id })
        // A DUE pass (§3.3) re-opens a done week for what is due by the clock — the monitor's, while the engine is stale.
        if (week?.status === 'done' && !force && !dueOnly) return { ok: true, outcome: 'exists', asof }
        // ...and ONLY a done week: on a week the regular run left failed or paused it would mark the week done with the due
        // subjects alone, and the rest of the week's flags would never be assessed (bug hunt 2026-10-31). The regular run
        // finishes that week first.
        if (dueOnly && week?.status !== 'done') return { ok: true, outcome: 'week_open', asof }
        if (weekStatus(week, { now: Date.parse(deps.now()) }) === 'running') return { ok: false, outcome: 'already_running', asof }
        const started = deps.now()
        if (!await _claim(coll, { id, asof, week, token: _token(), now: started, by, userId })) return { ok: false, outcome: 'already_running', asof }

        const { flags: scanned_flags, scanned, regime } = await scanWeek(asof, deps)
        const previous = await coll.find({ asof: { $ne: asof }, status: 'done' }).sort({ asof: -1 }).limit(2).toArray()
        const hold = refusedTwice(previous)
        const prior = week?.results ?? []
        // A resume does not pay again for what this week already tried: a refused or failed subject is still flagged,
        // and would be bought twice in one week (code review 2026-10-11). A forced rerun tries them again on purpose.
        // A due pass skips only what this week tried RECENTLY: a stalled week can outlive a monthly review.
        const recent = dueOnly ? prior.filter(r => Date.parse(deps.now()) - Date.parse(r.at ?? 0) < DUE_RETRY_DAYS * 86_400_000) : prior
        const tried = force ? new Set() : new Set(recent.map(_key))
        const due = (f) => !dueOnly || f.reasons.some(r => DUE_KEYS.includes(r.key))
        const held = scanned_flags.filter(f => hold.has(_key(f)))
        const flags = scanned_flags.filter(f => due(f) && !hold.has(_key(f)) && !tried.has(_key(f)))
        const capSet = Number(deps.cap())
        const capAll = Number.isNaN(capSet) ? 0 : Math.max(0, capSet)          // Infinity = no count cap
        const cap = Math.max(0, capAll - (force ? 0 : prior.length))
        const spentBefore = prior.reduce((s, r) => s + (r.cost_usd ?? 0), 0)
        const maxUsd = Math.max(0, (Number(deps.maxUsd()) || 0) - spentBefore)
        const { picked, waiting } = pickForWeek(flags, Math.min(cap, max))
        await coll.updateOne({ id }, { $set: {
            scanned, regime, flagged: mergeFlagged(week?.flagged, flags.map(_flagRow)), held_back: held.map(_flagRow),
            cap: Number.isFinite(capAll) ? capAll : null, max_usd: Number(deps.maxUsd()) || 0, updated_at: deps.now(),
        } })
        logger.info(LOG, dueOnly ? 'due pass started' : 'week started', { asof, flagged: flags.length, picked: picked.length, waiting: waiting.length, held_back: held.length, resumed: Boolean(week && !force) })

        let spent = 0, stopped = null
        const results = []
        for (const f of picked) {
            if (spent >= maxUsd) { stopped = 'budget'; break }
            const opts = { userId, source: 'weekly', trigger: f.reasons }
            const r = f.kind === 'theme' ? await deps.assessTheme(f.id, opts) : await deps.assessIndustry(f.code, opts)
            const cost = Number(r?.cost_usd) || 0
            spent += cost
            const row = { ..._subject(f), reasons: f.reasons.map(x => x.key), outcome: r?.outcome ?? 'error',
                verdict: r?.doc?.verdict ?? null, previous_verdict: f.previous_verdict ?? null,
                // The long-term call this run made, and whether it is a NEW yes — what sends names to the long-term book.
                ...longTermResult(r?.doc),
                cost_usd: cost, detail: r?.ok ? null : String(r?.detail ?? '').slice(0, 300) || null, at: deps.now() }
            results.push(row)
            await coll.updateOne({ id }, { $push: { results: row }, $set: { updated_at: row.at } })
        }
        const unrun = stopped ? picked.slice(results.length) : []
        const left = [...unrun, ...waiting]
        // Paused, not done, when the run's own limit is what left subjects waiting — the next run resumes it.
        const paused = !stopped && max < cap && waiting.length > 0
        const finished = deps.now()
        await coll.updateOne({ id }, { $set: {
            status: paused ? 'paused' : 'done', finished_at: finished, updated_at: finished, stopped,
            waiting_count: left.length, waiting: left.slice(0, WAITING_SHOWN).map(_flagRow),
            cost_usd: spentBefore + spent,
        } })
        if (!paused && (!dueOnly || results.length)) {
            // The hand-off (step 7): the whole week's results, a resumed week's earlier chunks included — a due pass hands
            // on only its own (the week's earlier ones were handed on when it finished). Never fatal — the week is done
            // whether or not the queue took its names.
            const before = week?.house_scan?.queued ?? []
            const house = await Promise.resolve(deps.houseScan?.(dueOnly ? results : [...prior, ...results], { alreadyQueued: before.length, bookTo: userId })).catch(err => ({ error: err.message }))
            if (house) {
                const house_scan = { queued: [...before, ...(house.queued ?? [])], considered: house.considered ?? 0, skipped_full: house.skipped_full ?? 0,
                    // Argus's lists — what he saw, chose and passed (house-research-chain.md step 4) — and their spend.
                    picks: [...(week?.house_scan?.picks ?? []), ...(house.picks ?? [])],
                    cost_usd: (Number(week?.house_scan?.cost_usd) || 0) + (Number(house.cost_usd) || 0),
                    ...(house.error ? { error: house.error } : {}) }
                await coll.updateOne({ id }, { $set: { house_scan } })
                // Filter 2 starts by itself (step 5); a run already going leaves it to the monitor's next tick.
                await Promise.resolve(deps.research?.({ ...(week ?? {}), id, asof, started_at: week?.started_at ?? started, house_scan })).catch(() => null)
            }
            await _prune(coll)
        }
        const published = results.filter(r => r.outcome === 'published').length
        logger.info(LOG, paused ? 'week paused' : 'week done', { asof, assessed: results.length, published, waiting: left.length, held_back: held.length, cost_usd: Number(spent.toFixed(4)), stopped })
        return { ok: true, outcome: paused ? 'paused' : 'done', asof, assessed: results.length, published, waiting: left.length, held_back: held.length, cost_usd: spent, stopped }
    } catch (err) {
        logger.warn(LOG, 'week failed', { error: err.message })
        return { ok: false, outcome: 'error', detail: err.message }
    } finally {
        _active = false
    }
}

async function _prune(coll) {
    const old = await coll.find({}, { projection: { id: 1, asof: 1 } }).sort({ asof: -1 }).skip(KEEP_WEEKS).toArray()
    if (old.length) await coll.deleteMany({ id: { $in: old.map(o => o.id) } })
}

/** Is a week running in this process? */
export function weeklyRunning() { return _active }

/** The latest week's document with its real state (`status`: done | paused | running | interrupted), or null. */
export async function latestWeek(deps = _deps) {
    const db = await deps.db()
    const week = await db.collection(COLLECTION).find({}, { projection: { _id: 0, claim: 0 } }).sort({ asof: -1 }).limit(1).next()
    return week ? { ...week, status: weekStatus(week, { active: _active, now: Date.parse(deps.now()) }) } : null
}

/**
 * The monitor's pick-up of the recent DONE weeks' research (house-research-chain.md step 6): their dead claims back
 * in line, and a run over what still waits — a name left by one week is not orphaned when the next finishes. Never
 * throws.
 */
export async function resumeResearch(deps = _deps) {
    try {
        const db = await deps.db()
        const weeks = await db.collection(COLLECTION).find({ status: 'done' }, { projection: { _id: 0, asof: 1, started_at: 1, house_scan: 1 } })
            .sort({ asof: -1 }).limit(RESUME_WEEKS).toArray()
        if (!weeks.some(w => w.house_scan?.queued?.length)) return { ok: true, outcome: 'no_names' }
        return await deps.resumeResearch(weeks)
    } catch (err) {
        logger.warn(LOG, 'research pick-up failed', { error: err.message })
        return { ok: false, outcome: 'error', detail: err.message }
    }
}

export const pythiaWeeklyService = { runWeekly, latestWeek, scanWeek, weeklyRunning, resumeResearch }
