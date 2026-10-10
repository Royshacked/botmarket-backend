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
import { logger } from '../../services/logger.service.js'

const LOG = '[pythiaCalls]'
export const COLLECTION = 'pythia_calls'
export const BENCHMARKS = Object.freeze(['SPY', 'QQQ', 'RSP'])
export const HORIZON_DAYS = Object.freeze({ '3m': 91, '12m': 365 })
export const REAFFIRM_DAYS = 28
export const BASKET_MAX = 40
export const BASKET_MIN = 3
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
    if (prev.verdict !== verdict) return true
    return _days(prev.called_at, now) >= REAFFIRM_DAYS
}

/**
 * Grade one call at one horizon from its frozen entry prices and today's → the grade, or null when fewer
 * than BASKET_MIN names or any benchmark could be priced. Pure. A name with no exit price (delisted,
 * renamed) is left out and counted in `missing`.
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
        at, n: rets.length, missing, basket_return: basket,
        share_beat_spy: rets.filter(r => r > bench.SPY).length / rets.length,
        spy: bench.SPY, qqq: bench.QQQ, rsp: bench.RSP,
        vs_spy: basket - bench.SPY, vs_qqq: basket - bench.QQQ, vs_rsp: basket - bench.RSP,
        right: call.verdict === 'watch' ? null : right,
    }
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
    await db.collection(COLLECTION).createIndex({ status: 1 })
}

/**
 * Record the call a just-published assessment makes, when shouldLog says so → the call, `{ logged:false }`,
 * or throws (the caller logs it; the assessment stands). The basket is the sub-industry's own largest
 * companies — the names Argus would hunt among.
 */
async function recordCall(doc, { now = new Date().toISOString() } = {}) {
    const db = await _io.db()
    const code = doc.subject.code
    const prev = await db.collection(COLLECTION).find({ 'subject.code': code }).sort({ called_at: -1 }).limit(1).next()
    if (!shouldLog(prev, doc.verdict, now)) return { logged: false, reason: 'same verdict, reaffirmed within the window' }
    const companies = await _io.companies('sub_industry', code, { limit: BASKET_MAX })
    const symbols = companies.map(c => c.symbol).filter(Boolean)
    const prices = await _prices([...symbols, ...BENCHMARKS])
    const basket = symbols.filter(s => prices[s])
    if (basket.length < BASKET_MIN || BENCHMARKS.some(s => !prices[s])) {
        throw new Error(`could not price the basket (${basket.length} of ${symbols.length}) or a benchmark`)
    }
    const call = {
        id: `pc_${code}_${now.slice(0, 10)}`, subject: doc.subject, verdict: doc.verdict, horizon: doc.horizon,
        confidence: doc.confidence, thesis: doc.thesis, called_at: now, assessed_at: doc.assessed_at,
        basket, entry: Object.fromEntries(basket.map(s => [s, prices[s]])),
        bench_entry: Object.fromEntries(BENCHMARKS.map(s => [s, prices[s]])),
        grades: {}, status: 'open',
    }
    await db.collection(COLLECTION).replaceOne({ id: call.id }, call, { upsert: true })
    logger.info(LOG, 'call logged', { code, verdict: call.verdict, basket: basket.length })
    return { logged: true, call }
}

/**
 * Grade every call that has reached a horizon it has no grade for → `{ graded, failed }`. A call is closed
 * once its last horizon is graded. Never throws per call: one bad quote run does not stop the rest.
 */
async function gradeDue({ now = new Date().toISOString() } = {}) {
    const db = await _io.db()
    const open = await db.collection(COLLECTION).find({ status: 'open' }).toArray()
    let graded = 0, failed = 0
    for (const call of open) {
        const due = Object.entries(HORIZON_DAYS).filter(([k, d]) => !call.grades?.[k] && _days(call.called_at, now) >= d).map(([k]) => k)
        if (!due.length) continue
        try {
            const exit = await _prices([...call.basket, ...BENCHMARKS])
            const set = {}
            for (const k of due) {
                const g = gradeCall(call, exit, now)
                if (g) { set[`grades.${k}`] = g; graded++ }
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
    if (graded || failed) logger.info(LOG, 'grading done', { graded, failed })
    return { graded, failed }
}

/**
 * The track record by verdict and horizon → `{ [verdict]: { [horizon]: { n, right, avg_vs_spy,
 * avg_share_beat_spy } }, open }`. Pure over the calls. `right` is the share graded right (not for `watch`).
 */
export function summarise(calls) {
    const out = {}
    let open = 0
    for (const c of calls) {
        if (c.status === 'open') open++
        for (const [h, g] of Object.entries(c.grades ?? {})) {
            const s = ((out[c.verdict] ??= {})[h] ??= { n: 0, right_n: 0, judged: 0, vs_spy: 0, beat: 0 })
            s.n++; s.vs_spy += g.vs_spy; s.beat += g.share_beat_spy
            if (g.right != null) { s.judged++; s.right_n += g.right ? 1 : 0 }
        }
    }
    for (const byH of Object.values(out)) {
        for (const [h, s] of Object.entries(byH)) {
            byH[h] = { n: s.n, right: s.judged ? s.right_n / s.judged : null, avg_vs_spy: s.vs_spy / s.n, avg_share_beat_spy: s.beat / s.n }
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

export const pythiaCallsService = { recordCall, gradeDue, trackRecord, listCalls }
