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
import { readAllMoney } from '../api/strategy/industryData.service.js'
import { factsFor, industryAssessmentService } from '../api/strategy/industryAssessment.service.js'
import { themeService } from '../api/strategy/theme.service.js'
import { scanIndustry, scanTheme, pickForWeek } from '../api/strategy/changeScan.service.js'
import { assessIndustry, assessTheme } from './industryAssessmentRun.service.js'
import { listAdminUserIds } from '../api/user/user.model.js'
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
    listAssessments: () => industryAssessmentService.listAssessments(),
    listThemes: () => themeService.listThemes({ statuses: ['approved'] }),
    assessIndustry: (code, opts) => assessIndustry(code, opts),
    assessTheme: (id, opts) => assessTheme(id, opts),
    bookTo: async () => (await listAdminUserIds())?.[0] ?? null,
    cap: () => config.pythiaWeeklyCap,
    maxUsd: () => config.pythiaWeeklyMaxUsd,
    db: () => getDb(),
    now: () => new Date().toISOString(),
}
export function _setDeps(d) { Object.assign(_deps, d) }

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
    const [{ rows, regime }, money, assessments, themes] = await Promise.all([deps.readRun(asof), deps.readMoney(), deps.listAssessments(), deps.listThemes()])
    const at = deps.now()
    const nowByCode = new Map((rows ?? []).map(r => [r.code, { moved: factsFor(r).moved, money: money.get(r.code) ?? null }]))
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

const _subject = (f) => (f.kind === 'theme' ? { kind: 'theme', id: f.id, name: f.name } : { kind: 'industry', code: f.code, name: f.name })
const _flagRow = (f) => ({ ..._subject(f), reasons: f.reasons, score: f.score, previous_verdict: f.previous_verdict ?? null })

let _active = false
/** Test seam. */
export function _resetActive() { _active = false }

/**
 * Run the week for the latest complete price run, unless it is done (`force` runs it again: the scan then
 * flags only what is still due). → `{ ok, outcome, asof?, assessed?, waiting?, cost_usd?, stopped? }`, outcome
 * one of done | exists | no_run | already_running | error.
 */
export async function runWeekly({ force = false, by = null, deps = _deps } = {}) {
    if (_active) return { ok: false, outcome: 'already_running' }
    _active = true
    try {
        const latest = await deps.latestRun()
        if (!latest) return { ok: false, outcome: 'no_run' }
        const { asof } = latest
        const db = await deps.db()
        const coll = db.collection(COLLECTION)
        const id = _weekId(asof)
        const week = await coll.findOne({ id })
        if (week?.status === 'done' && !force) return { ok: true, outcome: 'exists', asof }

        const { flags, scanned, regime } = await scanWeek(asof, deps)
        // A resumed week has already spent part of its cap; a forced rerun gets a fresh one.
        const prior = force ? [] : (week?.results ?? [])
        const cap = Math.max(0, (Number(deps.cap()) || 0) - prior.length)
        const maxUsd = Math.max(0, (Number(deps.maxUsd()) || 0) - prior.reduce((s, r) => s + (r.cost_usd ?? 0), 0))
        const { picked, waiting } = pickForWeek(flags, cap)
        const userId = await deps.bookTo()
        const started = deps.now()
        await coll.updateOne({ id }, {
            $setOnInsert: { id, asof, created_at: started, results: [] },
            $set: { status: 'running', started_at: started, by, scanned, regime, flagged: flags.map(_flagRow), cap: Number(deps.cap()) || 0,
                    max_usd: Number(deps.maxUsd()) || 0, booked_to: userId ? String(userId) : null, updated_at: started },
        }, { upsert: true })
        logger.info(LOG, 'week started', { asof, flagged: flags.length, picked: picked.length, waiting: waiting.length, resumed: Boolean(week && !force) })

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
                cost_usd: cost, detail: r?.ok ? null : String(r?.detail ?? '').slice(0, 300) || null, at: deps.now() }
            results.push(row)
            await coll.updateOne({ id }, { $push: { results: row }, $set: { updated_at: row.at } })
        }
        const unrun = stopped ? picked.slice(results.length) : []
        const left = [...unrun, ...waiting]
        const finished = deps.now()
        const all = [...(force ? (week?.results ?? []) : prior), ...results]
        await coll.updateOne({ id }, { $set: {
            status: 'done', finished_at: finished, updated_at: finished, stopped,
            waiting_count: left.length, waiting: left.slice(0, WAITING_SHOWN).map(_flagRow),
            cost_usd: all.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
        } })
        await _prune(coll)
        const published = results.filter(r => r.outcome === 'published').length
        logger.info(LOG, 'week done', { asof, assessed: results.length, published, waiting: left.length, cost_usd: Number(spent.toFixed(4)), stopped })
        return { ok: true, outcome: 'done', asof, assessed: results.length, published, waiting: left.length, cost_usd: spent, stopped }
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

/** Is a week running in this process? (The board's admin button.) */
export function weeklyRunning() { return _active }

/** The latest week's document, or null. */
export async function latestWeek(deps = _deps) {
    const db = await deps.db()
    return db.collection(COLLECTION).find({}, { projection: { _id: 0 } }).sort({ asof: -1 }).limit(1).next()
}

export const pythiaWeeklyService = { runWeekly, latestWeek, scanWeek, weeklyRunning }
