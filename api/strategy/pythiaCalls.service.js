// Pythia's forward log — every published verdict recorded as a CALL and graded later
// (docs/design/pythia-assessment.md §7).
//
// The only honest test of a judgment is forward: a model has read the past, so it cannot be backtested.
// Each call freezes, on the day it is made, the basket it is about (the sub-industry's largest companies)
// with each one's price, and the three benchmarks' prices: SPY, QQQ, and RSP — the equal-weight S&P 500,
// standing in for "no view, the average company". At 3 and 12 months the grader prices them again:
// the basket's equal-weight return, the share of its names beating SPY, and the gap to each benchmark.
// An `avoid` call is graded the same way — it was right when the basket lagged.
//
// PRICE returns (no dividends) on both sides, so the comparison is like for like. The design's second
// baseline, "rules only", waits until the rules run in production (§7); RSP stands in for "no view".
//
// A call is logged when the verdict CHANGES, or when the last call on the subject is REAFFIRM_DAYS old —
// a weekly reaffirmation would otherwise count the same judgment four times a month in the record.

import { getDb } from '../../providers/mongodb.provider.js'
import { getNumericQuote } from '../../providers/yahoofinance.provider.js'
import { mapLimit } from '../../services/concurrency.util.js'
import { readCompanies } from './industryData.service.js'
import { LEGACY_VERDICTS } from './industryAssessment.service.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[pythiaCalls]'
export const COLLECTION = 'pythia_calls'
export const BENCHMARKS = Object.freeze(['SPY', 'QQQ', 'RSP'])
export const HORIZON_DAYS = Object.freeze({ '3m': 91, '12m': 365 })
export const REAFFIRM_DAYS = 28
export const BASKET_MAX = 40
export const BASKET_MIN = 3
/** A horizon graded more than this many days after it fell due is VOID, not scored on the wrong date. */
export const GRADE_GRACE_DAYS = 14
/** A grade missing more than this share of its basket (delisted, renamed) is flagged incomplete. */
export const INCOMPLETE_SHARE = 0.2
const QUOTE_CONCURRENCY = 8

const _io = {
    db: () => getDb(),
    companies: (level, code, opts) => readCompanies(level, code, opts),
    price: async (symbol) => (await getNumericQuote(symbol))?.price ?? null,
}
/** Test seam. */
export function _setCallsIO(io) { Object.assign(_io, io) }

const _days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86_400_000
const _ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0

/** Log a new call? Pure. A first call, a changed verdict, or a reaffirmation REAFFIRM_DAYS after the last. */
export function shouldLog(prev, verdict, now) {
    if (!prev) return true
    // A call logged under the words before 2026-10-11 is the same call in today's words, not a change.
    if ((LEGACY_VERDICTS[prev.verdict] ?? prev.verdict) !== verdict) return true
    return _days(prev.called_at, now) >= REAFFIRM_DAYS
}

/**
 * Grade one call at one horizon from its frozen entry prices and today's → the grade, or null when fewer
 * than BASKET_MIN names or any benchmark could be priced. Pure. A name with no exit price (delisted,
 * renamed) is left out and counted in `missing` — and since the names that vanish are mostly the big losers
 * (a bankruptcy) or acquired at a premium, the grade says how much of the basket is gone and is flagged
 * `incomplete` past INCOMPLETE_SHARE, so a flattered grade is visible as such (code review 2026-10-11).
 */
export function gradeCall(call, exit, at) {
    const rets = []
    let missing = 0
    for (const s of call.basket ?? []) {
        const a = call.entry?.[s], b = exit[s]
        if (_ok(a) && _ok(b)) rets.push(b / a - 1)
        else missing++
    }
    const bench = {}
    for (const s of BENCHMARKS) {
        const a = call.bench_entry?.[s], b = exit[s]
        if (!_ok(a) || !_ok(b)) return null
        bench[s] = b / a - 1
    }
    if (rets.length < BASKET_MIN) return null
    const basket = rets.reduce((x, y) => x + y, 0) / rets.length
    const right = call.verdict === 'avoid' ? basket < bench.SPY : basket > bench.SPY
    return {
        at, n: rets.length, missing, missing_share: missing / (call.basket?.length || 1),
        incomplete: missing / (call.basket?.length || 1) > INCOMPLETE_SHARE, basket_return: basket,
        share_beat_spy: rets.filter(r => r > bench.SPY).length / rets.length,
        spy: bench.SPY, qqq: bench.QQQ, rsp: bench.RSP,
        vs_spy: basket - bench.SPY, vs_qqq: basket - bench.QQQ, vs_rsp: basket - bench.RSP,
        // Watch and no case make no directional call: measured, never "right" or "wrong".
        right: call.verdict === 'watch' || call.verdict === 'no_case' ? null : right,
    }
}

/**
 * The house scan's picks at one horizon (docs/design/house-research-chain.md step 4): their equal-weight return
 * against the call's own basket, and against the LARGEST uncovered names the scan picked before Argus did — so the
 * record answers whether choosing beats size. Null under one priced pick or without a basket grade. Pure.
 */
export function gradePicks(picks, exit, basket) {
    const ret = (symbols, entry = picks.entry) => {
        const rs = (symbols ?? []).map(s => (_ok(entry?.[s]) && _ok(exit[s]) ? exit[s] / entry[s] - 1 : null)).filter(r => r != null)
        return rs.length ? { n: rs.length, ret: rs.reduce((x, y) => x + y, 0) / rs.length } : null
    }
    const chosen = ret(picks.symbols), largest = ret(picks.largest)
    // The basket over the PICKS' window — priced again when they were frozen (`basket_entry`), so a move between the
    // call and the house scan counts for neither side (code review 2026-10-23).
    const own = ret(basket, picks.basket_entry)
    const basketReturn = own && own.n >= BASKET_MIN ? own.ret : null
    if (!chosen || basketReturn == null) return null
    return {
        source: picks.source, n: chosen.n, return: chosen.ret, vs_basket: chosen.ret - basketReturn,
        ...(largest ? { largest_return: largest.ret, vs_largest: chosen.ret - largest.ret } : {}),
    }
}

/** A call this young takes the week's picks; an older one was priced too long before them to compare. */
export const PICKS_MAX_AGE_DAYS = 3

/**
 * Freeze the house scan's picks on the subject's latest call (house-research-chain.md step 4) → `{ attached }`.
 * Only a call made within PICKS_MAX_AGE_DAYS (the week that published it), and only once: the first picks a call
 * gets are the ones it grades. `largest` is the old way's choice — the first `symbols.length` uncovered names of
 * the call's basket (largest first) — priced beside them. Throws on a db failure; the caller logs it.
 */
async function attachPicks(subject, { symbols, source, covered = new Set(), now = new Date().toISOString() } = {}) {
    if (!symbols?.length) return { attached: false, reason: 'no picks' }
    const db = await _io.db()
    const field = subject?.code ? 'subject.code' : 'subject.id'
    const call = await db.collection(COLLECTION).find({ [field]: subject?.code ?? subject?.id }).sort({ called_at: -1 }).limit(1).next()
    if (!call) return { attached: false, reason: 'no call' }
    if (call.picks) return { attached: false, reason: 'already has picks' }
    if (_days(call.called_at, now) > PICKS_MAX_AGE_DAYS) return { attached: false, reason: 'call too old' }
    const largest = (call.basket ?? []).filter(s => !covered.has(s)).slice(0, symbols.length)
    const prices = await _prices([...new Set([...symbols, ...largest, ...(call.basket ?? [])])])
    const priced = symbols.filter(s => prices[s])
    if (!priced.length) return { attached: false, reason: 'could not price the picks' }
    const pick = (list) => Object.fromEntries(list.filter(s => prices[s]).map(s => [s, prices[s]]))
    const picks = { at: now, source, symbols: priced, largest: largest.filter(s => prices[s]),
        entry: pick([...new Set([...symbols, ...largest])]), basket_entry: pick(call.basket ?? []) }
    await db.collection(COLLECTION).updateOne({ id: call.id, picks: { $exists: false } }, { $set: { picks } })
    return { attached: true, call: call.id }
}

async function _prices(symbols) {
    const rows = await mapLimit(symbols, async (s) => {
        try { return [s, await _io.price(s)] } catch { return [s, null] }
    }, { concurrency: QUOTE_CONCURRENCY })
    return Object.fromEntries(rows.filter(([, p]) => _ok(p)))
}

/** Once, at boot (server.js). */
export async function ensurePythiaCallsIndexes() {
    const db = await _io.db()
    await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
    await db.collection(COLLECTION).createIndex({ 'subject.code': 1, called_at: -1 })
    await db.collection(COLLECTION).createIndex({ 'subject.id': 1, called_at: -1 })
    await db.collection(COLLECTION).createIndex({ status: 1 })
}

/**
 * Record the call a just-published assessment makes, when shouldLog says so → the call, `{ logged:false }`,
 * or throws (the caller logs it; the assessment stands). The basket is the sub-industry's own largest
 * companies — the names Argus would hunt among.
 */
async function recordCall(doc, { now = new Date().toISOString(), basket: given = null } = {}) {
    const db = await _io.db()
    // An industry is keyed by its GICS code, a theme (step 3) by its id; a theme's basket comes from the
    // caller (its own names, or its linked industries' largest), an industry's from its own companies.
    const key = doc.subject.code ?? doc.subject.id
    const field = doc.subject.code ? 'subject.code' : 'subject.id'
    const prev = await db.collection(COLLECTION).find({ [field]: key }).sort({ called_at: -1 }).limit(1).next()
    if (!shouldLog(prev, doc.verdict, now)) return { logged: false, reason: 'same verdict, reaffirmed within the window' }
    const symbols = Array.isArray(given) && given.length
        ? [...new Set(given.map(s => String(s).toUpperCase()))].slice(0, BASKET_MAX)
        : (await _io.companies('sub_industry', key, { limit: BASKET_MAX })).map(c => c.symbol).filter(Boolean)
    const code = key
    const prices = await _prices([...symbols, ...BENCHMARKS])
    const basket = symbols.filter(s => prices[s])
    if (basket.length < BASKET_MIN || BENCHMARKS.some(s => !prices[s])) {
        throw new Error(`could not price the basket (${basket.length} of ${symbols.length}) or a benchmark`)
    }
    const call = {
        // The minute in the id: two published verdicts on one day are two calls (a same-day flip used to
        // overwrite the first — code review 2026-10-11).
        id: `pc_${code}_${now.replace(/[-:]/g, '').slice(0, 13)}`, subject: doc.subject, verdict: doc.verdict, horizon: doc.horizon,
        confidence: doc.confidence, thesis: doc.thesis, called_at: now, assessed_at: doc.assessed_at,
        basket, entry: Object.fromEntries(basket.map(s => [s, prices[s]])),
        bench_entry: Object.fromEntries(BENCHMARKS.map(s => [s, prices[s]])),
        grades: {}, status: 'open',
    }
    await db.collection(COLLECTION).insertOne(call)
    logger.info(LOG, 'call logged', { code, verdict: call.verdict, basket: basket.length })
    return { logged: true, call }
}

/**
 * Grade every call that has reached a horizon it has no grade for → `{ graded, voided, failed }`. A call is
 * closed once every horizon has a grade or a void. Never throws per call: one bad quote run does not stop the
 * rest.
 *
 * VOID, NOT WRONG (code review 2026-10-11). A horizon is priced only within GRADE_GRACE_DAYS of falling due:
 * later than that, today's prices would be scored as the 3-month result (a grader down for a year once would
 * have given 3m and 12m the same numbers). And a horizon that still cannot be priced when the grace runs out
 * (the basket lost too many names, a benchmark would not quote) is voided too, so the call can close instead
 * of being re-priced every day forever.
 */
async function gradeDue({ now = new Date().toISOString() } = {}) {
    const db = await _io.db()
    const open = await db.collection(COLLECTION).find({ status: 'open' }).toArray()
    let graded = 0, voided = 0, failed = 0
    for (const call of open) {
        const due = Object.entries(HORIZON_DAYS).filter(([k, d]) => !call.grades?.[k] && _days(call.called_at, now) >= d)
            .map(([k, d]) => ({ k, late: _days(call.called_at, now) - d }))
        if (!due.length) continue
        try {
            const set = {}
            const voidIt = (k, reason) => { set[`grades.${k}`] = { at: now, void: true, reason }; voided++ }
            const inTime = due.filter(x => x.late <= GRADE_GRACE_DAYS)
            for (const x of due.filter(x => x.late > GRADE_GRACE_DAYS)) voidIt(x.k, `not graded until ${Math.round(x.late)} days after it fell due`)
            const pickSyms = call.picks ? [...(call.picks.symbols ?? []), ...(call.picks.largest ?? [])] : []
            const exit = inTime.length ? await _prices([...new Set([...call.basket, ...pickSyms, ...BENCHMARKS])]) : {}
            for (const x of inTime) {
                const g = gradeCall(call, exit, now)
                const p = g && call.picks ? gradePicks(call.picks, exit, call.basket) : null
                if (g) { set[`grades.${x.k}`] = { ...g, ...(p ? { picks: p } : {}), late_days: Math.round(x.late) }; graded++ }
                else failed++
            }
            const done = Object.keys(HORIZON_DAYS).every(k => call.grades?.[k] || set[`grades.${k}`])
            if (done) set.status = 'closed'
            if (Object.keys(set).length) await db.collection(COLLECTION).updateOne({ id: call.id }, { $set: set })
        } catch (err) {
            failed++
            logger.warn(LOG, 'grading failed', { id: call.id, error: err.message })
        }
    }
    if (graded || voided || failed) logger.info(LOG, 'grading done', { graded, voided, failed })
    return { graded, voided, failed }
}

/**
 * The track record by verdict and horizon → `{ [verdict]: { [horizon]: { n, right, avg_vs_spy,
 * avg_share_beat_spy, incomplete, void } }, open }`. Pure over the calls. `right` is the share graded right
 * (not for `watch`); a VOID horizon is counted but never averaged; `incomplete` counts grades that lost
 * more than INCOMPLETE_SHARE of their basket.
 */
export function summarise(calls) {
    const out = {}
    let open = 0
    for (const c of calls) {
        if (c.status === 'open') open++
        for (const [h, g] of Object.entries(c.grades ?? {})) {
            const s = ((out[c.verdict] ??= {})[h] ??= { n: 0, right_n: 0, judged: 0, vs_spy: 0, beat: 0, incomplete: 0, void: 0 })
            if (g.void) { s.void++; continue }
            s.n++; s.vs_spy += g.vs_spy; s.beat += g.share_beat_spy
            if (g.incomplete) s.incomplete++
            if (g.right != null) { s.judged++; s.right_n += g.right ? 1 : 0 }
        }
    }
    for (const byH of Object.values(out)) {
        for (const [h, s] of Object.entries(byH)) {
            byH[h] = { n: s.n, right: s.judged ? s.right_n / s.judged : null, avg_vs_spy: s.n ? s.vs_spy / s.n : null,
                avg_share_beat_spy: s.n ? s.beat / s.n : null, incomplete: s.incomplete, void: s.void }
        }
    }
    return { by_verdict: out, open, total: calls.length }
}

async function trackRecord() {
    const db = await _io.db()
    const calls = await db.collection(COLLECTION).find({}, { projection: { _id: 0, verdict: 1, status: 1, grades: 1 } }).toArray()
    return summarise(calls)
}

async function listCalls({ limit = 100 } = {}) {
    const db = await _io.db()
    return db.collection(COLLECTION).find({}, { projection: { _id: 0, entry: 0, bench_entry: 0 } })
        .sort({ called_at: -1 }).limit(Math.min(Math.max(limit, 1), 500)).toArray()
}

export const pythiaCallsService = { recordCall, attachPicks, gradeDue, trackRecord, listCalls }
