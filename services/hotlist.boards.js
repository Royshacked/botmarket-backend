// The Hotlist's BOARDS, shared (2026-10-25: lifted out of dailyScreener.checkpoint when the day columns were archived —
// docs/design/hotlist-day-archive.md). What the live tree needs of the boards no matter who writes them: their indexes,
// the latest one, the ET session date they are keyed by, the "running" stale limit, and Argus's headline lines (the
// week replay's). The overnight week board (hotlist.week) is the only live writer now; the archived checkpoint pass
// (archive/services/dailyScreener.checkpoint.js) imports these back.

import { getDb } from '../providers/mongodb.provider.js'
import { BOARDS } from './hotlist.outcomes.js'

export { BOARDS }

const _deps = { db: () => getDb() }
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

export async function ensureHotlistBoardIndexes() {
    const db = await _deps.db()
    await db.collection(BOARDS).createIndex({ id: 1 }, { unique: true })
    await db.collection(BOARDS).createIndex({ day: 1 })
}

/** The latest board of a day (or of the latest day) — what the Floor's Hotlist reads (phase 6). */
export async function latestBoard({ day = null, deps = _deps } = {}) {
    const db = await deps.db()
    const q = { status: { $in: ['done', 'partial'] }, ...(day ? { day } : {}) }
    return db.collection(BOARDS).find(q).sort({ finished_at: -1 }).limit(1).next()
}

/** A `running` board older than this is a dead process's, not work — the Hotlist's "running" line reads it. */
export const BOARD_STALE_MS = 60 * 60 * 1000

const _ET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
/** `nowMs` in New York: its date, weekday and minute of the day. Pure. */
export function etNow(ms) {
    const p = Object.fromEntries(_ET.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
    return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, min: Number(p.hour) * 60 + Number(p.minute) }
}

/** The ET calendar date of `nowMs` (YYYY-MM-DD) — the session day the boards are keyed by. Pure. */
export const etDate = (nowMs) => etNow(nowMs).date

/** The headlines Argus reads per name — the latest few, with their times (2026-10-24: "Argus needs news"). */
export const NEWS_FOR_ARGUS = 3

/**
 * Rows as Argus reads them: each with its latest headlines (`news`, newest first, at most NEWS_FOR_ARGUS). For his
 * read only; not stored on a board. Pure.
 */
export function withNews(rows, headlines) {
    return (rows ?? []).map(r => {
        const list = [...(headlines?.get(r.symbol) ?? [])].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, NEWS_FOR_ARGUS)
        return list.length ? { ...r, news: list } : r
    })
}
