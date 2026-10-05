// The house's answer on each GICS sub-industry — Pythia's artifact (docs/design/pythia-industry-questions.md).
//
// One document per sub-industry in `industry_view`, owned by the house (no userId — like coverage, a
// house view is a broadcast). It holds Pythia's answer to the three structural questions, each a grade
// with its reasoning; where Pythia's grade differs from the code's first read in industry_metrics, the
// reason it differs; the conditions that would reopen it early; and when it is next due.
//
// A DESCRIPTION, NOT A FORECAST (horizons.md §1): nothing here says a price will rise, and no weight is
// published. The answers count toward returns only paired with price, and only once that pairing passes
// the backtest.
//
// Writes go through the house artifact repo, so every change appends a revision and the trail shows how
// the house's view of an industry moved.

import { getDb } from '../../providers/mongodb.provider.js'
import { makeHouseArtifactRepo } from '../../services/houseArtifact.repo.js'
import { newRevision, diffFields } from '../../services/revisionTrail.js'
import { addMonths } from '../../services/forecastClock.js'
import { logger } from '../../services/logger.service.js'
import { readCompaniesBySymbol } from './industryData.service.js'

const LOG = '[industryView]'
export const COLLECTION = 'industry_view'

/** The grades each question may take — the same vocabulary as the engine's first read. */
export const GRADES = Object.freeze({
    demand:    ['growing', 'in_line', 'shrinking'],
    economics: ['good', 'average', 'poor'],
    cycle:     ['peak', 'mid', 'trough', 'stable'],
})
export const QUESTIONS = Object.freeze(Object.keys(GRADES))
/** The engine's metric block for each question. */
const METRIC_KEY = { demand: 'q1', economics: 'q2', cycle: 'q3' }

/** Review cadence (design doc §6): yearly; quarterly for a cyclical industry, whose cycle answer moves. */
export const REVIEW_MONTHS = { default: 12, cyclical: 3 }
export const STATUSES = ['pending', 'answered']

const _repo = makeHouseArtifactRepo({ collection: COLLECTION })
const _io = { db: () => getDb() }
/** Test seam. */
export function _setViewIO(io) { Object.assign(_io, io) }

const _str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * A draft (from the desk's <industry_view> block) checked against the engine's numbers → `{ ok, view }`
 * or `{ ok:false, reason, detail }`. Pure.
 *
 *   • every question needs a grade from its vocabulary and a rationale — a grade without a reason is
 *     an assertion, and the reason is what the next review argues with
 *   • a grade that DIFFERS from the code's first read needs `override_reason` on that question: the
 *     numbers are measured, so departing from them is allowed but has to be argued, and the argument
 *     is stored beside the grade
 */
export function checkDraft(draft, metricsNode) {
    if (!draft || typeof draft !== 'object') return { ok: false, reason: 'bad_draft', detail: 'no view' }
    const out = {}
    const problems = []
    for (const q of QUESTIONS) {
        const a = draft[q] ?? {}
        const grade = _str(a.grade)
        const rationale = _str(a.rationale)
        if (!grade || !GRADES[q].includes(grade)) { problems.push(`${q}: grade must be one of ${GRADES[q].join('/')}`); continue }
        if (!rationale) { problems.push(`${q}: rationale is missing`); continue }
        const codeGrade = metricsNode?.[METRIC_KEY[q]]?.grade ?? null
        const override = codeGrade && codeGrade !== grade ? _str(a.override_reason) : null
        if (codeGrade && codeGrade !== grade && !override) {
            problems.push(`${q}: grade "${grade}" differs from the measured "${codeGrade}" — give override_reason`)
            continue
        }
        out[q] = { grade, rationale, code_grade: codeGrade, ...(override ? { override_reason: override } : {}) }
    }
    if (problems.length) return { ok: false, reason: 'bad_draft', detail: problems.join('; ') }
    const reopen = (Array.isArray(draft.reopen_if) ? draft.reopen_if : []).map(_str).filter(Boolean).slice(0, 8)
    return { ok: true, view: { ...out, reopen_if: reopen, summary: _str(draft.summary) } }
}

/** When this view is next due, from the moment it was answered. Pure. */
export function nextReviewAt(answeredAt, cyclical) {
    return addMonths(answeredAt, cyclical ? REVIEW_MONTHS.cyclical : REVIEW_MONTHS.default)
}

/** The skeleton of a sub-industry not yet answered — due immediately. Pure. */
export function pendingDoc(sub, now = new Date().toISOString()) {
    return {
        id: `iv_${sub.code}`, code: sub.code, name: sub.name, sector: sub.sector,
        industry_group: sub.industry_group, industry: sub.industry, answered_at: sub.answered_at ?? null,
        demand: null, economics: null, cycle: null, reopen_if: [], summary: null,
        metrics_asof: null, cyclical: null, status: 'pending', revisions: [],
        monitor: { next_check_at: now, last_checked: null, checks: 0, last_triggers: [] },
        created_at: now, updated_at: now,
    }
}

async function _ensureIndexes(db) {
    await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
    await db.collection(COLLECTION).createIndex({ code: 1 }, { unique: true })
    await db.collection(COLLECTION).createIndex({ 'monitor.next_check_at': 1 })
}

/**
 * Make sure every sub-industry the engine measured has a document — the unanswered ones as `pending`,
 * due now. Returns the number created. Idempotent: an existing view is never touched.
 */
async function seedMissing(subs) {
    const db = await _io.db()
    await _ensureIndexes(db)
    const have = new Set((await db.collection(COLLECTION).find({}, { projection: { code: 1 } }).toArray()).map(d => d.code))
    const fresh = (subs ?? []).filter(s => s?.code && !have.has(s.code)).map(s => pendingDoc(s))
    if (fresh.length) await db.collection(COLLECTION).insertMany(fresh, { ordered: false })
    if (fresh.length) logger.info(LOG, 'seeded pending views', { count: fresh.length })
    return fresh.length
}

/**
 * Publish an answer for one sub-industry: checked against the engine's numbers, written with a revision.
 * `metricsNode` is the node that answers it (industryData.readSubIndustry().answering).
 */
async function publishView(code, draft, metricsNode, { note = null, now = new Date().toISOString() } = {}) {
    const checked = checkDraft(draft, metricsNode)
    if (!checked.ok) return checked
    const db = await _io.db()
    await _ensureIndexes(db)
    const cur = await db.collection(COLLECTION).findOne({ code })
    if (!cur) return { ok: false, reason: 'not_found', detail: `no view for ${code} — seed first` }
    const cyclical = Boolean(metricsNode?.q3?.cyclical)
    const set = {
        ...checked.view, status: 'answered', cyclical, metrics_asof: metricsNode?.asof ?? null,
        updated_at: now,
        'monitor.next_check_at': nextReviewAt(now, cyclical),
        'monitor.last_checked': now,
        'monitor.last_triggers': metricsNode?.triggers ?? [],
    }
    const changed = diffFields(
        Object.fromEntries(QUESTIONS.map(q => [q, cur[q]?.grade ?? null])),
        Object.fromEntries(QUESTIONS.map(q => [q, checked.view[q].grade])),
        QUESTIONS)
    const revision = newRevision({ kind: cur.status === 'pending' ? 'answer' : 'review', note: note ?? checked.view.summary, changed, at: now })
    await _repo.revise(cur.id, set, revision)
    const doc = await db.collection(COLLECTION).findOne({ code })
    return { ok: true, doc, changed }
}

/** Record a review that changed nothing — the reason goes on the trail; the clock restarts. */
async function recordPass(code, reason, cyclical, { now = new Date().toISOString() } = {}) {
    const db = await _io.db()
    const cur = await db.collection(COLLECTION).findOne({ code })
    if (!cur) return { ok: false, reason: 'not_found' }
    await _repo.revise(cur.id, {
        updated_at: now, 'monitor.next_check_at': nextReviewAt(now, cyclical), 'monitor.last_checked': now,
    }, newRevision({ kind: 'review_pass', note: reason, at: now }))
    return { ok: true }
}

async function getView(code) {
    const db = await _io.db()
    return db.collection(COLLECTION).findOne({ code }, { projection: { _id: 0 } })
}

async function listViews() {
    const db = await _io.db()
    return db.collection(COLLECTION).find({}, { projection: { _id: 0, revisions: 0 } }).sort({ sector: 1, name: 1 }).toArray()
}

/** Pull a view's next review forward to now — an early-review trigger fired. */
async function markDue(code, triggers, { now = new Date().toISOString() } = {}) {
    const db = await _io.db()
    const cur = await db.collection(COLLECTION).findOne({ code })
    if (!cur) return { ok: false, reason: 'not_found' }
    await _repo.recordMonitorState(cur.id, { set: { 'monitor.next_check_at': now, 'monitor.last_triggers': triggers, 'monitor.early_reason': triggers.join(', ') } })
    return { ok: true }
}

function recordMonitorState(id, opts) { return _repo.recordMonitorState(id, opts) }

/**
 * The house answer for the industry each symbol is in → `{ SYMBOL: { code, name, sector, status,
 * demand, economics, cycle, summary } }`, grades null while the industry is unanswered. A symbol the
 * engine never classified is absent. The one join every reader of "what does the house think of the
 * industry this name is in" goes through — Atlas's review, its snapshot, and the read tool.
 */
async function viewsForSymbols(symbols, deps = { companies: readCompaniesBySymbol }) {
    const companies = await deps.companies(symbols)
    const codes = [...new Set(Object.values(companies).map(c => c.sub_code).filter(Boolean))]
    if (!codes.length) return {}
    const db = await _io.db()
    const views = new Map((await db.collection(COLLECTION).find({ code: { $in: codes } },
        { projection: { _id: 0, revisions: 0, monitor: 0 } }).toArray()).map(v => [v.code, v]))
    const out = {}
    for (const [sym, c] of Object.entries(companies)) {
        const v = views.get(c.sub_code)
        out[sym] = {
            code: c.sub_code, name: c.sub_industry, sector: c.sector, status: v?.status ?? 'pending',
            demand: v?.demand?.grade ?? null, economics: v?.economics?.grade ?? null, cycle: v?.cycle?.grade ?? null,
            summary: v?.summary ?? null,
        }
    }
    return out
}

export const industryViewService = { seedMissing, publishView, recordPass, getView, listViews, markDue, recordMonitorState, viewsForSymbols }
