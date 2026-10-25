/**
 * The HOTLIST, as a read tool — today's names in play from the DailyScreener's boards
 * (docs/design/daily-names.md §8), so Axl can say what is on it when it opens the list (Roy,
 * 2026-10-22: "open it + a one-line summary").
 *
 * UNBOUND — no userId. The boards are a broadcast built once for everyone; there is nothing per user
 * to read, and a handler that cannot see a user cannot leak one into it.
 *
 * READ-ONLY. It reports the board — the run-up names with their reasons (the overnight week board, hotlist.week, since
 * 2026-10-25), and on an older day the checkpoints' status, room and Argus's read — and never turns it into advice. No
 * grade is shown (2026-10-24).
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
    get_hotlist: `Today's HOTLIST — THIS WEEK's run-up names, built overnight after the close (the day-trade boards were archived 2026-10-25), long side only. The rule: a company reporting in six sessions whose last three reports all beat the estimate, while SPY is over its 200-day — bought at the next open, out at the close before the report; every qualifying name is listed equally (a small, fixed daily budget split across them, not a ranking). For each name: its report date, the rule's reason, and the price at the close before the list (not live). Prometheus reads every name and sets a catalyst target — that read, not the list, is the verdict. When SPY is under its 200-day the list is empty and says so. Older days may still show the archived day boards' names and Argus's picks. Use it to say what is on the hotlist in a line or two; never present a name as a reason a stock will rise.`,
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
    if (!today?.day) return 'No hotlist yet — the screener has published no board. On trading days the week list is built overnight, after the close.'
    // The week board says why it is empty when the market gate is shut (hotlist.week: SPY under its 200-day).
    if (!list.length) return `Hotlist for ${today.day}: no names${today.latest?.closed ? ` — ${today.latest.closed}` : ' on the list'}.`
    const counts = Object.keys(STATUS_WORDS).map(s => [s, list.filter(r => r.status === s).length]).filter(([, n]) => n)
    const lines = [
        `Hotlist for ${today.day} — ${list.length} name${list.length === 1 ? '' : 's'} (${counts.map(([s, n]) => `${n} ${STATUS_WORDS[s]}`).join(', ')}). ${today.latest?.checkpoint === 'overnight' ? 'The run-up rule; prices at the close before the list' : "Prices as of each name's checkpoint"}, not live.`,
    ]
    const latest = today.latest
    if (latest?.argus?.summary) lines.push(`Argus on the ${latest.checkpoint} board: ${latest.argus.summary}`)
    // SPY's 200-day could not be checked tonight (hotlist.week `market.gate`): listed as if open — say so.
    if (latest?.market?.gate === 'unknown') lines.push("SPY's 200-day could not be checked for this list — it is listed as if the market gate were open.")
    for (const r of list.slice(0, Math.min(MAX_LIMIT, Math.max(1, limit)))) {
        const best = _best(r)
        const room = best?.[1]?.range?.open_sky ? 'open sky' : best?.[1]?.range ? `${_f(best[1].range.pct, 1)}% room` : null
        const head = [
            `${r.symbol}${r.name ? ` (${r.name})` : ''}`,
            STATUS_WORDS[r.status] ?? r.status ?? '',
            // No horizon carries a grade (2026-10-24) — the horizon and its room.
            best ? `${COLUMN_WORDS[best[0]] ?? best[0]}${room ? `, ${room}` : ''}` : null,
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
