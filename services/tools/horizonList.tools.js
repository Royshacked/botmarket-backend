/**
 * ARGUS'S LIST — the Hotlist's names for one horizon, the only place he picks from (docs/design/argus-rework.md §3.1;
 * Roy, 2026-11-11: "Argus is the picker for different horizons"). He no longer screens the market:
 *
 *   intraday / day     → today's latest day board (§3.3, hotlist.day — 09:20 / 10:30 / 14:30 ET): the names in play,
 *                        no grade, no direction; before the first board, says when the next is and lists nothing
 *   short term swing   → This week (the run-up rule, hotlist.week; read through todayHotlist + formatHotlist, Axl's
 *                        hotlist text — one formatter)
 *   swing / long term  → the house's Swing / Long term lists (houseBook: on the list, live, rated buy or strong buy),
 *                        with Prometheus's target and Argus's timing read (bookTiming, through houseBook's own deps)
 *
 * The handler hands every name it listed to `onNames`, so the agent can refuse a pick that was not on a list it was
 * shown (scanner.agent.service — code holds him to the list, the prompt only asks). A pick on a later turn is checked
 * against `houseListNames` instead (the history keeps no tool results).
 *
 * UNBOUND — no userId: the lists are the house's, the same for everyone. READ-ONLY.
 */

import { makeToolHandler } from '../agentUtils.js'
import { todayHotlist } from '../hotlist.service.js'
import { houseBook } from '../houseBook.service.js'
import { formatHotlist } from './hotlist.tools.js'
import { todayBoards, nextCheckpoint, dayLine, headlineWhen, CHECKPOINT_WORDS } from '../hotlist.day.js'
// The day-board line is hotlist.day's (one formatter: Argus's list here, Mentor's hand-off in hotlist.service).
export { dayLine, headlineWhen }
import { TRADE_HORIZONS } from '../entity/vocabulary.js'

const LOG = '[horizonList.tools]'
/** The most names one list hands Argus — the whole This week board and the long end of a book fit. */
export const MAX_NAMES = 30
const BUY = new Set(['buy', 'strong_buy'])
const BOOK_OF = Object.freeze({ swing: 'swing', 'long term': 'long_term' })

export const HORIZON_LIST_TOOL_SPEC = {
    get_horizon_list: `The house's list for a HORIZON — the ONLY names you may pick from. \`horizon\`: "intraday" or "day" (today's latest day board — the names in play at 09:20, 10:30 or 14:30 ET, with why and their freshest headline; in play means moving up so far, not a prediction of where it goes next),"short term swing" (This week: the run-up rule's names, each read by Prometheus), "swing" or "long term" (the house's Swing / Long term lists: Prometheus's Buys with his target, and the timing read — now, or wait for what). A name that is not in the answer is not a pick. An empty list says why; say that to the user and give no pick.`,
}

const _f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : null)
const _words = (s) => String(s ?? '').replace(/_/g, ' ')

/** "swing" · "Long-Term" · "short_term_swing" → a TRADE_HORIZONS value, or null. Pure. */
export function normalizeHorizon(v) {
    const s = String(v ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
    return TRADE_HORIZONS.includes(s) ? s : null
}

/** One book row → one line. Pure. */
export function bookLine(r) {
    const t = r.timing
    const timing = t?.verdict === 'now' ? 'timing: NOW'
        : t?.verdict === 'wait' ? `timing: WAIT${t.wait_for ? ` for ${t.wait_for}` : ''}` : 'timing: no read yet'
    return [
        `${r.symbol}${r.name ? ` (${r.name})` : ''}`,
        r.industry ?? null,
        `Prometheus ${_words(r.rating)}${r.conviction?.level ? `, ${r.conviction.level} conviction` : ''}`,
        Number.isFinite(r.price) && Number.isFinite(r.target)
            ? `$${_f(r.price)} → $${_f(r.target)}${Number.isFinite(r.upside_pct) ? ` (${r.upside_pct > 0 ? '+' : ''}${_f(r.upside_pct, 1)}%)` : ''}${r.target_date ? ` by ${r.target_date}` : ''}`
            : null,
        timing,
    ].filter(Boolean).join(' · ')
}

/** The book rows Argus may pick from: on the list, live, a Buy. Pure. */
export function pickableRows(rows) {
    return (rows ?? []).filter(r => r.list === 'on' && r.state === 'live' && BUY.has(r.rating))
}

/** A book's pickable rows → `{ text, names }`. Pure. */
export function formatBookList(horizon, rows) {
    const list = pickableRows(rows).slice(0, MAX_NAMES)
    if (!list.length) return { text: `The house's ${horizon} list has no Buys on it right now — nothing to pick for ${horizon}.`, names: [] }
    return {
        text: [`The house's ${horizon} list — ${list.length} Buy${list.length === 1 ? '' : 's'}, prices at the last close (not live):`,
            ...list.map(r => `  ${bookLine(r)}`)].join('\n'),
        names: list.map(r => r.symbol),
    }
}

/** Today's This week board → `{ text, names }`. Pure. Its text is Axl's hotlist text (one formatter). */
export function formatWeekList(today) {
    const rows = (today?.day_list ?? []).slice(0, MAX_NAMES)
    return { text: formatHotlist(today, MAX_NAMES), names: rows.map(r => r.symbol).filter(Boolean) }
}

const _hhmmEt = (ms) => (Number.isFinite(ms)
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)) : null)

/** When a board's quotes were taken, "09:20" or "09:20–09:25" (ET). Pure. A board takes minutes, so one time would lie. */
export function quotedSpan(rows) {
    const at = (rows ?? []).map(r => r.quoted_at).filter(Number.isFinite)
    if (!at.length) return null
    const [a, b] = [_hhmmEt(Math.min(...at)), _hhmmEt(Math.max(...at))]
    return a === b ? a : `${a}–${b}`
}

/**
 * Today's latest day board → `{ text, names }`. Pure. `boards` newest first (todayBoards); `next` the next board's time
 * (nextCheckpoint) or null. The in-play rules are LONG-SIDE (a gap up, above the open, the top of the day's range), so the
 * board lists names moving UP so far — and predicts nothing about where they go next; the text says both.
 */
export function formatDayList(boards, next) {
    const b = boards?.[0]
    if (!b) {
        return { text: `No day board yet today${next ? ` — the next is at ${next} ET` : ' — the boards run 09:20, 10:30 and 14:30 ET on trading days'}. There is no intraday list to pick from right now: say so; no pick.`, names: [] }
    }
    const rows = (b.rows ?? []).slice(0, MAX_NAMES)
    const when = CHECKPOINT_WORDS[b.checkpoint] ?? `${b.checkpoint} board`
    if (!rows.length) return { text: `The ${when} has no names in play${b.status === 'partial' ? ' (it stopped early, rate-limited)' : ''} — nothing to pick for intraday. Say so; no pick.`, names: [] }
    return {
        text: [`The ${when} — ${rows.length} name${rows.length === 1 ? '' : 's'} in play, quoted ${quotedSpan(rows) ?? _hhmmEt(b.finished_at) ?? 'at the board'} ET (not live)${b.status === 'partial' ? ', a partial board' : ''}. In play means moving UP so far (a gap up, above the open, near the day's high); the board has no grade and does not predict where a name goes next.`,
            ...rows.map(r => `  ${dayLine(r, b.day ?? null)}`)].join('\n'),
        names: rows.map(r => r.symbol),
    }
}

/** The horizon's list → `{ text, names }`. Exported for tests through the handler's deps. */
async function _list(horizon, deps) {
    if (horizon === 'intraday' || horizon === 'day') return formatDayList(await deps.dayBoards(), nextCheckpoint(deps.now()))
    if (horizon === 'short term swing') return formatWeekList(await deps.week())
    const book = BOOK_OF[horizon]
    return formatBookList(horizon, (await deps.book())?.[book])
}

/**
 * The handler. `onNames(names)` gets every name a call listed (the agent's pick gate). `deps` — test seams.
 */
export function makeHorizonListHandlers({ onNames = () => {}, deps = {} } = {}) {
    const d = _withDeps(deps)
    return {
        get_horizon_list: makeToolHandler('get_horizon_list', async ({ horizon } = {}) => {
            const h = normalizeHorizon(horizon)
            if (!h) return `Pass \`horizon\` — one of: ${TRADE_HORIZONS.join(', ')}.`
            const { text, names } = await _list(h, d)
            onNames(names)
            return text
        }, (err, args) => `Could not read the ${normalizeHorizon(args?.horizon) ?? ''} list: ${err.message} — say so; no pick.`, LOG),
    }
}

/**
 * Every name on the house's lists today, all horizons, upper-cased — the pick gate's second look. A chat's history
 * keeps text only, so a pick made on a later turn ("another one") from a list read on an earlier turn was never
 * "shown this turn"; the agent checks it here before dropping it. The same reads and the same caps as the tool, so a
 * name passes only if the tool would list it. The day boards list nothing yet. Throws when a read fails (the caller
 * decides).
 */
export async function houseListNames(deps = {}) {
    const d = _withDeps(deps)
    const [week, book, days] = await Promise.all([d.week(), d.book(), d.dayBoards()])
    return new Set([
        // Every board of today, not just the latest: "another one" may come from the 09:20 list after 10:30 is out.
        ...(days ?? []).flatMap(b => (b.rows ?? []).slice(0, MAX_NAMES).map(r => r.symbol)),
        ...formatWeekList(week).names,
        ...formatBookList('swing', book?.swing).names,
        ...formatBookList('long term', book?.long_term).names,
    ].map(n => String(n).toUpperCase()))
}

/** The list reads, with test seams. */
function _withDeps(deps = {}) {
    return { week: () => todayHotlist(), book: () => houseBook(), dayBoards: () => todayBoards(), now: () => Date.now(), ...deps }
}
