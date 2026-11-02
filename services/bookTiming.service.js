// THE TIMING READ — Argus on the Swing and Long term lists (Roy, 2026-11-02: the Hotlist's "Ask Argus" asked "is now a
// good time to buy it, and what would make it wrong?" by hand, one name at a time; "can it be automatic — part of the
// run?" — yes, re-read weekly, the same table for every user, and the button gone).
//
// Prometheus's thesis says WHAT the name is worth; nobody said WHEN. A Buy with a 6-month target can still be a name to
// wait on — stretched over its averages, a report three days out. Argus reads each Buy on the lists against its chart
// and answers one thing: NOW, or WAIT — for a price he names, or an event with its date — and what would make that call
// wrong. He does not re-judge the thesis or set a target; that is Prometheus's.
//
// WHICH NAMES. The rows ON a list (houseBook listOf: the chain sent it and Pythia still calls it), live (not hit, broken
// or expired), rated buy or strong buy — the long side the lists are. A desk-only name, a Hold, a Sell gets no read.
//
// WEEKLY. A read belongs to its ET week (Monday's date). It is DUE when the name has none for this week, or Prometheus
// re-set the target since (a new `set_at` — a new thesis to time). So the week's first tick reads the lists, a name the
// chain covers mid-week is read on the next tick, and nothing is re-read in between. The chart is the screener's
// overnight stats (daily_screener_stats) — already computed for the whole universe, no fetch per name.
//
// THE HOUSE'S. One read per name, stored by symbol (`book_timing_reads`), the same row for every user; the spend is
// booked to the house ledger (houseLedgerUserId) as monitor spend, like the chain's Argus. Batched — BATCH names a call,
// BATCHES_PER_RUN calls a run — and the run rides the screener's monitor (every CHECK_EVERY_MS at most), so the week's
// ~150 names land over a few ticks instead of one burst. A batch that fails, or a name the reply leaves out, is tried
// again after RETRY_MS — never every tick. BOOK_TIMING=false is the kill switch. Never throws.

import { getDb } from '../providers/mongodb.provider.js'
import { COLLECTION as COVERAGE } from '../api/analyst/coverage.service.js'
import { COLLECTION as STATS } from './dailyScreener.service.js'
import { techLine } from './hotlist.argus.js'
import { getHouseModels } from './houseModels.service.js'
import { oneShotText } from './oneShot.service.js'
import { DEFAULT_MODEL } from './llmModels.js'
import { calcCost, recordUsage } from './tokenUsage.service.js'
import { houseLedgerUserId } from '../api/user/user.model.js'
import { extractFirstJSON } from '../monitoring/parsers/llmReply.parser.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[bookTiming]'
export const COLLECTION = 'book_timing_reads'
export const VERDICTS = Object.freeze(['now', 'wait'])
/** The ratings that get a timing read — the lists are the long side. */
export const BUY_RATINGS = Object.freeze(['strong_buy', 'buy'])
/** Names per call, and calls per run (a run is one monitor tick). */
export const BATCH = 15
export const BATCHES_PER_RUN = 2
/** A failed or skipped name is tried again after this long — not every tick. */
export const RETRY_MS = 6 * 60 * 60 * 1000
/** The run is looked at no more often than this (the monitor ticks every 5 minutes). */
export const CHECK_EVERY_MS = 30 * 60 * 1000
const TEXT_CHARS = 240
const DAY_MS = 86_400_000

const _deps = {
    db:      () => getDb(),
    // Imported when used: houseBook reads these reads back (readsFor), so a static import would be a cycle.
    book:    async () => (await import('./houseBook.service.js')).houseBook(),
    enabled: () => config.bookTiming,
    send:    (args) => oneShotText(args),
    model:   async () => { try { return (await getHouseModels()).chatModel || DEFAULT_MODEL } catch { return DEFAULT_MODEL } },
    costOf:  (model, usage) => calcCost(model, usage),
    ledger:  () => houseLedgerUserId(),
    record:  (userId, model, usage) => recordUsage(userId, model, usage, 'bookTiming', { monitor: true }),
    now:     () => Date.now(),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

let _checkedAt = 0
let _active = false
const _triedAt = new Map()
/** Test seam. */
export function _reset() { _checkedAt = 0; _active = false; _triedAt.clear() }

const _r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
const _f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—')
const _etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

/** The ET week a moment belongs to → its Monday, YYYY-MM-DD. Pure. */
export function weekOf(ms) {
    const day = _etDay(ms)
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay()            // 0 Sunday … 6 Saturday
    return _etDay(Date.parse(`${day}T12:00:00Z`) - ((dow + 6) % 7) * DAY_MS)
}

/** The book rows a timing read is for: on a list, live, rated buy. Pure. `book` is houseBook()'s answer. */
export function readable(book) {
    return ['swing', 'long_term'].flatMap(b => (book?.[b] ?? [])
        .filter(r => r.list === 'on' && r.state === 'live' && BUY_RATINGS.includes(r.rating))
        .map(r => ({ ...r, book: b })))
}

/** The rows due a read this week: none stored for `week`, or the target re-set since the stored one. Pure. */
export function dueRows(rows, stored, week) {
    return rows.filter(r => {
        const s = stored.get(r.symbol)
        return !s || s.week !== week || (s.set_at ?? null) !== (r.set_at ?? null)
    })
}

const _killText = (k) => (typeof k === 'string' ? k : k?.condition ?? k?.what ?? k?.note ?? null)
const _firstSentence = (t) => { const s = String(t ?? '').trim(); const m = s.match(/^.{20,300}?[.!?](\s|$)/); return (m ? m[0] : s.slice(0, 240)).trim() || null }

/**
 * One name as Argus reads it — the thesis in a line, the chart in a line, its levels in dollars. Pure. `row` a book row,
 * `cov` its coverage ({ thesis, kill_criteria }), `stats` its overnight stats or null, `today` the ET date: a report
 * before it is not shown — the stats' date can lag a report already out, and Argus told a name to "wait for the report
 * on 2026-10-30" on 11-02 (the second live run).
 */
export function nameText(row, cov, stats, { today = null } = {}) {
    const thesis = [
        `Prometheus ${String(row.rating).replace('_', ' ')}${row.conviction?.level ? ` (${row.conviction.level} conviction)` : ''}`,
        Number.isFinite(row.target) ? `target ${_f(row.target)}${row.target_date ? ` by ${row.target_date}` : ''}` : null,
        Number.isFinite(row.upside_pct) ? `${row.upside_pct >= 0 ? '+' : ''}${_f(row.upside_pct, 1)}% from here` : null,
    ].filter(Boolean).join(', ')
    const why = row.origin?.why ?? _firstSentence(cov?.thesis)
    const kill = (Array.isArray(cov?.kill_criteria) ? cov.kill_criteria : []).map(_killText).find(Boolean) ?? row.origin?.caution ?? null
    const tech = techLine(stats)
    const levels = stats?.close ? [
        `close ${_f(stats.close)}`, `20d avg ${_f(stats.sma20)}`, `50d avg ${_f(stats.sma50)}`,
        `20d range ${_f(stats.low20)}–${_f(stats.high20)}`, `52w range ${_f(stats.low52w)}–${_f(stats.high52w)}`,
        Number.isFinite(stats.atr_pct) ? `ATR ${_f(stats.atr_pct, 1)}%` : null,
    ].filter(Boolean).join(' · ') : 'no chart today'
    const ahead = stats?.next_earnings && (!today || String(stats.next_earnings).slice(0, 10) >= today)
    const earnings = ahead ? ` | next report ${stats.next_earnings}` : ''
    return `${row.symbol}${row.name ? ` (${row.name})` : ''} — ${row.book === 'swing' ? 'SWING' : 'LONG TERM'} | ${thesis}`
        + `${why ? ` | thesis: ${why}` : ''}${kill ? ` | wrong if: ${kill}` : ''}`
        + ` | chart: ${tech ?? '—'} | levels: ${levels}${earnings}`
}

export const SYSTEM = `You are Argus, the scanning desk. Prometheus, the research desk, has a BUY thesis and a price target on each name below — the house's Swing list (a trade over weeks to months) and Long term list (a holding over years). The thesis is his and it stands; do not re-judge it. Your job is the one question it leaves open: is NOW a good time to buy, or is it better to WAIT — and for what.

Each name: its book, Prometheus's rating, target and the upside from here, his thesis in a line and what would break it; then its CHART from last night's close — the trend against its 20- and 50-day averages, the 5- and 20-session return with relative strength against SPY, volume against its 50-day, where it sits in its 52-week range — its LEVELS in dollars, and its next report when one is scheduled.

THE DEFAULT IS NOW. Prometheus has already found each name worth buying at this price; waiting has a cost — the move can leave without you. Say WAIT only for a concrete reason you can name and time: a level within reach that a stock this volatile tags in ordinary trading (inside its 20-day range, a couple of ATRs away), or a dated event — a report inside the next two weeks. "Up a lot lately" or "near the 52-week high" is not a reason on its own: strength into a high is often the trade. A list where every name says wait tells the reader nothing — if you cannot point to the level or the date, the answer is now.

Read the chart against the horizon. A swing name is about the next weeks: parabolic — far above its 20-day average after a vertical run — or a report days away argues for waiting; a base, a pullback that held, a breakout on volume, a trend riding its averages argue for now. A long-term name forgives more still: wait only for a parabolic run or a report close by on a name that moves hard on reports.

Answer for EVERY name:
- "verdict": "now" or "wait".
- "wait_for": when you say wait — the price you would buy at (one of its levels, in dollars: "a pullback to the 50-day near 41.20") or the event and its date ("the report on 2026-11-06"). Empty for now.
- "wrong_if": one sentence — what in the price would make your timing call wrong (for now: the level whose loss says you were early; for wait: the move that says the wait cost the trade).
- "why": one sentence — what in the chart decides it.

No stops or targets of your own; the target is Prometheus's. Output ONLY a JSON object, no prose:
{"reads":[{"symbol":"ABC","verdict":"wait","wait_for":"...","wrong_if":"...","why":"..."}]}`

/** The model's reply held to the names asked: a known symbol, a verdict of VERDICTS, text trimmed. → Map symbol → read. Pure. */
export function normalizeReads(raw, symbols) {
    const asked = new Set(symbols)
    const txt = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, TEXT_CHARS) : null)
    const out = new Map()
    for (const r of Array.isArray(raw?.reads) ? raw.reads : []) {
        const symbol = String(r?.symbol ?? '').toUpperCase()
        const verdict = String(r?.verdict ?? '').toLowerCase()
        if (!asked.has(symbol) || out.has(symbol) || !VERDICTS.includes(verdict)) continue
        // A wait with nothing to wait for is not an answer the row can show. It reads after "Wait — for", so a capital
        // opening a sentence ("A pullback to…") is lowered; a name or ticker ("SPY", "Q3") keeps its case.
        const said = verdict === 'wait' ? txt(r.wait_for) : null
        const waitFor = said && /^[A-Z](?=[a-z]|\s[a-z])/.test(said) ? said[0].toLowerCase() + said.slice(1) : said
        if (verdict === 'wait' && !waitFor) continue
        out.set(symbol, { verdict, wait_for: waitFor, wrong_if: txt(r.wrong_if), why: txt(r.why) })
    }
    return out
}

async function _stored(db, symbols) {
    const docs = await db.collection(COLLECTION).find({ _id: { $in: symbols } }).toArray()
    return new Map(docs.map(d => [d._id, d]))
}

async function _readBatch(db, rows, { week, nowMs, deps }) {
    const symbols = rows.map(r => r.symbol)
    const [covs, statsDay] = await Promise.all([
        db.collection(COVERAGE).find({ symbol: { $in: symbols }, status: 'active' }, { projection: { _id: 0, symbol: 1, thesis: 1, kill_criteria: 1 } }).toArray(),
        db.collection(STATS).find({}, { projection: { _id: 0, day: 1 } }).sort({ day: -1 }).limit(1).next(),
    ])
    const stats = statsDay?.day
        ? await db.collection(STATS).find({ day: statsDay.day, symbol: { $in: symbols } }, { projection: { _id: 0, closes20: 0 } }).toArray()
        : []
    const covBy = new Map(covs.map(c => [c.symbol, c])), statsBy = new Map(stats.map(s => [s.symbol, s]))
    for (const s of symbols) _triedAt.set(s, nowMs)
    // A name with no chart tonight (outside the screener's universe, or no bar) is not read: timing is a chart question,
    // and without one the answer was "wait for a chart" (the first live run, 2026-11-02). Tried again after RETRY_MS.
    rows = rows.filter(r => statsBy.get(r.symbol)?.close)
    if (!rows.length) return { read: 0, cost: 0 }
    const userText = `NAMES (${rows.length}):\n${rows.map(r => nameText(r, covBy.get(r.symbol), statsBy.get(r.symbol), { today: _etDay(nowMs) })).join('\n')}`
    const model = await deps.model()
    const ledger = await Promise.resolve(deps.ledger()).catch(() => null)
    let cost = 0
    const onUsage = (usage) => {
        cost += Number(deps.costOf(model, usage)) || 0
        if (ledger) Promise.resolve(deps.record(ledger, model, usage)).catch(() => {})
    }
    let reads
    try {
        const text = await deps.send({ model, systemText: SYSTEM, userText, maxTokens: 6000, onUsage })
        reads = normalizeReads(extractFirstJSON(text), rows.map(r => r.symbol))
    } catch (err) {
        logger.warn(LOG, `batch of ${rows.length} not read — tried again in ${RETRY_MS / 3_600_000}h: ${err.message}`)
        return { read: 0, cost }
    }
    const at = new Date(nowMs).toISOString()
    const ops = rows.filter(r => reads.has(r.symbol)).map(r => ({
        // Every field set: one read per symbol, this one replacing the last.
        updateOne: {
            filter: { _id: r.symbol },
            update: { $set: {
                symbol: r.symbol, book: r.book, week, set_at: r.set_at ?? null, ...reads.get(r.symbol),
                price: _r2(statsBy.get(r.symbol)?.close ?? r.price ?? null), price_day: statsDay?.day ?? null, read_at: at, model,
            } },
            upsert: true,
        },
    }))
    if (ops.length) await db.collection(COLLECTION).bulkWrite(ops)
    if (ops.length < rows.length) logger.warn(LOG, `${rows.length - ops.length} of ${rows.length} names had no usable read — tried again in ${RETRY_MS / 3_600_000}h`)
    return { read: ops.length, cost }
}

/**
 * The week's timing reads, as far as one run goes. → `{ outcome: 'off' | 'not_due' | 'busy' | 'done' | 'error', ... }`.
 * Due names in book order, BATCH a call, BATCHES_PER_RUN calls; the rest wait for the next tick. Never throws.
 */
export async function runTiming({ force = false, deps = _deps } = {}) {
    if (!deps.enabled()) return { outcome: 'off' }
    const nowMs = deps.now()
    if (!force && nowMs - _checkedAt < CHECK_EVERY_MS) return { outcome: 'not_due' }
    if (_active) return { outcome: 'busy' }
    _active = true
    _checkedAt = nowMs
    try {
        const db = await deps.db()
        const rows = readable(await deps.book())
        const week = weekOf(nowMs)
        const stored = await _stored(db, rows.map(r => r.symbol))
        const due = dueRows(rows, stored, week).filter(r => nowMs - (_triedAt.get(r.symbol) ?? 0) >= RETRY_MS)
        if (!due.length) return { outcome: 'done', week, due: 0, read: 0 }
        let read = 0, cost = 0
        for (let i = 0; i < BATCHES_PER_RUN && i * BATCH < due.length; i++) {
            const r = await _readBatch(db, due.slice(i * BATCH, (i + 1) * BATCH), { week, nowMs, deps })
            read += r.read
            cost += r.cost
        }
        logger.info(LOG, `week ${week}: ${read} read, ${Math.max(0, due.length - read)} still due, $${cost.toFixed(4)}`)
        return { outcome: 'done', week, due: due.length, read, cost: Math.round(cost * 1e4) / 1e4 }
    } catch (err) {
        logger.warn(LOG, `run failed: ${err.message}`)
        return { outcome: 'error', error: err.message }
    } finally {
        _active = false
    }
}

/** The stored reads for these symbols → Map symbol → `{ verdict, wait_for, wrong_if, why, week, read_at, price }`. */
export async function readsFor(symbols, deps = _deps) {
    if (!symbols?.length) return new Map()
    const db = await deps.db()
    const docs = await db.collection(COLLECTION).find({ _id: { $in: symbols } },
        { projection: { _id: 0, symbol: 1, set_at: 1, verdict: 1, wait_for: 1, wrong_if: 1, why: 1, week: 1, read_at: 1, price: 1 } }).toArray()
    return new Map(docs.map(d => [d.symbol, d]))
}

export const bookTimingService = { runTiming, readsFor }
