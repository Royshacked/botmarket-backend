// CATALYST READS — Prometheus's short-swing answer, kept beside coverage, never in it (docs/design/horizon-chains.md §3).
//
// A Hotlist "this week" pick gets a catalyst read: is the catalyst real, what is it worth at a constant multiple, how
// much of it is still open, what can break it inside the window. Its TARGET is what makes "priced in" a number (Roy,
// 2026-10-23): the price before the catalyst plus what the catalyst is worth — here, spot × (1 + what is still open),
// from the delta Prometheus copied off compute_event_delta. The band comes from the delta's own low / high.
//
// WHY NOT COVERAGE. Coverage is ONE document per symbol (a unique index) and Atlas sizes holdings off it. A 1-month
// catalyst target there would be blocked by a name's long-term coverage, or block one later, and could be read as a
// valuation. So it lives here: one LIVE read per symbol, dated, graded at its window's end, and never read by Atlas.
//
// GRADED, like every call here: `hit` the day the price reaches the target; otherwise, at `valid_until`, `expired` with
// its return and SPY's over the window. A read with no target (contradicted, unsized) is a `pass` — on record, not a
// trade.

import { randomUUID } from 'crypto'
import { getDb, stripId } from '../providers/mongodb.provider.js'
import { fetchLastPrice } from './lastPrice.service.js'
import { logger } from './logger.service.js'

const LOG = '[catalystRead]'
export const COLLECTION = 'catalyst_reads'
export const LIVE = Object.freeze(['active'])
const DAY_MS = 86_400_000

const _deps = { db: () => getDb(), price: (s) => fetchLastPrice(s).catch(() => null), now: () => Date.now() }
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

const _r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
const _ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * The target from Prometheus's delta, or null. Pure. `spot` — the tool's own (the price it sized against) when it has
 * one, else the read's. What is open = the delta less the move since the catalyst (the tool's `remaining_pct`, or the
 * same arithmetic when it had no move); the band the same way off the delta's low / high.
 */
export function catalystTarget(delta, spot) {
    const base = delta?.delta_price_pct
    if (!Number.isFinite(base) || !_ok(spot)) return null
    const moved = Number.isFinite(delta.moved_pct) ? delta.moved_pct : 0
    const open = Number.isFinite(delta.remaining_pct) ? delta.remaining_pct : base - moved
    const at = (pct) => (Number.isFinite(pct) ? _r2(spot * (1 + (pct - moved) / 100)) : null)
    const legs = [at(delta.delta_price_low), at(delta.delta_price_high)].filter(v => v != null)
    return {
        value: _r2(spot * (1 + open / 100)),
        low: legs.length ? Math.min(...legs) : null,
        high: legs.length ? Math.max(...legs) : null,
        open_pct: _r2(open),
        worth_pct: _r2(base),
        moved_pct: _r2(moved),
        // How much of what the catalyst is worth the price has already taken (0 = none, 1 = all, > 1 = past it).
        priced_share: base !== 0 ? _r2(Math.max(0, moved / base)) : null,
        spot: _r2(spot),
    }
}

/**
 * The target of a RUN-UP read, or null. Pure. `runup` is the line Prometheus copied off get_runup_history: the stock's
 * median move into its last reports over the same lead, the quartiles for the band. Nothing has moved yet — the lead
 * starts at the read — so all of it is open, and `priced_share` is unknown rather than 0.
 */
export function runupTarget(runup, spot) {
    const med = runup?.median_pct
    if (!Number.isFinite(med) || !_ok(spot)) return null
    const at = (pct) => (Number.isFinite(pct) ? _r2(spot * (1 + pct / 100)) : null)
    return {
        value: at(med), low: at(runup.p25_pct), high: at(runup.p75_pct),
        open_pct: _r2(med), worth_pct: _r2(med), moved_pct: 0, priced_share: null, spot: _r2(spot), basis: 'run_up',
    }
}

/**
 * When the read's window ends → ISO. Pure. `window_days` from the read, but never past the close of the session before
 * a report inside it (the board's `exit_before`, or the run-up line's report): the trade is out before the report, so
 * the read is graded then (RCL, 2026-10-23: a 5-day window ran past its Oct 27 report). 21:00Z is after the 16:00 ET
 * close in summer and winter alike.
 */
export function readValidUntil({ nowMs, windowDays, exitBefore = null }) {
    const byWindow = nowMs + windowDays * DAY_MS
    const report = /^\d{4}-\d{2}-\d{2}$/.test(exitBefore ?? '') ? Date.parse(`${exitBefore}T21:00:00.000Z`) - DAY_MS : NaN
    return new Date(Number.isFinite(report) && report > nowMs ? Math.min(byWindow, report) : byWindow).toISOString()
}

/**
 * A stored read from the parsed block (analyst.agent _parseCatalystRead). Pure. `context` is the queue row's (the board
 * and Argus's reason). A target only on `credible` / `priced_in` with a delta or a run-up line (the run-up wins: a
 * report ahead is what the trade is), and only above the price — a long whose target is at or under spot is a `pass`,
 * never a hit on the first grade.
 */
export function buildCatalystRead(parsed, { symbol, spot = null, spy = null, nowMs, source = 'hotlist', context = null } = {}) {
    const sym = String(symbol ?? parsed?.ticker ?? '').toUpperCase().trim()
    const at = new Date(nowMs).toISOString()
    const sized = ['credible', 'priced_in'].includes(parsed?.verdict)
    const raw = !sized ? null
        : parsed?.runup ? runupTarget(parsed.runup, spot ?? parsed?.delta?.spot)
            : catalystTarget(parsed?.delta, parsed?.delta?.spot ?? spot)
    const target = raw && raw.open_pct > 0 ? raw : null
    const windowDays = parsed?.window_days ?? 14
    const exitBefore = [context?.exit_before, parsed?.runup?.report].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '')).sort()[0] ?? null
    return {
        id: `cr_${sym}_${randomUUID().slice(0, 8)}`,
        symbol: sym,
        source,
        status: target ? 'active' : 'pass',
        verdict: parsed?.verdict ?? 'unclear',
        catalyst: parsed?.catalyst ?? null,
        news_driven: parsed?.news_driven ?? null,
        confidence: parsed?.confidence ?? null,
        read: parsed?.read ?? '',
        target,
        horizon: '1m',
        window_days: windowDays,
        set_at: at,
        valid_until: readValidUntil({ nowMs, windowDays, exitBefore }),
        exit_before: exitBefore,
        price_at_read: _ok(spot) ? _r2(spot) : target?.spot ?? null,
        spy_at_read: _ok(spy) ? _r2(spy) : null,
        delta: parsed?.delta ?? null,
        runup: parsed?.runup ?? null,
        delta_basis: parsed?.delta_basis ?? null,
        implied_move_pct: parsed?.implied_move_pct ?? null,
        history: parsed?.history ?? null,
        positioning: parsed?.positioning ?? null,
        event_risk: parsed?.event_risk ?? [],
        kill: parsed?.kill ?? [],
        evidence: parsed?.evidence ?? [],
        context: context && typeof context === 'object' ? context : null,
        outcome: null,
        created_at: at,
        updated_at: at,
    }
}

/**
 * Where a live read stands on a day → `{ status, outcome }` to write, or null when nothing changes. Pure. A price at or
 * over the target is a `hit` (on the day it is seen); a window run out is `expired`, with its return and SPY's.
 */
export function gradeCatalystRead(read, { price, spy, nowMs }) {
    if (read?.status !== 'active' || !read.target) return null
    const ret = (a, b) => (_ok(a) && _ok(b) ? _r2((b / a - 1) * 100) : null)
    const base = { price: _ok(price) ? _r2(price) : null, at: new Date(nowMs).toISOString(), return_pct: ret(read.price_at_read, price),
        spy_return_pct: ret(read.spy_at_read, spy) }
    base.vs_spy = base.return_pct != null && base.spy_return_pct != null ? _r2(base.return_pct - base.spy_return_pct) : null
    if (_ok(price) && price >= read.target.value) return { status: 'hit', outcome: { ...base, hit: true } }
    if (nowMs >= Date.parse(read.valid_until)) return { status: 'expired', outcome: { ...base, hit: false } }
    return null
}

async function _coll(deps) {
    const db = await deps.db()
    return db.collection(COLLECTION)
}

let _indexed = false
async function _ensureIndexes(coll) {
    if (_indexed) return
    await coll.createIndex({ id: 1 }, { unique: true })
    await coll.createIndex({ symbol: 1, status: 1 })
    await coll.createIndex({ status: 1, valid_until: 1 })
    _indexed = true
}

/** The symbols with a live read — a name is not read twice while its window runs. */
async function liveSymbols(deps = _deps) {
    const coll = await _coll(deps)
    const rows = await coll.find({ status: { $in: LIVE } }, { projection: { _id: 0, symbol: 1 } }).toArray()
    return new Set(rows.map(r => r.symbol))
}

/**
 * Store a read Prometheus made → `{ ok, doc }`, or `{ ok: false, reason }` (`live_read` when the name already has one,
 * `symbol_required`). Prices SPY (and the name, when the tool had no spot) for the grade.
 */
async function saveRead(parsed, { symbol, source = 'hotlist', context = null } = {}, deps = _deps) {
    const sym = String(symbol ?? parsed?.ticker ?? '').toUpperCase().trim()
    if (!sym || !parsed) return { ok: false, reason: 'symbol_required' }
    try {
        const coll = await _coll(deps)
        await _ensureIndexes(coll)
        if (await coll.findOne({ symbol: sym, status: { $in: LIVE } })) return { ok: false, reason: 'live_read' }
        const [spot, spy] = await Promise.all([parsed.delta?.spot ? null : deps.price(sym), deps.price('SPY')])
        const doc = buildCatalystRead(parsed, { symbol: sym, spot: parsed.delta?.spot ?? spot, spy, nowMs: deps.now(), source, context })
        await coll.insertOne({ ...doc })
        logger.info(LOG, 'catalyst read stored', { symbol: sym, verdict: doc.verdict, status: doc.status, target: doc.target?.value ?? null, open_pct: doc.target?.open_pct ?? null })
        return { ok: true, doc: stripId(doc) }
    } catch (err) {
        logger.error(LOG, 'catalyst read not stored', err)
        return { ok: false, reason: 'save_failed', detail: err.message }
    }
}

/** The reads for the Hotlist and the API: the live ones, and those settled in the last `days`. */
async function listReads({ days = 14, deps = _deps } = {}) {
    const coll = await _coll(deps)
    const since = new Date(deps.now() - days * DAY_MS).toISOString()
    const rows = await coll.find({ $or: [{ status: { $in: LIVE } }, { updated_at: { $gte: since } }] }).sort({ set_at: -1 }).limit(200).toArray()
    return rows.map(stripId)
}

/** Grade every live read → `{ graded, hit, expired }`. Never throws: one bad quote does not stop the rest. */
async function gradeDue(deps = _deps) {
    const out = { graded: 0, hit: 0, expired: 0 }
    try {
        const coll = await _coll(deps)
        const live = await coll.find({ status: 'active' }).toArray()
        if (!live.length) return out
        const spy = await deps.price('SPY')
        const nowMs = deps.now()
        for (const read of live) {
            const g = gradeCatalystRead(read, { price: await deps.price(read.symbol), spy, nowMs })
            if (!g) continue
            await coll.updateOne({ id: read.id, status: 'active' }, { $set: { status: g.status, outcome: g.outcome, updated_at: new Date(nowMs).toISOString() } })
            out.graded++
            out[g.status]++
        }
        if (out.graded) logger.info(LOG, 'catalyst reads graded', out)
    } catch (err) {
        logger.warn(LOG, 'grading failed', { error: err.message })
    }
    return out
}

export const catalystReadService = { saveRead, listReads, liveSymbols, gradeDue }
