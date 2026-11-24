// THE FORWARD TEST'S SCORECARD (docs/design/situation-network.md §9, §11.5; plan step 11). Declared before the start;
// nothing here is tuned to results.
//
// NODES: every graded forecast (store.gradeForecasts) → the Brier score against EQUAL ODDS (1/k for a k-option node),
// calibration per 20-point bucket, by group: the model's numbers Roy let stand, the model's numbers he overrode, his
// overrides. A question counts once however many times its numbers were logged.
// INDUSTRIES: at each run, "long" = chance it wins ≥ 60%, "short" = chance it loses ≥ 60%; long minus short, each
// against the equal-weight average of every industry_index basket, at 63 and 126 trading days (3 and 6 months).
// CONTROL: the same model asked weekly, with no network, which industries win over six months (control.js), scored the
// same way.
// PASS when ALL hold: (1) Brier better than equal odds on ≥ 100 resolved questions; (2) calibration within 10 points in
// every bucket with ≥ 15; (3) industry long − short positive at 6 months with t ≥ 2; (4) the same sign in both halves;
// (5) 12 months since the start at least. The control is reported beside it.

import { getDb } from '../../providers/mongodb.provider.js'
import { getEngineDb } from '../engineDb.js'
import { COLLECTIONS } from './store.js'

export const CALL_AT = 0.6
export const HORIZONS = Object.freeze({ m3: 63, m6: 126 })
export const BUCKET_EDGES = Object.freeze([0, 0.2, 0.4, 0.6, 0.8, 1.0001])
export const PASS = Object.freeze({ minQuestions: 100, calibrationPts: 0.10, minPerBucket: 15, tMin: 2, minMonths: 12 })
export const CONTROL = 'situation_control'

const _io = { db: () => getDb(), engineDb: () => getEngineDb(), now: () => new Date() }
export function _setIO(io) { Object.assign(_io, io); _index = null }

/** 63 trading days is about 90 calendar days: before that no call has a 3-month result. */
export const MIN_DAYS_TO_GRADE = 88
export const INDEX_TTL_MS = 6 * 60 * 60 * 1000
let _index = null   // { at, lines }
async function _indexLines(edb) {
    if (_index && Date.now() - _index.at < INDEX_TTL_MS) return _index.lines
    const lines = await edb.collection('industry_index').find({}, { projection: { dates: 1, levels: 1 } }).toArray()
    _index = { at: Date.now(), lines }
    return lines
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const tstat = (xs) => {
    if (xs.length < 3) return null
    const m = mean(xs), sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
    return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : null
}

/**
 * Graded forecast rows → Brier vs equal odds, calibration and the question count, per group. A row: `{ run_id, node_id,
 * option, p, set_by, llm_p, outcome }`. Pure.
 */
export function nodeScores(rows) {
    const graded = rows.filter(r => r.outcome === 0 || r.outcome === 1)
    const k = new Map()
    for (const r of graded) { const key = `${r.run_id}|${r.node_id}`; k.set(key, (k.get(key) ?? 0) + 1) }
    const groups = {
        accepted: graded.filter(r => r.set_by === 'llm').map(r => ({ ...r, use: r.p })),
        overridden: graded.filter(r => r.set_by === 'roy' && typeof r.llm_p === 'number').map(r => ({ ...r, use: r.llm_p })),
        roy: graded.filter(r => r.set_by === 'roy').map(r => ({ ...r, use: r.p })),
    }
    const score = (xs) => {
        if (!xs.length) return { questions: 0, rows: 0, brier: null, equal_odds: null, calibration: [] }
        const brier = mean(xs.map(r => (r.use - r.outcome) ** 2))
        const eq = mean(xs.map(r => (1 / (k.get(`${r.run_id}|${r.node_id}`) ?? 2) - r.outcome) ** 2))
        const calibration = []
        for (let i = 0; i < BUCKET_EDGES.length - 1; i++) {
            const lo = BUCKET_EDGES[i], hi = BUCKET_EDGES[i + 1]
            const b = xs.filter(r => r.use >= lo && r.use < hi)
            calibration.push({ from: lo, to: Math.min(1, hi), n: b.length, said: mean(b.map(r => r.use)), happened: mean(b.map(r => r.outcome)) })
        }
        return { questions: new Set(xs.map(r => r.node_id)).size, rows: xs.length, brier, equal_odds: eq, calibration }
    }
    return { accepted: score(groups.accepted), overridden: score(groups.overridden), roy: score(groups.roy), all: score(graded.map(r => ({ ...r, use: r.p }))) }
}

/**
 * Each scored date's long-minus-short against the equal-weight average of all baskets, `h` bars on. `calls` is
 * `[{ as_of, long: [basket], short: [basket] }]`; `index` the industry_index docs. A date without `h` bars after it is
 * skipped. → `[{ as_of, spread }]`. Pure.
 */
export function spreads(calls, index, h) {
    const out = []
    for (const c of calls) {
        if (!c.long.length || !c.short.length) continue
        const rets = new Map()
        for (const d of index) {
            const i = (d.dates ?? []).findIndex(x => x > c.as_of)
            if (i < 1 || i - 1 + h >= d.dates.length) continue
            rets.set(d._id, d.levels[i - 1 + h] / d.levels[i - 1] - 1)
        }
        if (rets.size < 10) continue
        const avg = mean([...rets.values()])
        const leg = (xs) => mean(xs.map(b => rets.get(b)).filter(v => typeof v === 'number'))
        const L = leg(c.long), S = leg(c.short)
        if (L == null || S == null) continue
        out.push({ as_of: c.as_of, spread: (L - avg) - (S - avg) })
    }
    return out
}

/** A list of spreads → its mean, t and the two halves' signs. Pure. */
export function spreadSummary(xs) {
    const v = xs.map(x => x.spread)
    const half = Math.floor(v.length / 2)
    return { n: v.length, mean: mean(v), t: tstat(v), first_half: mean(v.slice(0, half)), second_half: mean(v.slice(half)) }
}

/** The ISO week (Monday-based) of a date, `YYYY-Www`. Pure. */
export function isoWeek(iso) {
    const d = new Date(`${iso}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3)
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
    const w = 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)
    return `${d.getUTCFullYear()}-W${String(w).padStart(2, '0')}`
}

/** The last item of each ISO week (items oldest first, each with `as_of`). Pure. */
export function onePerWeek(items) {
    const m = new Map()
    for (const x of items) m.set(isoWeek(x.as_of), x)
    return [...m.values()]
}

/** Graded rows → `{ questions, of }`: how many resolved questions were won by an option a forecast lacked. Pure. */
export function unforeseenCount(rows) {
    return { questions: new Set(rows.filter(r => r.absent).map(r => r.node_id)).size, of: new Set(rows.map(r => r.node_id)).size }
}

export const SCORED_KINDS = Object.freeze(['build', 'rebuild', 'weekly', 'sectors'])
/** The runs the industry test scores: per ISO week, the latest scheduled run (runs oldest first). Pure. */
export function scoredRuns(runs) {
    return onePerWeek(runs.filter(r => SCORED_KINDS.includes(r.kind)))
}

/** The declared pass rule on the numbers. Pure. */
export function verdict(nodes, m6, startedOn, today) {
    const months = startedOn ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startedOn}T00:00:00Z`)) / (30.44 * 864e5) : 0
    const a = nodes.all
    const checks = {
        '1_brier_beats_equal_odds': a.questions >= PASS.minQuestions && a.brier != null && a.brier < a.equal_odds,
        '2_calibrated': a.calibration.filter(b => b.n >= PASS.minPerBucket).every(b => Math.abs(b.said - b.happened) <= PASS.calibrationPts) && a.calibration.some(b => b.n >= PASS.minPerBucket),
        '3_long_short_positive_t2': m6.n > 0 && m6.mean > 0 && (m6.t ?? 0) >= PASS.tMin,
        '4_same_sign_both_halves': m6.first_half != null && m6.second_half != null && m6.first_half > 0 && m6.second_half > 0,
        '5_twelve_months': months >= PASS.minMonths,
    }
    return { checks, pass: Object.values(checks).every(Boolean), months: Math.round(months * 10) / 10, questions: a.questions }
}

/** The whole scorecard, read from the database. */
export async function buildScorecard() {
    const db = await _io.db(), edb = await _io.engineDb()
    const today = _io.now().toISOString().slice(0, 10)
    const P = { projection: { _id: 0 } }
    const [forecasts, runs, control] = await Promise.all([
        db.collection(COLLECTIONS.forecasts).find({ outcome: { $in: [0, 1] } }, P).toArray(),
        db.collection(COLLECTIONS.runs).find({ complete: true }, P).sort({ as_of: 1, finished_at: 1 }).toArray(),
        db.collection(CONTROL).find({}, P).sort({ as_of: 1 }).toArray(),
    ])
    // The basket lines are ~3 MB (28 s over the M0 link, the 2026-11-23 drive): read only once a call is old enough to
    // grade (3 months), and kept for INDEX_TTL_MS.
    const oldest = [runs[0]?.as_of, control[0]?.as_of].filter(Boolean).sort()[0] ?? null
    const gradable = oldest && (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 864e5 >= MIN_DAYS_TO_GRADE
    const index = gradable ? await _indexLines(edb) : []
    // ONE scored run per ISO week: its latest SCHEDULED run (build, rebuild, weekly) — never an event update or an
    // override, which would add near-identical, overlapping 6-month windows and inflate the t-stat (code review
    // 2026-11-23). The control likewise, one per week.
    const weekly = scoredRuns(runs)
    const inds = await db.collection(COLLECTIONS.industries).find({ run_id: { $in: weekly.map(r => r.run_id) } }, { projection: { _id: 0, run_id: 1, level: 1, code: 1, p_win: 1, p_lose: 1, macro: 1 } }).toArray()
    const byRun = new Map()
    for (const i of inds) { if (!byRun.has(i.run_id)) byRun.set(i.run_id, []); byRun.get(i.run_id).push(i) }
    const callsOf = (rows, as_of) => ({ as_of, long: rows.filter(r => r.p_win >= CALL_AT).map(r => `${r.level}:${r.code}`), short: rows.filter(r => r.p_lose >= CALL_AT).map(r => `${r.level}:${r.code}`) })
    const calls = weekly.map(r => callsOf(byRun.get(r.run_id) ?? [], r.as_of))
    // The macro layer ALONE (situation-network-layers.md §6): its own chances where the run kept them; a run from before
    // the sector layer WAS the macro layer.
    const macroCalls = weekly.map(r => callsOf((byRun.get(r.run_id) ?? []).map(i => (i.macro ? { ...i, ...i.macro } : i)), r.as_of))
    const ctrl = onePerWeek(control).map(c => callsOf(c.rows ?? [], c.as_of))
    // Only forecasts logged by a run that was SAVED whole count (a save that failed part-way leaves rows behind).
    const complete = new Set(runs.map(r => r.run_id))
    const counted = forecasts.filter(f => complete.has(f.run_id))
    const nodes = nodeScores(counted)
    // Brier per layer: the macro questions, and every sector's together (a row from before the layers is macro).
    const layers = { macro: nodeScores(counted.filter(f => (f.layer ?? 'macro') === 'macro')).all, sectors: nodeScores(counted.filter(f => (f.layer ?? 'macro') !== 'macro')).all }
    // UNFORESEEN (situation-network-outcomes.md §4): resolved questions won by an outcome some forecast of theirs did not have
    // as an option (the grading's `absent` rows). The missing-outcomes review works if this share falls.
    const unforeseen = unforeseenCount(counted)
    const net = { m3: spreadSummary(spreads(calls, index, HORIZONS.m3)), m6: spreadSummary(spreads(calls, index, HORIZONS.m6)) }
    const macroOnly = { m3: spreadSummary(spreads(macroCalls, index, HORIZONS.m3)), m6: spreadSummary(spreads(macroCalls, index, HORIZONS.m6)) }
    const plain = { m3: spreadSummary(spreads(ctrl, index, HORIZONS.m3)), m6: spreadSummary(spreads(ctrl, index, HORIZONS.m6)) }
    const startedOn = runs.find(r => r.kind === 'build')?.as_of ?? null
    return { as_of: today, started_on: startedOn, runs: runs.length, nodes, layers, unforeseen, industries: net, macro_only: macroOnly, control: plain, verdict: verdict(nodes, net.m6, startedOn, today) }
}
