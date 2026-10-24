// CATALYST READS — Prometheus's short-swing answer, kept beside coverage, never in it (docs/design/horizon-chains.md §3).
//
// A Hotlist "this week" pick gets a catalyst read: is the catalyst real, can the company carry it, what is it worth at a
// constant multiple, how much of it is still open, what can break it inside the window.
//
// THE TARGET IS HIS (Roy, 2026-10-24): Prometheus decides a short-swing price from the catalyst and the company
// (`ownTarget`); the tools' number below — the event delta, or the run-up — is his YARDSTICK, kept beside it, and the
// target only when he gave none. Whoever set it, the trade's rules hold: above the price, enough open (minOpenPct), a
// window before the report, a run-up not already run, a company not `broken`. Its TARGET is what makes "priced in" a number (Roy,
// 2026-10-23): the price before the catalyst plus what the catalyst is worth — here, spot × (1 + what is still open),
// from the delta Prometheus copied off compute_event_delta. The band comes from the delta's own low / high. A RUN-UP
// (a report ahead, nothing happened yet) is sized off get_runup_history instead: spot × (1 + the stock's median run-up).
//
// WHY NOT COVERAGE. Coverage is ONE document per symbol (a unique index) and Atlas sizes holdings off it. A 1-month
// catalyst target there would be blocked by a name's long-term coverage, or block one later, and could be read as a
// valuation. So it lives here: one LIVE read per symbol, dated, graded at its window's end, and never read by Atlas.
//
// GRADED, like every call here: `hit` the day the price reaches the target; past `valid_until`, by the window's own
// daily bars — `hit` if its high reached the target, else `expired` with its return and SPY's at the window's last
// close. A read with no target (contradicted, unsized, nothing open, no window left) is a `pass` — on record, not a
// trade.

import { randomUUID } from 'crypto'
import { getDb, stripId } from '../providers/mongodb.provider.js'
import { getTickerAggregates } from '../providers/candles.provider.js'
import { fetchLastPrice } from './lastPrice.service.js'
import { runupSpent } from './tools/runup.tools.js'
import { logger } from './logger.service.js'

const LOG = '[catalystRead]'
export const COLLECTION = 'catalyst_reads'
export const LIVE = Object.freeze(['active'])
const DAY_MS = 86_400_000
const _etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const _deps = {
    db:    () => getDb(),
    price: (s) => fetchLastPrice(s).catch(() => null),
    // Daily bars over a read's window — what grades it once the window has run out.
    bars:  (s, from, to) => getTickerAggregates(s, { timeSpan: 'day', multiplier: 1, from, to }).catch(() => null),
    now:   () => Date.now(),
}
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
 * median move into its last reports over the same lead, the quartiles for the band.
 *
 * THIS CYCLE (2026-10-24): with the line's `full_median_pct` (the usual run-up over the full window) and `so_far_pct`
 * (how much of it this cycle has already moved), what is typically LEFT is the full run-up less the move so far. The
 * target is the smaller of that and the usual last-sessions move — a stock that ran ahead of its path has less left;
 * one on its path keeps the usual. The band moves down by the same cut. `moved_pct` is the head start, `worth_pct` the
 * full run-up, `priced_share` how much of it is gone.
 */
export function runupTarget(runup, spot) {
    const med = runup?.median_pct
    if (!Number.isFinite(med) || !_ok(spot)) return null
    const cycle = Number.isFinite(runup.full_median_pct) && Number.isFinite(runup.so_far_pct)
    const left = cycle ? runup.full_median_pct - runup.so_far_pct : null
    const open = cycle ? Math.min(med, left) : med
    const cut = med - open
    const at = (pct) => (Number.isFinite(pct) ? _r2(spot * (1 + (pct - cut) / 100)) : null)
    return {
        value: _r2(spot * (1 + open / 100)), low: at(runup.p25_pct), high: at(runup.p75_pct),
        open_pct: _r2(open), worth_pct: _r2(cycle ? runup.full_median_pct : med), moved_pct: cycle ? _r2(runup.so_far_pct) : 0,
        priced_share: cycle && runup.full_median_pct > 0 ? _r2(Math.max(0, runup.so_far_pct / runup.full_median_pct)) : null,
        spot: _r2(spot), basis: 'run_up', ...(cut > 0 ? { cycle_cut_pct: _r2(cut) } : {}),
    }
}

/**
 * When the read's window ends → ISO. Pure. `window_days` from the read, but never past the close of the session before
 * a report inside it (the board's `exit_before`, or the run-up line's report): the trade is out before the report, so
 * the read is graded then (RCL, 2026-10-23: a 5-day window ran past its Oct 27 report). 21:00Z is after the 16:00 ET
 * close in summer and winter alike. NULL when that close has already passed — a read made after it (a late pick-up)
 * has no window left before the report, and the full window would run through it (code review 2026-10-24).
 */
export function readValidUntil({ nowMs, windowDays, exitBefore = null }) {
    const byWindow = nowMs + windowDays * DAY_MS
    const report = /^\d{4}-\d{2}-\d{2}$/.test(exitBefore ?? '') ? Date.parse(`${exitBefore}T21:00:00.000Z`) - DAY_MS : NaN
    if (!Number.isFinite(report)) return new Date(byWindow).toISOString()
    return report > nowMs ? new Date(Math.min(byWindow, report)).toISOString() : null
}

/**
 * PROMETHEUS'S OWN TARGET (Roy, 2026-10-24: "Prometheus should analyze the catalyst and company and decide of a
 * short-term swing PT"), or null. Pure. `own` is the block's `target` ({ price, low, high, why }); `yard` the target the
 * tools' line gives (runupTarget / catalystTarget) — kept beside his as `yardstick`, so a read shows how far he moved off
 * it, and its worth / moved / priced share ride along. Null without a price or a spot to measure what is open from.
 *
 * STRETCH (code review 2026-10-24): a target more than STRETCH_X times the larger of the options' implied move and the
 * yardstick is flagged `stretch` — shown with the read and told to Mentor, never blocked: his number is his call.
 */
export function ownTarget(own, spot, yard = null, { impliedMovePct = null } = {}) {
    if (!_ok(own?.price) || !_ok(spot)) return null
    const open = (own.price / spot - 1) * 100
    const refs = [Math.abs(Number(impliedMovePct)), yard?.open_pct].filter(v => Number.isFinite(v) && v > 0)
    const ref = refs.length ? Math.max(...refs) : null
    return {
        value: _r2(own.price), low: _ok(own.low) ? _r2(own.low) : null, high: _ok(own.high) ? _r2(own.high) : null,
        open_pct: _r2(open),
        worth_pct: yard?.worth_pct ?? null, moved_pct: yard?.moved_pct ?? null, priced_share: yard?.priced_share ?? null,
        spot: _r2(spot), basis: 'prometheus', why: own.why ?? null,
        yardstick: yard ? { value: yard.value, open_pct: yard.open_pct, basis: yard.basis ?? 'event' } : null,
        ...(ref != null && open > STRETCH_X * ref ? { stretch: { ref_pct: _r2(ref), times: _r2(open / ref) } } : {}),
    }
}

/** How many times the implied move (or the yardstick, the larger) a target may sit before it is flagged a stretch. */
export const STRETCH_X = 3

/** The least a target may leave open to be a trade: 1%. */
export const MIN_OPEN_PCT = 1

/**
 * The least open move a target needs to be a TRADE, in % — 1%, or half the stock's daily range when that is wider. Pure.
 * Below it a target is noise a single session's wiggle reaches: RCL's run-up record was +0.23% over 11 reports, stored as
 * a credible read with a live target 0.2% above the price (Roy, 2026-10-24) — any tick over it would have booked a "hit"
 * and flattered the record. `atrPct` is the board row's ATR % (the hand-off's context); unknown → the 1% floor.
 */
export function minOpenPct(atrPct) {
    const half = Number(atrPct) / 2
    return Number.isFinite(half) && half > MIN_OPEN_PCT ? half : MIN_OPEN_PCT
}

/**
 * A stored read from the parsed block (analyst.agent _parseCatalystRead). Pure. `context` is the queue row's (the board
 * and Argus's reason). A target only on `credible` / `priced_in` with a delta or a run-up line (the run-up wins: a
 * report ahead is what the trade is), and only above the price — a long whose target is at or under spot is a `pass`,
 * never a hit on the first grade. A read made after the close before its report is a `pass` too (`report_too_close`),
 * and so is one whose target is too close to trade (`too_small`, minOpenPct).
 */
export function buildCatalystRead(parsed, { symbol, spot = null, spy = null, nowMs, source = 'hotlist', context = null } = {}) {
    const sym = String(symbol ?? parsed?.ticker ?? '').toUpperCase().trim()
    const at = new Date(nowMs).toISOString()
    const sized = ['credible', 'priced_in'].includes(parsed?.verdict)
    const yard = !sized ? null
        : parsed?.runup ? runupTarget(parsed.runup, spot ?? parsed?.delta?.spot)
            : catalystTarget(parsed?.delta, parsed?.delta?.spot ?? spot)
    // HIS number, measured from the read's price — and only his: no target of his is a pass (`no_target`), never the
    // tools' line (code review 2026-10-24: the prompt tells him to leave it out when he would not trade toward one, and
    // the yardstick in its place built Mentor a take-profit he had refused). The tools' line is his yardstick.
    const own = sized ? ownTarget(parsed?.target, spot ?? parsed?.delta?.spot, yard, { impliedMovePct: parsed?.implied_move_pct }) : null
    const raw = own
    // A company that cannot carry the trade (dilution, distress) has no target, whatever the catalyst.
    const broken = parsed?.company?.verdict === 'broken'
    const windowDays = parsed?.window_days ?? 14
    const exitBefore = [context?.exit_before, parsed?.runup?.report].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '')).sort()[0] ?? null
    const validUntil = readValidUntil({ nowMs, windowDays, exitBefore })
    const minOpen = minOpenPct(context?.atr_pct)
    // A run-up the stock has ALREADY RUN this cycle has nothing typical left (runup.tools runupSpent) — worked out here
    // from the line's numbers, whatever verdict the model wrote.
    const spent = Boolean(parsed?.runup) && runupSpent(parsed.runup)
    const target = raw && raw.open_pct >= minOpen && validUntil && !spent && !broken ? raw : null
    // Why a read carries no target: the verdict, a broken company, no window left before the report, the run-up already
    // run this cycle, no number of his (or none to measure it from), too little open to trade — less after this cycle's
    // run-up (the YARDSTICK's cut, code review 2026-10-24) — or nothing open.
    const passReason = target ? null : !sized ? (parsed?.verdict ?? 'unclear') : broken ? 'company' : !validUntil ? 'report_too_close'
        : spent ? 'already_ran' : !raw ? (parsed?.target ? 'unsized' : 'no_target')
            : yard?.cycle_cut_pct > 0 && raw.open_pct > 0 ? 'already_ran' : raw.open_pct > 0 ? 'too_small' : 'nothing_open'
    return {
        id: `cr_${sym}_${randomUUID().slice(0, 8)}`,
        symbol: sym,
        source,
        status: target ? 'active' : 'pass',
        pass_reason: passReason,
        verdict: parsed?.verdict ?? 'unclear',
        catalyst: parsed?.catalyst ?? null,
        news_driven: parsed?.news_driven ?? null,
        confidence: parsed?.confidence ?? null,
        read: parsed?.read ?? '',
        target,
        company: parsed?.company ?? null,
        horizon: '1m',
        window_days: windowDays,
        set_at: at,
        valid_until: validUntil ?? at,
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

/** A read whose window ran out and whose window prices never came is closed this long after, unpriced. */
export const GRADE_GIVE_UP_MS = 3 * DAY_MS

/**
 * Where a live read stands → `{ status, outcome }` to write, or null when nothing changes. Pure.
 *
 * INSIDE its window: the live price at or over the target is a `hit` (on the day it is seen). PAST it: the live price
 * says nothing about the window — the hourly grade can miss the evening before a report and see the morning after it
 * (code review 2026-10-24) — so the WINDOW'S own daily bars decide: `hit` when its high reached the target, else
 * `expired`, the return at its last close (and SPY's). `window` is `{ high, close, spy_close }` from those bars, or null
 * when they are not in yet: then nothing changes, until GRADE_GIVE_UP_MS past the window closes it unpriced.
 */
export function gradeCatalystRead(read, { price, spy, nowMs, window = null }) {
    if (read?.status !== 'active' || !read.target) return null
    const ret = (a, b) => (_ok(a) && _ok(b) ? _r2((b / a - 1) * 100) : null)
    const outcome = (px, spyPx, hit) => {
        const o = { price: _ok(px) ? _r2(px) : null, at: new Date(nowMs).toISOString(), return_pct: ret(read.price_at_read, px), spy_return_pct: ret(read.spy_at_read, spyPx) }
        o.vs_spy = o.return_pct != null && o.spy_return_pct != null ? _r2(o.return_pct - o.spy_return_pct) : null
        return { ...o, hit }
    }
    const end = Date.parse(read.valid_until)
    if (!(nowMs >= end)) return _ok(price) && price >= read.target.value ? { status: 'hit', outcome: outcome(price, spy, true) } : null
    if (window && _ok(window.close)) {
        const hit = _ok(window.high) && window.high >= read.target.value
        return { status: hit ? 'hit' : 'expired', outcome: { ...outcome(window.close, window.spy_close, hit), basis: 'window' } }
    }
    return nowMs >= end + GRADE_GIVE_UP_MS ? { status: 'expired', outcome: { ...outcome(null, null, false), basis: 'unpriced' } } : null
}

/**
 * The window's high, its last close and SPY's last close from daily bars, by ET session date. Pure. Null on no bars.
 * The read's own day counts only when the read came BEFORE that day's open: a daily bar cannot say whether its high came
 * before or after a read made mid-session, and RCL's read day had a 280 high above its 277.34 target from before the
 * read existed (live check, 2026-10-24). A same-day hit after the read is the hourly live grade's to catch.
 */
export function windowPrices(read, bars, spyBars) {
    const setMs = Date.parse(read.set_at)
    const etClock = new Date(setMs).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false })
    const from = etClock < '09:30' ? _etDay(setMs) : _etDay(setMs + DAY_MS)
    const to = _etDay(Date.parse(read.valid_until))
    const inside = (bs) => (bs ?? []).filter(b => { const d = _etDay(b.timestamp > 1e12 ? b.timestamp : b.timestamp * 1000); return d >= from && d <= to })
    const own = inside(bars), spyIn = inside(spyBars)
    if (!own.length) return null
    return { high: Math.max(...own.map(b => Number(b.high) || Number(b.close) || 0)), close: own.at(-1).close, spy_close: spyIn.at(-1)?.close ?? null }
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
    // ONE active read per symbol, held by the database and not only by a check before the insert — two processes on one
    // database (the laptop and Render on a shared db) could both pass the check (code review 2026-10-24).
    await coll.createIndex({ symbol: 1 }, { unique: true, name: 'one_active_read', partialFilterExpression: { status: 'active' } })
        .catch(err => logger.warn(LOG, 'the one-active-read index was not built', { error: err.message }))
    _indexed = true
}

/** The live filter: active, and its window not run out — a read past it no longer blocks a new one, graded or not. */
const _liveQuery = (nowMs) => ({ status: { $in: LIVE }, valid_until: { $gt: new Date(nowMs).toISOString() } })

/** The symbols with a live read — a name is not read twice while its window runs. */
async function liveSymbols(deps = _deps) {
    const coll = await _coll(deps)
    const rows = await coll.find(_liveQuery(deps.now()), { projection: { _id: 0, symbol: 1 } }).toArray()
    return new Set(rows.map(r => r.symbol))
}

/** Grade one read → its new status, or null. Throws only on the write; the caller isolates it. */
async function _gradeOne(coll, read, { spy, nowMs, deps, force = false }) {
    const past = nowMs >= Date.parse(read.valid_until)
    const window = past ? await _window(read, deps) : null
    let g = gradeCatalystRead(read, { price: past ? null : await deps.price(read.symbol), spy, nowMs, window })
    // Making room for a new read on the name: an ungradable old one is closed unpriced rather than left in the way.
    if (!g && force && past) g = { status: 'expired', outcome: { price: null, at: new Date(nowMs).toISOString(), return_pct: null, spy_return_pct: null, vs_spy: null, hit: false, basis: 'unpriced' } }
    if (!g) return null
    await coll.updateOne({ id: read.id, status: 'active' }, { $set: { status: g.status, outcome: g.outcome, updated_at: new Date(nowMs).toISOString() } })
    return g.status
}

async function _window(read, deps) {
    const from = Date.parse(read.set_at) - DAY_MS, to = Date.parse(read.valid_until) + DAY_MS
    const [bars, spyBars] = await Promise.all([deps.bars(read.symbol, from, to), deps.bars('SPY', from, to)])
    return windowPrices(read, bars, spyBars)
}

/**
 * Store a read Prometheus made → `{ ok, doc }`, or `{ ok: false, reason }` (`live_read` when the name already has one,
 * `symbol_required`). Prices SPY (and the name, when the tool had no spot) for the grade. An old read on the name whose
 * window ran out is graded first (closed unpriced if it cannot be), so the one-active-read index lets the new one in.
 */
async function saveRead(parsed, { symbol, source = 'hotlist', context = null } = {}, deps = _deps) {
    const sym = String(symbol ?? parsed?.ticker ?? '').toUpperCase().trim()
    if (!sym || !parsed) return { ok: false, reason: 'symbol_required' }
    try {
        const coll = await _coll(deps)
        await _ensureIndexes(coll)
        const nowMs = deps.now()
        if (await coll.findOne({ symbol: sym, ..._liveQuery(nowMs) })) return { ok: false, reason: 'live_read' }
        for (const old of await coll.find({ symbol: sym, status: 'active' }).toArray()) await _gradeOne(coll, old, { spy: null, nowMs, deps, force: true })
        // His own target and a run-up's are priced off a fresh quote; the delta's alone off the spot it was sized against.
        const toolSpot = parsed.runup || parsed.target ? null : parsed.delta?.spot ?? null
        const [spot, spy] = await Promise.all([toolSpot ? null : deps.price(sym), deps.price('SPY')])
        const doc = buildCatalystRead(parsed, { symbol: sym, spot: toolSpot ?? spot, spy, nowMs, source, context })
        try {
            await coll.insertOne({ ...doc })
        } catch (err) {
            if (err?.code === 11000) return { ok: false, reason: 'live_read' }
            throw err
        }
        logger.info(LOG, 'catalyst read stored', { symbol: sym, verdict: doc.verdict, status: doc.status, target: doc.target?.value ?? null, open_pct: doc.target?.open_pct ?? null })
        return { ok: true, doc: stripId(doc) }
    } catch (err) {
        logger.error(LOG, 'catalyst read not stored', err)
        return { ok: false, reason: 'save_failed', detail: err.message }
    }
}

/** The reads for the Hotlist and the API: the active ones, and those settled in the last `days`. */
async function listReads({ days = 14, deps = _deps } = {}) {
    const coll = await _coll(deps)
    const since = new Date(deps.now() - days * DAY_MS).toISOString()
    const rows = await coll.find({ $or: [{ status: { $in: LIVE } }, { updated_at: { $gte: since } }] }).sort({ set_at: -1 }).limit(200).toArray()
    return rows.map(stripId)
}

/** The name's live read (active, its window still running), or null. */
async function liveRead(symbol, deps = _deps) {
    const coll = await _coll(deps)
    const row = await coll.findOne({ symbol: String(symbol ?? '').toUpperCase(), ..._liveQuery(deps.now()) })
    return row ? stripId(row) : null
}

/**
 * A live read as one line Mentor can relay (the Hotlist's week hand-off), or null without a target. Pure.
 * e.g. "Prometheus (credible, 0.7): target 54.20 (band 53.10–56.00), +4.5% from 51.87 by 2026-10-28 — out before the
 *       report 2026-10-29; his own number, the run-up yardstick +3.1%: <why>; company sound — <why>; kill: <…>"
 */
export function readFacts(read) {
    const t = read?.target
    if (!t || !_ok(t.value)) return null
    const pct = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
    const parts = [`Prometheus (${read.verdict}${Number.isFinite(read.confidence) ? `, ${read.confidence}` : ''}): target ${t.value.toFixed(2)}`
        + `${_ok(t.low) && _ok(t.high) ? ` (band ${t.low.toFixed(2)}–${t.high.toFixed(2)})` : ''}`
        + `${Number.isFinite(t.open_pct) && _ok(t.spot) ? `, ${pct(t.open_pct)} from ${t.spot.toFixed(2)}` : ''}`
        // The window's end as its ET session date — a UTC date reads a day late on an evening read (code review 2026-10-24).
        + `${Number.isFinite(Date.parse(read.valid_until)) ? ` by ${_etDay(Date.parse(read.valid_until))}` : ''}${read.exit_before ? ` — out before the report ${read.exit_before}` : ''}`]
    if (t.basis === 'prometheus') {
        const y = t.yardstick
        parts.push(`his own number${y && Number.isFinite(y.open_pct) ? `, the ${y.basis === 'run_up' ? 'run-up' : 'event'} yardstick ${pct(y.open_pct)}` : ''}${t.why ? `: ${t.why}` : ''}`)
        if (t.stretch) parts.push(`a STRETCH — ${t.stretch.times}× the larger of the options' implied move and the yardstick (${pct(t.stretch.ref_pct)}): say so if you lean on it`)
    } else parts.push(`the ${t.basis === 'run_up' ? 'run-up' : 'event'} yardstick (a read from before his own targets)`)
    if (read.company?.verdict) parts.push(`company ${read.company.verdict}${read.company.why ? ` — ${read.company.why}` : ''}`)
    if (read.kill?.length) parts.push(`kill: ${read.kill.slice(0, 2).join('; ')}`)
    return parts.join('; ')
}

/** Grade every active read → `{ graded, hit, expired, failed }`. Never throws: one bad quote or write does not stop the rest. */
async function gradeDue(deps = _deps) {
    const out = { graded: 0, hit: 0, expired: 0, failed: 0 }
    try {
        const coll = await _coll(deps)
        const live = await coll.find({ status: 'active' }).toArray()
        if (!live.length) return out
        const spy = await deps.price('SPY')
        const nowMs = deps.now()
        for (const read of live) {
            try {
                const status = await _gradeOne(coll, read, { spy, nowMs, deps })
                if (!status) continue
                out.graded++
                out[status]++
            } catch (err) {
                out.failed++
                logger.warn(LOG, 'one read not graded', { id: read.id, error: err.message })
            }
        }
        if (out.graded || out.failed) logger.info(LOG, 'catalyst reads graded', out)
    } catch (err) {
        logger.warn(LOG, 'grading failed', { error: err.message })
    }
    return out
}

export const catalystReadService = { saveRead, listReads, liveSymbols, liveRead, gradeDue }
