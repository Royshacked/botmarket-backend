// THE HOUSE'S BOOK — the Hotlist's Swing and Long term lists (Roy, 2026-10-24: "in hotlist — what about longer swings
// and long-term names?"). The Hotlist's own columns stop at This week; the longer horizons are Prometheus's COVERAGE —
// one live thesis per name, with a price target dated 3 to 24 months out — split by the target's horizon the way the
// research run books it (researchRun BOOK_PT_HORIZONS): 3m / 6m are SWING, 12m / 18m / 24m LONG TERM.
//
// Each row says where the name came from: the weekly chain (Pythia's verdict on an industry or theme → Argus's pick →
// Prometheus, house-research-chain.md) — read back from its research_queue row, the only place that context lives — or
// the desk (any other coverage). And whether it is working: the move since the target was set, against SPY's over the
// same days, and how far it has come toward the target. Hit / broken are the coverage monitor's (status); a target
// date that passed without a hit is `expired`.
//
// PRICES WITHOUT A BURST. Today's price is the screener's overnight close (daily_screener_stats — the whole universe,
// already read), never a quote per name. The price on the day the target was set is read once per (symbol, set_at)
// from daily bars and kept in `house_book_marks` — coverage documents are not touched, and a target re-set on a
// revision has a new set_at, so it is read again. The reads happen in the BACKGROUND, at most MARKS_PER_READ per open
// (one fill at a time): the list answers at once with what is kept, and the next open has the rest. A name outside the
// screener's universe (no overnight close) gets its last daily close the same way, kept in memory for an hour.

import { getDb } from '../providers/mongodb.provider.js'
import { COLLECTION as COVERAGE } from '../api/analyst/coverage.service.js'
import { COLLECTION as QUEUE } from './researchQueue.service.js'
import { COLLECTION as STATS } from './dailyScreener.service.js'
import { getTickerAggregates } from '../providers/candles.provider.js'
import { fetchLastPrice } from './lastPrice.service.js'
import { logger } from './logger.service.js'

const LOG = '[houseBook]'
export const MARKS = 'house_book_marks'
/** The two books and the target horizons each holds (researchRun BOOK_PT_HORIZONS: swing → 3m/6m, long term → 12m+). */
export const BOOKS = Object.freeze({ swing: ['3m', '6m'], long_term: ['12m', '18m', '24m'] })
/** Prices on a target's set day read per request — a first open of a big book fills over a few opens, not in a burst. */
export const MARKS_PER_READ = 12
/** A set-day price that could not be read is tried again after this long. */
const RETRY_MISS_MS = 86_400_000
/** A target must sit this far above its set-day price for "progress toward it" to mean anything. */
export const MIN_ROOM = 0.05
const DAY_MS = 86_400_000
const _r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
const _ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0
const _etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const _deps = {
    db:    () => getDb(),
    bars:  (s, from, to) => getTickerAggregates(s, { timeSpan: 'day', multiplier: 1, from, to }).catch(() => null),
    price: (s) => fetchLastPrice(s).catch(() => null),
    now:   () => Date.now(),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

/** Which book a coverage document belongs to, by its target's horizon — or null (no target, an unknown horizon). Pure. */
export function bookOf(cov) {
    const h = cov?.price_target?.horizon
    return Object.keys(BOOKS).find(b => BOOKS[b].includes(h)) ?? null
}

/** The close on (or last before) an ET date from ascending daily bars ({timestamp sec|ms, close}). Pure. */
export function closeOn(bars, day) {
    let px = null
    for (const b of bars ?? []) {
        const d = _etDay(b.timestamp > 1e12 ? b.timestamp : b.timestamp * 1000)
        if (d <= day && _ok(b.close)) px = b.close
        if (d > day) break
    }
    return px
}

/**
 * One coverage name as a book row. Pure. `close` — today's (the screener's), `mark` — `{ price, spy }` on the set day,
 * `spyNow`, `origin` — the chain's context or null, `today` — the ET date.
 */
export function bookRow(cov, { close = null, name = null, closeDay = null, mark = null, spyNow = null, origin = null, today }) {
    const pt = cov.price_target ?? {}
    const target = Number(pt.value)
    const at = _ok(mark?.price) ? mark.price : null
    const since = _ok(close) && at ? (close / at - 1) * 100 : null
    const spySince = _ok(spyNow) && _ok(mark?.spy) ? (spyNow / mark.spy - 1) * 100 : null
    const targetDay = pt.target_date ? String(pt.target_date).slice(0, 10) : null
    // How far from the set-day price toward the target — 0 at the start, 1 at the target (above 1: past it). Only for a
    // target meaningfully ABOVE that price: one at or under it (a hold, a sell, a target re-set below the market) or a
    // hair over it makes the ratio noise — FIX's 2% gap read as "-18.6× the way" in the first live read (2026-10-24).
    const progress = at && _ok(target) && target >= at * (1 + MIN_ROOM) && _ok(close) ? (close - at) / (target - at) : null
    const state = cov.status === 'target_hit' ? 'hit'
        : cov.status === 'thesis_broken' ? 'broken'
            : targetDay && targetDay < today ? 'expired' : 'live'
    return {
        symbol: cov.symbol, name, sector: cov.sector ?? null, industry: cov.industry ?? null,
        rating: cov.rating ?? null, status: cov.status ?? null, conviction: cov.conviction ?? null,
        price: _ok(close) ? _r2(close) : null, price_day: closeDay,
        target: _ok(target) ? _r2(target) : null,
        upside_pct: _ok(target) && _ok(close) ? _r2((target / close - 1) * 100) : null,
        horizon: pt.horizon ?? null, set_at: pt.set_at ?? null, target_date: targetDay,
        days_left: targetDay ? Math.round((Date.parse(`${targetDay}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS) : null,
        price_at_set: at ? _r2(at) : null,
        since_set_pct: _r2(since), spy_since_pct: _r2(spySince),
        vs_spy: since != null && spySince != null ? _r2(since - spySince) : null,
        progress: _r2(progress), state,
        origin: origin ? { source: 'pythia', subject: origin.subject ?? null, kind: origin.kind ?? null, verdict: origin.verdict ?? null,
            why: origin.argus?.why ?? null, caution: origin.argus?.caution ?? null } : { source: 'desk' },
    }
}

const _median = (xs) => {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
    if (!s.length) return null
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * A book's TRACK RECORD (Roy, 2026-10-24 — the short horizons' record, for the house's calls). Pure. Settled: hit /
 * broken / expired, and the hit rate over the settled; live: the median move since set and against SPY, and the share
 * beating SPY — each over the rows that have the numbers (`priced`).
 */
export function bookRecord(rows) {
    const count = (s) => rows.filter(r => r.state === s).length
    const hit = count('hit'), broken = count('broken'), expired = count('expired')
    const settled = hit + broken + expired
    const priced = rows.filter(r => r.vs_spy != null)
    return {
        n: rows.length, live: count('live'), hit, broken, expired,
        hit_rate: settled ? _r2((hit / settled) * 100) : null,
        priced: priced.length,
        median_since: _r2(_median(rows.map(r => r.since_set_pct))),
        median_vs_spy: _r2(_median(priced.map(r => r.vs_spy))),
        beat_spy: priced.length ? _r2((priced.filter(r => r.vs_spy > 0).length / priced.length) * 100) : null,
    }
}

/** The chain's context per symbol: its latest done `pythia` research_queue row's. */
async function _origins(db, symbols) {
    const rows = await db.collection(QUEUE).find({ source: 'pythia', status: 'done', symbol: { $in: symbols } },
        { projection: { _id: 0, symbol: 1, context: 1, updated_at: 1 } }).sort({ updated_at: -1 }).toArray()
    const by = new Map()
    for (const r of rows) if (!by.has(r.symbol)) by.set(r.symbol, r.context ?? {})
    return by
}

/** How far back the chain's picks are listed — the house scan keeps a passed name out this long (REJECTED_DAYS). */
export const PICK_DAYS = 56

/**
 * Where one of the chain's picks stands, from its research_queue row. Pure. `done` — Prometheus covered it (`covered`);
 * `rejected` — he passed, or it was already covered at the desk (`passed`, `already_covered` — the reason says which);
 * `queued` / `in_research` — `waiting`.
 */
export function pickState(row) {
    if (row?.status === 'done') return 'covered'
    if (row?.status === 'rejected') return row.reason === 'already_covered' ? 'already_covered' : 'passed'
    return 'waiting'
}

/**
 * THE CHAIN'S PICKS per book (Roy, 2026-10-24: "Pythia brings the industry → Argus brings names from it → Prometheus
 * analyses them and brings a thesis and PT — the survivors in the Hotlist"): every name Argus sent from a FOR SWING /
 * FOR LONG TERM verdict in the last PICK_DAYS, its latest row per symbol, newest first — what Pythia called, why Argus
 * chose it, and where Prometheus has it. Its coverage, when live, is the book's own row.
 */
async function _picks(db, nowMs) {
    const since = new Date(nowMs - PICK_DAYS * DAY_MS).toISOString()
    const rows = await db.collection(QUEUE).find({ source: 'pythia', created_at: { $gt: since } },
        { projection: { _id: 0, symbol: 1, status: 1, reason: 1, context: 1, created_at: 1, updated_at: 1 } }).sort({ created_at: -1 }).toArray()
    const out = { swing: [], long_term: [] }
    const seen = new Set()
    for (const r of rows) {
        const book = r.context?.verdict
        if (!out[book] || seen.has(`${book}|${r.symbol}`)) continue
        seen.add(`${book}|${r.symbol}`)
        out[book].push({
            symbol: r.symbol, state: pickState(r), reason: r.status === 'rejected' ? r.reason ?? null : null,
            subject: r.context?.subject ?? null, kind: r.context?.kind ?? null,
            why: r.context?.argus?.why ?? null, caution: r.context?.argus?.caution ?? null,
            at: r.created_at ?? null,
        })
    }
    return out
}

/** Today's closes (and names) from the screener's latest overnight pass. */
async function _closes(db, symbols) {
    const last = await db.collection(STATS).find({}, { projection: { _id: 0, day: 1 } }).sort({ day: -1 }).limit(1).next()
    if (!last?.day) return { day: null, by: new Map() }
    const rows = await db.collection(STATS).find({ day: last.day, symbol: { $in: symbols } },
        { projection: { _id: 0, symbol: 1, close: 1, name: 1 } }).toArray()
    return { day: last.day, by: new Map(rows.map(r => [r.symbol, r])) }
}

const keyOf = (c) => `${c.symbol}|${c.price_target?.set_at ?? ''}`
/** The set-day prices kept. */
async function _marks(db, covs) {
    const kept = await db.collection(MARKS).find({ key: { $in: covs.map(keyOf) } }, { projection: { _id: 0 } }).toArray()
    return new Map(kept.map(m => [m.key, m]))
}

let _filling = null
/**
 * Read (and keep) up to MARKS_PER_READ missing set-day prices, and the last close of names with none from the
 * screener — in the background, one fill at a time. Resolves when done (tests await it; the read does not).
 */
function _fill(db, covs, by, stale, deps) {
    if (_filling) return _filling
    _filling = _fillNow(db, covs, by, stale, deps)
        .catch(err => logger.warn(LOG, 'fill failed', { error: err.message }))
        .finally(() => { _filling = null })
    return _filling
}

/**
 * The last daily close of a name OUTSIDE the screener's universe, kept beside the set-day prices (`SYM|last`) — in the
 * database, not in memory: a restart or a deploy would otherwise open the book with those names unpriced (the live
 * drive, 2026-10-24). Shown at any age, with its own day; read again in the background once older than this.
 */
const LAST_TTL_MS = 60 * 60 * 1000
const lastKey = (sym) => `${sym}|last`

async function _lasts(db, symbols) {
    if (!symbols.length) return new Map()
    const kept = await db.collection(MARKS).find({ key: { $in: symbols.map(lastKey) } }, { projection: { _id: 0 } }).toArray()
    return new Map(kept.map(m => [m.symbol, m]))
}

async function _fillNow(db, covs, by, stale, deps) {
    const coll = db.collection(MARKS)
    const todayDay = _etDay(deps.now())
    for (const sym of stale.slice(0, MARKS_PER_READ)) {
        try {
            const t = deps.now()
            const bars = (await deps.bars(sym, t - 10 * DAY_MS, t)) ?? []
            const last = bars.filter(b => _ok(b.close)).at(-1)
            if (!last) continue
            const day = _etDay(last.timestamp > 1e12 ? last.timestamp : last.timestamp * 1000)
            await coll.updateOne({ key: lastKey(sym) }, { $set: { key: lastKey(sym), symbol: sym, close: _r2(last.close), day, at: t } }, { upsert: true })
        } catch (err) {
            logger.warn(LOG, 'last close not read', { symbol: sym, error: err.message })
        }
    }
    // A target set today has no close yet; the oldest missing first — they have the most to say.
    const due = (c) => { const m = by.get(keyOf(c)); return !m || (!_ok(m.price) && deps.now() - (m.tried_at ?? 0) > RETRY_MISS_MS) }
    const missing = covs.filter(c => c.price_target?.set_at && due(c) && _etDay(Date.parse(c.price_target.set_at)) < todayDay)
        .sort((a, b) => String(a.price_target.set_at).localeCompare(String(b.price_target.set_at))).slice(0, MARKS_PER_READ)
    if (!missing.length) return
    const spyCache = new Map()
    const spyOn = async (day) => {
        if (!spyCache.has(day)) {
            const t = Date.parse(`${day}T12:00:00Z`)
            spyCache.set(day, closeOn(await deps.bars('SPY', t - 7 * DAY_MS, t + DAY_MS), day))
        }
        return spyCache.get(day)
    }
    for (const c of missing) {
        try {
            const day = _etDay(Date.parse(c.price_target.set_at))
            const t = Date.parse(`${day}T12:00:00Z`)
            const price = closeOn(await deps.bars(c.symbol, t - 7 * DAY_MS, t + DAY_MS), day)
            // A day with no bar (a symbol FMP does not carry) is kept as a MISS, read again after RETRY_MISS_MS — not on
            // every open (the first test of this caught it re-reading one name per open, forever).
            const m = _ok(price)
                ? { key: keyOf(c), symbol: c.symbol, set_at: c.price_target.set_at, day, price: _r2(price), spy: _r2(await spyOn(day)), tried_at: deps.now() }
                : { key: keyOf(c), symbol: c.symbol, set_at: c.price_target.set_at, day, price: null, spy: null, tried_at: deps.now() }
            await coll.updateOne({ key: m.key }, { $set: m }, { upsert: true })
        } catch (err) {
            logger.warn(LOG, 'set-day price not read', { symbol: c.symbol, error: err.message })
        }
    }
}

let _indexed = false
/**
 * The book → `{ asof, today, swing: [rows], long_term: [rows], record: { swing, long_term }, picks: { swing, long_term } }`.
 * Live coverage only (retired and watchlist names are out); rows by book, the chain's names first, then the most upside.
 * `picks` — the chain's picks per book and where each stands (`_picks`), or null when they could not be read.
 */
export async function houseBook({ deps = _deps } = {}) {
    const db = await deps.db()
    if (!_indexed) { await db.collection(MARKS).createIndex({ key: 1 }, { unique: true }).catch(() => {}); _indexed = true }
    const covs = (await db.collection(COVERAGE).find({ status: { $in: ['active', 'target_hit', 'thesis_broken'] } },
        { projection: { _id: 0, symbol: 1, sector: 1, industry: 1, rating: 1, status: 1, conviction: 1, price_target: 1 } }).toArray())
        .filter(c => bookOf(c))
    const symbols = covs.map(c => c.symbol)
    const [closes, origins, marks, spyNow, picks] = await Promise.all([_closes(db, symbols), _origins(db, symbols), _marks(db, covs), deps.price('SPY'),
        _picks(db, deps.now()).catch(err => { logger.warn(LOG, 'the chain\'s picks were not read', { error: err.message }); return null })])
    const today = _etDay(deps.now())
    const noClose = symbols.filter(s => !closes.by.get(s)?.close)
    let lasts = await _lasts(db, noClose)
    const stale = noClose.filter(s => !lasts.get(s) || deps.now() - (lasts.get(s).at ?? 0) > LAST_TTL_MS)
    // In the background: this read answers with what is kept; the next has the rest.
    const filled = _fill(db, covs, marks, stale, deps)
    if (deps.awaitFill) { await filled; lasts = await _lasts(db, noClose) }
    // `picks` null = could not be read (the list says so), not "the chain sent nothing".
    const out = { asof: closes.day, today, swing: [], long_term: [], record: {}, picks }
    for (const c of covs) {
        const s = closes.by.get(c.symbol)
        const l = s?.close ? null : lasts.get(c.symbol)
        out[bookOf(c)].push(bookRow(c, { close: s?.close ?? l?.close ?? null, name: s?.name ?? null, closeDay: s?.close ? closes.day : l?.day ?? null,
            mark: marks.get(`${c.symbol}|${c.price_target?.set_at ?? ''}`) ?? null, spyNow, origin: origins.get(c.symbol) ?? null, today }))
    }
    const order = (a, b) => (a.origin.source === 'pythia' ? 0 : 1) - (b.origin.source === 'pythia' ? 0 : 1)
        || (b.upside_pct ?? -1e9) - (a.upside_pct ?? -1e9) || a.symbol.localeCompare(b.symbol)
    for (const b of Object.keys(BOOKS)) { out[b].sort(order); out.record[b] = bookRecord(out[b]) }
    return out
}

// ─── The hand-off to Mentor (Roy, 2026-10-24: "hand off to Mentor — tell Mentor the horizon") ───

/** The trade horizon each book hands Mentor (entity/vocabulary TRADE_HORIZONS). */
export const BOOK_HORIZON = Object.freeze({ swing: 'swing', long_term: 'long term' })

const _killText = (k) => (typeof k === 'string' ? k : k?.condition ?? k?.what ?? k?.note ?? null)
const _firstSentence = (t) => { const s = String(t ?? '').trim(); const m = s.match(/^.{20,400}?[.!?](\s|$)/); return (m ? m[0] : s.slice(0, 300)).trim() || null }

/**
 * What a book name's coverage says, as one line Mentor can relay. Pure. e.g. "Prometheus buy (medium conviction),
 * target 130.00 by 2027-03-01 (a 6m target), +30.0% from 100.00; from the weekly chain: Pythia's swing call on
 * Railroads".
 */
export function bookFacts(cov, { close = null, origin = null } = {}) {
    const pt = cov?.price_target ?? {}
    const target = Number(pt.value)
    const parts = [
        `Prometheus ${String(cov?.rating ?? 'unrated').replace('_', ' ')}${cov?.conviction?.level ? ` (${cov.conviction.level} conviction)` : ''}`,
        _ok(target) ? `target ${target.toFixed(2)}${pt.target_date ? ` by ${String(pt.target_date).slice(0, 10)}` : ''}${pt.horizon ? ` (a ${pt.horizon} target)` : ''}` : null,
        _ok(target) && _ok(close) ? `${(target / close - 1) * 100 > 0 ? '+' : ''}${((target / close - 1) * 100).toFixed(1)}% from ${close.toFixed(2)}` : null,
    ].filter(Boolean)
    const line = parts.join(', ')
    const from = origin ? `from the weekly chain: Pythia's ${origin.verdict === 'long_term' ? 'long-term' : origin.verdict ?? ''} call on ${origin.subject ?? 'an industry'}` : 'researched at the desk'
    return `${line}; ${from}`
}

/**
 * Resolve a book hand-off reference (scanSeed `book: { column, symbol }`) into the seed fields Mentor reads →
 * `{ book, horizon, book_facts, thesis, caution }`, or null when the name has no live coverage on a book's horizon. The
 * BOOK is the coverage's own (its target's horizon), not the request's column — a re-set target moves the name.
 */
export async function bookSeed(ref, deps = _deps) {
    if (!ref?.symbol) return null
    const db = await deps.db()
    const cov = await db.collection(COVERAGE).findOne({ symbol: ref.symbol, status: { $in: ['active', 'target_hit', 'thesis_broken'] } },
        { projection: { _id: 0, symbol: 1, rating: 1, conviction: 1, price_target: 1, thesis: 1, kill_criteria: 1 } })
    const book = bookOf(cov)
    if (!book) return null
    const [closes, origins, lasts] = await Promise.all([_closes(db, [cov.symbol]), _origins(db, [cov.symbol]), _lasts(db, [cov.symbol])])
    const origin = origins.get(cov.symbol) ?? null
    const kill = (Array.isArray(cov.kill_criteria) ? cov.kill_criteria : []).map(_killText).filter(Boolean)
    return {
        book,
        horizon: BOOK_HORIZON[book],
        // A name outside the screener's universe: the last close the list keeps for it (_lasts).
        book_facts: bookFacts(cov, { close: closes.by.get(cov.symbol)?.close ?? lasts.get(cov.symbol)?.close ?? null, origin }),
        thesis: origin?.argus?.why ?? _firstSentence(cov.thesis),
        caution: kill[0] ?? origin?.argus?.caution ?? null,
    }
}
