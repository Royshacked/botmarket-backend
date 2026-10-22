/**
 * The HOTLIST, as a read tool — today's names in play from the DailyScreener's boards
 * (docs/design/daily-names.md §8), so Axl can say what is on it when it opens the list (Roy,
 * 2026-10-22: "open it + a one-line summary").
 *
 * UNBOUND — no userId. The boards are a broadcast built once for everyone; there is nothing per user
 * to read, and a handler that cannot see a user cannot leak one into it.
 *
 * READ-ONLY. It reports the board — status, best grade, the reason, Argus's read — and never turns a
 * grade into advice: free range is room, not a target, and the grades are unverified until the
 * outcome log says otherwise.
 */

import { makeToolHandler } from '../agentUtils.js'
import { todayHotlist } from '../hotlist.service.js'

const LOG = '[hotlist.tools]'
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30

const STATUS_WORDS = { in_play: 'in play', building: 'building', setting_up: 'setting up' }
const COLUMN_WORDS = { open: 'the open', mid: 'mid-day', eod: 'into the close', tomorrow: 'tomorrow', week: 'this week' }
const GRADE_RANK = { A: 3, B: 2, C: 1 }

export const HOTLIST_TOOL_SPEC = {
    get_hotlist: `Today's HOTLIST — the screener's names in play, from the day's checkpoint boards (08:00 and 09:20 ET pre-market, then 10:30, 14:30, 15:30), long side only. For each name: its status (IN PLAY now; BUILDING — money arriving; SETTING UP — quiet, with a known date ahead, usually earnings, a run-up to be out of before the report), its best horizon and grade (A/B/C by free range — the room to the next level overhead, NOT a target), the reason, the price as of its checkpoint (not live), and Argus's pick or avoid where he made one. Also the counts per status and Argus's read of the latest board. Use it to say what is on the hotlist in a line or two; the grades are unverified until enough outcomes are logged, so never present one as a reason a stock will rise.`,
}

const _f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : null)

/** The best graded cell of a day-list row: `[column, cell]`, or null. Pure. */
function _best(row) {
    const graded = Object.entries(row?.cells ?? {}).filter(([, c]) => c?.grade)
    if (row?.pick?.column && row.cells?.[row.pick.column]?.grade) return [row.pick.column, row.cells[row.pick.column]]
    graded.sort(([, a], [, b]) => (GRADE_RANK[b.grade] - GRADE_RANK[a.grade]) || ((b.range?.atr_mult ?? 0) - (a.range?.atr_mult ?? 0)))
    return graded[0] ?? null
}

/** Today's hotlist → LLM-ready text. Pure — exported for testing. */
export function formatHotlist(today, limit = DEFAULT_LIMIT) {
    const list = today?.day_list ?? []
    if (!today?.day) return 'No hotlist yet — the screener has published no board. On trading days it publishes at 08:00 and 09:20 ET, then 10:30, 14:30 and 15:30.'
    if (!list.length) return `Hotlist for ${today.day}: no names in play on any board yet.`
    const counts = Object.keys(STATUS_WORDS).map(s => [s, list.filter(r => r.status === s).length]).filter(([, n]) => n)
    const lines = [
        `Hotlist for ${today.day} — ${list.length} name${list.length === 1 ? '' : 's'} (${counts.map(([s, n]) => `${n} ${STATUS_WORDS[s]}`).join(', ')}). Grades unverified; prices as of each name's checkpoint, not live.`,
    ]
    const latest = today.latest
    if (latest?.argus?.summary) lines.push(`Argus on the ${latest.checkpoint} board: ${latest.argus.summary}`)
    for (const r of list.slice(0, Math.min(MAX_LIMIT, Math.max(1, limit)))) {
        const best = _best(r)
        const room = best?.[1]?.range?.open_sky ? 'open sky' : best?.[1]?.range ? `${_f(best[1].range.pct, 1)}% room` : null
        const head = [
            `${r.symbol}${r.name ? ` (${r.name})` : ''}`,
            STATUS_WORDS[r.status] ?? r.status ?? '',
            best ? `${COLUMN_WORDS[best[0]] ?? best[0]} ${best[1].grade}${room ? `, ${room}` : ''}` : null,
            Number.isFinite(r.price) ? `$${_f(r.price)}${Number.isFinite(r.gap_pct) ? ` (${r.gap_pct > 0 ? '+' : ''}${_f(r.gap_pct, 1)}%)` : ''}` : null,
            r.pick ? `ARGUS PICK #${r.pick.rank}` : r.avoid ? 'Argus: avoid' : null,
        ].filter(Boolean).join(' · ')
        const why = Array.isArray(best?.[1]?.why) && best[1].why.length ? best[1].why.join('; ') : null
        lines.push(`  ${head}${why ? `\n      ${why}` : ''}${r.pick?.why ? `\n      Argus: ${r.pick.why}` : r.avoid ? `\n      Argus (avoid): ${r.avoid}` : ''}`)
    }
    if (list.length > limit) lines.push(`  …and ${list.length - limit} more on the list.`)
    return lines.join('\n')
}

/** The hotlist tool handler. Unbound — see the header. */
export function makeHotlistHandlers({ read = () => todayHotlist() } = {}) {
    return {
        get_hotlist: makeToolHandler('get_hotlist',
            async ({ limit } = {}) => formatHotlist(await read(), Number.isFinite(limit) ? limit : DEFAULT_LIMIT),
            (err) => `Could not read today's hotlist: ${err.message}`, LOG),
    }
}
