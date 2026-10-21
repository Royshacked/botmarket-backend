// The HOTLIST's read side (docs/design/daily-names.md §8, build phase 5): what the Floor's Hotlist
// row and the API read, and what a "Build with Mentor" hand-off is resolved into.
//
// The boards are written by dailyScreener.checkpoint and scored by hotlist.outcomes; nothing here
// writes. A hand-off from the board is a REFERENCE (scanSeed.util: board id + column + the ticker),
// and the facts Mentor is told come from the stored board — never from the request.

import { getDb } from '../providers/mongodb.provider.js'
import { BOARDS, outcomeSummary } from './hotlist.outcomes.js'
import { COLUMN_WORDS } from './hotlist.argus.js'

/** The trade horizon each column hands Mentor (entity/vocabulary TRADE_HORIZONS). */
export const COLUMN_HORIZON = Object.freeze({
    open: 'intraday', mid: 'intraday', eod: 'intraday', tomorrow: 'day', week: 'short term swing',
})

const _deps = { db: () => getDb(), summary: () => outcomeSummary() }
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

const _f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : null)

/**
 * The board's facts about one name in one column, as one line Mentor can relay. Pure.
 * e.g. "mid-session B — +10.14% gap, 3.39× volume; free range 2.09% (0.45× ATR) to 166.18;
 *       catalyst: drift, positive — 'SpaceX swings to profit…'; Argus: <why> Caution: <caution>"
 */
export function seedFacts(row, column) {
    const c = row?.cells?.[column]
    if (!c?.grade) return null
    const parts = [`${COLUMN_WORDS[column] ?? column} ${c.grade}`]
    const tape = [row.gap_pct != null ? `${row.gap_pct > 0 ? '+' : ''}${_f(row.gap_pct)}% gap` : null, row.rvol != null ? `${row.rvol}× volume` : null].filter(Boolean)
    if (tape.length) parts[0] += ` — ${tape.join(', ')}`
    parts.push(c.range?.open_sky ? 'open sky (no level overhead)' : `free range ${_f(c.range?.pct)}% (${_f(c.range?.atr_mult)}× ATR) to ${_f(c.range?.level)}`)
    if (row.catalyst?.material) parts.push(`catalyst: ${row.catalyst.type}, ${row.catalyst.surprise}${row.catalyst.headline ? ` — "${row.catalyst.headline}"` : ''}`)
    if (row.next_earnings) parts.push(`earnings ${row.next_earnings}`)
    if (row.fade_check) parts.push('flagged: a minor story under a big gap')
    return parts.join('; ')
}

/**
 * Resolve a hotlist hand-off reference into the seed fields Mentor reads. → `{ horizon, hotlist_facts,
 * thesis?, caution?, unverified }`, or null when the board, the row or a graded cell is not there
 * (a stale tab, a pruned board) — the seed then goes on as an ordinary one.
 */
export async function hotlistSeed(ref, deps = _deps) {
    if (!ref?.board || !ref?.column || !ref?.symbol) return null
    const db = await deps.db()
    const board = await db.collection(BOARDS).findOne({ id: ref.board })
    const row = board?.rows?.find(r => r.symbol === ref.symbol)
    const facts = seedFacts(row, ref.column)
    if (!facts) return null
    return {
        horizon:       COLUMN_HORIZON[ref.column] ?? null,
        hotlist_facts: facts,
        board_day:     board.day,
        checkpoint:    board.checkpoint,
        unverified:    (board.unverified_columns ?? [ref.column]).includes(ref.column),
        ...(row.pick ? { thesis: row.pick.why ?? null, caution: row.pick.caution ?? null } : {}),
    }
}

/**
 * Today's hotlist for the Floor and the API: the latest board (rows and all) and the day's
 * checkpoints as one-liners. `day` defaults to the latest day that has a board.
 */
export async function todayHotlist({ day = null, deps = _deps } = {}) {
    const db = await deps.db()
    const coll = db.collection(BOARDS)
    const done = { status: { $in: ['done', 'partial'] } }
    const latest = await coll.find({ ...done, ...(day ? { day } : {}) }).sort({ finished_at: -1 }).limit(1).next()
    if (!latest) return { day: day ?? null, latest: null, checkpoints: [] }
    const ofDay = await coll.find({ ...done, day: latest.day }, { projection: { id: 1, checkpoint: 1, finished_at: 1, status: 1, columns: 1, argus: 1, counts: 1 } })
        .sort({ finished_at: 1 }).toArray()
    return {
        day: latest.day,
        latest: _public(latest),
        checkpoints: ofDay.map(b => ({ id: b.id, checkpoint: b.checkpoint, status: b.status, columns: b.columns, finished_at: b.finished_at, rows: b.counts?.graded ?? null, argus: !!b.argus })),
    }
}

/** One board by id, or null. */
export async function boardById(id, deps = _deps) {
    const db = await deps.db()
    const b = await db.collection(BOARDS).findOne({ id: String(id) })
    return b && ['done', 'partial'].includes(b.status) ? _public(b) : null
}

/** The outcome log summarised — per column and grade, and which columns are verified. */
export async function hotlistOutcomes(deps = _deps) {
    return deps.summary()
}

/** What a client sees of a board: no Mongo id, no claim bookkeeping. Pure. */
function _public(b) {
    const { _id, started_at, scored, requests, ...rest } = b
    return rest
}
