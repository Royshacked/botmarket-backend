/**
 * The user's own data, as tools — what they are watching, how they have done, what is coming up.
 *
 * THIS FILE IS THE ADAPTER, NOT THE READ. Every query lives in a service
 * (watchlist / performance / upcomingEvents); this layer only turns structured rows into the
 * compact text a model reads well. That split is deliberate and load-bearing: a future card, REST
 * route or live component calls the SAME service and renders the fields itself, instead of parsing
 * prose back out of a string. Formatting is a judgment about what a chat answer needs; the data is
 * a pipe, and the pipe is shared.
 *
 * Everything here is READ-ONLY, which is why it sits comfortably with Axl's boundary: reporting
 * what the app already knows is not authoring a trade.
 */

import { makeToolHandler } from '../agentUtils.js'
import { listWatchedItems, DEFAULT_KINDS } from '../watchlist.service.js'
import { getPerformance } from '../performance.service.js'
import { getUpcomingEvents } from '../upcomingEvents.service.js'
import { getActiveWorkspace } from '../workspace.service.js'

const LOG = '[userData]'

const _dateStr = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
const _dateMs = (v) => {
    const s = _dateStr(v)
    return s ? Date.parse(`${s}T00:00:00Z`) : null
}

const _n = (v, suffix = '') => (v == null ? null : `${v}${suffix}`)
const _join = (parts) => parts.filter(Boolean).join(' · ')
/** Same, but leads with a separator when there is anything to add — and vanishes when there isn't. */
const _tail = (parts) => {
    const s = _join(parts)
    return s ? ` · ${s}` : ''
}

/**
 * A source that could not be read is NAMED, never reported as zero. "You are watching nothing" and
 * "I could not look" are different answers and only one of them is safe to say to a user who is
 * relying on it.
 */
function _unavailableLine(unavailable = []) {
    return unavailable.length
        ? `\n(Could not read: ${unavailable.join(', ')} — say so rather than reporting these as empty.)`
        : ''
}

function _zone(z) {
    if (!z) return null
    if (z.low != null && z.high != null) return z.low === z.high ? `${z.low}` : `${z.low}–${z.high}`
    return `${z.low ?? z.high}`
}

/**
 * Every row leads with `[kind:id]`, and the id is load-bearing rather than decoration: it is the
 * handle Axl quotes back in an `<edit>` tag to reopen THAT item in the desk that owns it. Without
 * it the model can only name a symbol, and two calls on the same name are indistinguishable — which
 * is how "edit that coverage" became a request to research the name from scratch.
 *
 * toWatchRow.js already keeps `id` on every row for exactly this ("a targeted read, not a re-list");
 * this only carries it the last step, into what the model actually reads.
 */
const _tag = (row, label = row.kind) => `[${label}${row.id ? `:${row.id}` : ''}]`

function _watchLine(row) {
    const d = row.detail ?? {}
    switch (row.kind) {
        case 'call':
        case 'setup':
            return `- ${_tag(row)} ${row.symbol ?? '?'} ${row.direction ?? ''} · ${row.status ?? '?'}${_tail([
                d.nearestEntry ? `entry ${_zone(d.nearestEntry)}` : null,
                d.stop ? `stop ${_zone(d.stop)}` : null,
                _n(d.rr, 'R'), d.conviction ? `conviction ${d.conviction}` : null,
                d.validUntil ? `until ${d.validUntil}` : null,
            ])}${row.title ? ` — ${row.title}` : ''}`
        case 'portfolio': {
            const byStatus = Object.entries(d.byStatus ?? {}).map(([s, n]) => `${n} ${s}`).join(', ')
            return `- ${_tag(row, 'book')} ${row.title} · ${d.holdings ?? 0} holding${d.holdings === 1 ? '' : 's'}${byStatus ? ` (${byStatus})` : ''}${d.symbols?.length ? ` · ${d.symbols.join(', ')}` : ''}`
        }
        case 'scan':
            return `- ${_tag(row)} ${row.title}${d.period ? ` (${d.period})` : ''} · ${d.candidates ?? 0} candidate${d.candidates === 1 ? '' : 's'}${d.stale ? ' · STALE (its period has passed)' : ''}`
        case 'coverage':
            return `- ${_tag(row)} ${row.symbol ?? '?'} [${d.rating ?? 'unrated'}] · ${row.status ?? '?'}${_tail([
                d.ourPT != null ? `our PT ${d.ourPT}` : null,
                d.gapPct != null ? `${d.gapPct >= 0 ? '+' : ''}${d.gapPct}% vs Street${d.streetPT != null ? ` ${d.streetPT}` : ''}` : null,
            ])}${row.title ? ` — ${row.title}` : ''}`
        default:
            return `- ${_tag(row)} ${row.symbol ?? row.title ?? row.id}`
    }
}

export function formatWatchedItems({ items = [], counts = {}, unavailable = [], workspace = null } = {}) {
    // The workspace has to be SAID, and it matters most on the empty answer. "You have nothing" and
    // "you have nothing in paper" are different sentences, and a user with three live setups who
    // hears the first one has been told something false about their own book. Calls, setups and
    // books are scoped; scans and coverage are research, bind to no account, and are shared across
    // all three workspaces by decision — so the line says that rather than leaving it inferred.
    const scope = workspace
        ? ` in the ${workspace.toUpperCase()} workspace (calls, setups and books are scoped to it; scans and coverage are shared across all workspaces)`
        : ''

    if (!items.length) {
        return unavailable.length
            ? `Could not read: ${unavailable.join(', ')}. Tell the user you couldn't check rather than saying they have nothing.`
            : `Nothing${scope || ' in the app yet'} — no calls, setups, books, coverage or scans.`
    }
    const summary = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ')
    return [
        `In the app right now${scope}: ${summary}.`,
        ...items.map(_watchLine),
        _unavailableLine(unavailable),
    ].join('\n').trim()
}

function _summaryLine(label, s) {
    if (!s || !s.count) return null
    return `${label}: ${s.count} closed · ${s.winRatePct ?? '?'}% win · net ${s.netPnl ?? '?'}${s.profitFactor != null ? ` · PF ${s.profitFactor}` : ''}${s.expectancy != null ? ` · expectancy ${s.expectancy}` : ''}`
}

export function formatPerformance({ realized, calls, filter = {}, unavailable = [] } = {}) {
    const scope = _join([
        filter.mode ? `mode ${filter.mode}` : null,
        filter.symbol ? `symbol ${filter.symbol}` : null,
        (filter.from || filter.to) ? 'windowed' : null,
    ])
    const lines = []

    const overall = realized?.overall
    if (overall?.count) {
        lines.push(_summaryLine('Closed trades', overall))
        for (const [mode, s] of Object.entries(realized.byMode ?? {})) {
            const l = _summaryLine(`  ${mode}`, s)
            if (l) lines.push(l)
        }
        // Only the busiest names — the full per-symbol table is in the data, not in the answer.
        const top = Object.entries(realized.bySymbol ?? {})
            .filter(([, s]) => s?.count).sort((a, b) => b[1].count - a[1].count).slice(0, 5)
        if (top.length) lines.push(`  by symbol: ${top.map(([sym, s]) => `${sym} ${s.count}×/${s.winRatePct ?? '?'}%`).join(', ')}`)
    } else if (!unavailable.includes('realized')) {
        lines.push('No closed trades on record yet.')
    }

    if (calls?.closed) {
        lines.push(`Kairos calls: ${calls.closed} closed · ${calls.winRatePct ?? '?'}% win · avg ${calls.avgR ?? '?'}R${calls.totalPnl != null ? ` · P&L ${calls.totalPnl}` : ''}`)
    }

    // The units are already percentages — say so, so the model never re-scales them. Only when
    // there IS a rate above it: on an empty answer the note is noise the model may echo.
    const hasRate = Boolean(overall?.count || calls?.closed)
    return [
        scope ? `Performance (${scope}):` : 'Performance:',
        ...lines,
        hasRate ? 'Win rates above are PERCENTAGES already — report them as-is.' : null,
        _unavailableLine(unavailable),
    ].filter(Boolean).join('\n').trim()
}

export function formatUpcomingEvents({ from, to, scope, symbols = [], earnings = [], fed = [], unavailable = [] } = {}) {
    const lines = [`Between ${from} and ${to}${scope === 'mine' ? ` for the user's own names (${symbols.length ? symbols.join(', ') : 'none found'})` : ' (market-wide)'}:`]

    if (earnings.length) {
        lines.push('Earnings:', ...earnings.slice(0, 25).map(e =>
            `- ${e.date} ${e.symbol}${e.epsEstimated != null ? ` · EPS est ${e.epsEstimated}` : ''}`))
        if (earnings.length > 25) lines.push(`  …and ${earnings.length - 25} more.`)
    } else if (!unavailable.includes('earnings')) {
        lines.push(scope === 'mine' && !symbols.length
            ? 'Earnings: none — the user has no names in the app to check.'
            : 'Earnings: nothing scheduled in this window.')
    }

    if (fed.length) {
        lines.push('Fed / macro:', ...fed.slice(0, 15).map(i =>
            `- ${i.date} ${i.event}${i.impact ? ` (${i.impact})` : ''}`))
    } else if (!unavailable.includes('fed')) {
        lines.push('Fed / macro: nothing scheduled in this window.')
    }

    return [...lines, _unavailableLine(unavailable)].join('\n').trim()
}

/** Per-request handlers, bound to a userId — the shape makeTradingContextHandlers established. */
export function makeUserDataHandlers(userId = null, deps = {}) {
    const {
        watched = listWatchedItems,
        performance = getPerformance,
        events = getUpcomingEvents,
        workspace = getActiveWorkspace,
    } = deps

    return {
        // Scoped to the workspace the user is standing in, and NOT an argument the model may set:
        // "what am I watching" means the book in front of them, and every desk is already told which
        // that is by the venue block. Left to the model it would be forgotten exactly as
        // get_trading_context was — and the failure is quiet, because a list mixing paper calls with
        // real-money ones looks like a complete answer.
        get_watched_items: makeToolHandler('get_watched_items',
            async ({ kinds, symbol, include_finished } = {}) => formatWatchedItems(await watched(userId, {
                kinds: Array.isArray(kinds) && kinds.length ? kinds : DEFAULT_KINDS,
                symbol: symbol ? String(symbol).toUpperCase() : null,
                includeFinished: include_finished === true,
                workspace: await workspace(userId),
            })),
            (err) => `Could not read what the user is watching: ${err.message}`, LOG),

        get_performance: makeToolHandler('get_performance',
            async ({ mode, symbol, from, to } = {}) => formatPerformance(await performance(userId, {
                mode: mode ?? null,
                symbol: symbol ? String(symbol).toUpperCase() : null,
                from: _dateMs(from), to: _dateMs(to),
            })),
            (err) => `Could not read the user's performance: ${err.message}`, LOG),

        get_upcoming_events: makeToolHandler('get_upcoming_events',
            async ({ scope, from, to } = {}) => formatUpcomingEvents(await events(userId, {
                scope: scope === 'market' ? 'market' : 'mine',
                from: _dateStr(from), to: _dateStr(to),
            })),
            (err) => `Could not read the calendar: ${err.message}`, LOG),
    }
}

/**
 * The tool DESCRIPTIONS — the instruction the model actually reads.
 *
 * get_watched_items carries an explicit NOT-clause against get_trading_context. The two are
 * genuinely adjacent ("what do I have?") and get_trading_context's own description says "what the
 * user is already holding". That description CANNOT be edited to disambiguate: TRADING_CONTEXT_TOOL_SPEC
 * is shared by seven agents and the registry snapshot asserts every description verbatim per agent,
 * so a word changed there rewrites six other agents' behaviour. The disambiguation therefore lives
 * here, on the newcomer.
 */
export const USER_DATA_TOOL_SPEC = {
    get_watched_items: `Everything the user keeps in the app: Kairos calls, Mentor setups, portfolios (as books), Prometheus coverage, and Argus scans — with status, levels and how fresh each is. This is the PLANS AND BOOKS they have made, NOT their open broker positions, balances or live P&L, which are get_trading_context. Calls, setups and books come back scoped to the workspace the user is standing in (paper / live / manual) — those bind to an account, and merging two books into one list is not an answer. Scans and coverage are research, bind to no account, and are shared across every workspace. Call it for "what am I watching / what have I got going / what's still open", and before saying the user has nothing. Finished items are excluded unless asked for.`,

    get_performance: `The user's CLOSED-trade record: how many, win rate, net P&L, profit factor and expectancy, split by mode (paper/live/manual), by origin and by symbol — plus Kairos's own R-multiple record for closed calls. Optionally narrowed to a mode, a symbol or a date window. Win rates come back as PERCENTAGES already — never multiply them again. Use it for "how have I done", "is paper working", "what's my win rate". It reports history only; open positions and unrealized P&L are get_trading_context.`,

    get_upcoming_events: `Dated events in a window (default the next 30 days): company earnings plus Fed and macro releases. By default scoped to the USER'S OWN names — the calls, setups, coverage and holdings they have in the app — so the answer is about their book, not the whole market; pass scope 'market' for everything. Use it for "anything coming up", "what's the risk this week", or before discussing timing around a name they hold.`,
}
