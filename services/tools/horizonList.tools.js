/**
 * ARGUS'S LIST — the Hotlist's names for one horizon, the only place he picks from (docs/design/argus-rework.md §3.1;
 * Roy, 2026-11-11: "Argus is the picker for different horizons"). He no longer screens the market:
 *
 *   intraday / day     → the day boards (§3.3) — not running yet: says so, lists nothing
 *   short term swing   → This week (the run-up rule, hotlist.week; read through todayHotlist + formatHotlist, Axl's
 *                        hotlist text — one formatter)
 *   swing / long term  → the house's Swing / Long term lists (houseBook: on the list, live, rated buy or strong buy),
 *                        with Prometheus's target and Argus's timing read (bookTiming, through houseBook's own deps)
 *
 * The handler hands every name it listed to `onNames`, so the agent can refuse a pick that was not on a list it was
 * shown (scanner.agent.service — code holds him to the list, the prompt only asks).
 *
 * UNBOUND — no userId: the lists are the house's, the same for everyone. READ-ONLY.
 */

import { makeToolHandler } from '../agentUtils.js'
import { todayHotlist } from '../hotlist.service.js'
import { houseBook } from '../houseBook.service.js'
import { formatHotlist } from './hotlist.tools.js'
import { TRADE_HORIZONS } from '../entity/vocabulary.js'

const LOG = '[horizonList.tools]'
/** The most names one list hands Argus — the whole This week board and the long end of a book fit. */
export const MAX_NAMES = 30
const BUY = new Set(['buy', 'strong_buy'])
const BOOK_OF = Object.freeze({ swing: 'swing', 'long term': 'long_term' })

export const HORIZON_LIST_TOOL_SPEC = {
    get_horizon_list: `The house's list for a HORIZON — the ONLY names you may pick from. \`horizon\`: "intraday" or "day" (the day boards), "short term swing" (This week: the run-up rule's names, each read by Prometheus), "swing" or "long term" (the house's Swing / Long term lists: Prometheus's Buys with his target, and the timing read — now, or wait for what). A name that is not in the answer is not a pick. An empty list says why; say that to the user and give no pick.`,
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

/** The horizon's list → `{ text, names }`. Exported for tests through the handler's deps. */
async function _list(horizon, deps) {
    if (horizon === 'intraday' || horizon === 'day') {
        return { text: `The day boards are not running yet — there is no ${horizon} list to pick from. Say so; no pick.`, names: [] }
    }
    if (horizon === 'short term swing') return formatWeekList(await deps.week())
    const book = BOOK_OF[horizon]
    return formatBookList(horizon, (await deps.book())?.[book])
}

/**
 * The handler. `onNames(names)` gets every name a call listed (the agent's pick gate). `deps` — test seams.
 */
export function makeHorizonListHandlers({ onNames = () => {}, deps = {} } = {}) {
    const d = {
        week: () => todayHotlist(),
        book: () => houseBook(),
        ...deps,
    }
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
