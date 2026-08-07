/**
 * The market brief — one broadcast of what the world is doing today.
 *
 * ── WHY THIS IS A SERVICE AND NOT FIVE TOOLS ON AXL ──────────────────────────
 * The brief has two consumers: the user asking Axl "what's going on today", and the daily offer
 * card they can confirm to have one delivered. Those are two callers of ONE mechanism, so they
 * share one pipe (CLAUDE.md). Handing Axl the raw market tools instead would have let the chat
 * answer and the pushed card drift apart on wording, sourcing and even facts — and would have made
 * Axl a market commentator, which is exactly the boundary the brief is supposed to hold.
 *
 * ── WHY IT IS CACHED ACROSS USERS ────────────────────────────────────────────
 * A brief is about the WORLD, never about a reader's book — nothing in it is user-specific. So it
 * is computed once per TTL and served to everyone: the morning fan-out costs one LLM run, not one
 * per user, and a user who asks Axl an hour later reads the same brief the card delivered. That
 * user-independence is a load-bearing property, not an optimization. If a per-user fact ever needs
 * to appear here, it does NOT belong in the brief.
 *
 * ── DATA IS FETCHED IN CODE, NARRATIVE IS THE MODEL'S ────────────────────────
 * The tape, the macro snapshot and the calendar are assembled deterministically and handed to the
 * model as a block. Only the narrative — why the tape looks like this — is left to the model, via
 * web_search. A tool the model may forget to call is a section the brief may silently ship without;
 * a block in the prompt cannot go missing. Same data-vs-judgment split the desks use.
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { logger }                  from './logger.service.js'
import { getMacroSnapshot }        from '../providers/fmp.provider.js'
import { getNumericQuoteWithTime } from '../providers/yahoofinance.provider.js'
import { getUpcomingEvents }       from './upcomingEvents.service.js'
import { runAgentStream }          from './agentIO.js'
import { toolsFor }                from './agentTools.registry.js'
import { makePromptLoader, LANGUAGE_RULE } from './agentUtils.js'
import { createTtlCache }          from './ttlCache.util.js'
import { config } from './config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG = '[marketBrief]'

const _systemPrompt = makePromptLoader(join(__dirname, '../market_brief_prompt.md'), LOG)

/** A brief older than this is rewritten; inside it, every caller reads the same one. */
export const BRIEF_TTL_MS = config.marketBriefTtlMs
/** How far ahead the calendar section looks. */
const CALENDAR_DAYS = 7

// Only web_search — every other input arrives pre-fetched in the data block (see header).
const TOOLS = toolsFor({ web_search: '' })

/**
 * The tape board. `kind` is a FORMATTING decision, not a data one: a yield moves in points and a
 * cross in pips, and reporting either as a percent change reads as nonsense.
 * Symbols are Yahoo's — the quote path falls back to Yahoo for anything FMP can't price, which is
 * what makes indices (^GSPC) and crosses (EURUSD=X) quotable here at all.
 */
export const TAPE = [
    { group: 'Global equity',  label: 'S&P 500',       symbol: '^GSPC',     kind: 'index' },
    { group: 'Global equity',  label: 'Nasdaq 100',    symbol: '^NDX',      kind: 'index' },
    { group: 'Global equity',  label: 'Dow',           symbol: '^DJI',      kind: 'index' },
    { group: 'Global equity',  label: 'VIX',           symbol: '^VIX',      kind: 'level' },
    { group: 'Global equity',  label: 'Euro Stoxx 50', symbol: '^STOXX50E', kind: 'index' },
    { group: 'Global equity',  label: 'FTSE 100',      symbol: '^FTSE',     kind: 'index' },
    { group: 'Global equity',  label: 'DAX',           symbol: '^GDAXI',    kind: 'index' },
    { group: 'Global equity',  label: 'Nikkei 225',    symbol: '^N225',     kind: 'index' },
    { group: 'Global equity',  label: 'Hang Seng',     symbol: '^HSI',      kind: 'index' },

    { group: 'Rates & commodities', label: 'US 10-year yield', symbol: '^TNX',   kind: 'yield' },
    { group: 'Rates & commodities', label: 'Gold',             symbol: 'GC=F',   kind: 'level' },
    { group: 'Rates & commodities', label: 'WTI crude',        symbol: 'CL=F',   kind: 'level' },
    { group: 'Rates & commodities', label: 'Bitcoin',          symbol: 'BTC-USD', kind: 'level' },

    { group: 'Currencies', label: 'Dollar index', symbol: 'DX-Y.NYB', kind: 'level' },
    { group: 'Currencies', label: 'EUR/USD',      symbol: 'EURUSD=X', kind: 'fx' },
    { group: 'Currencies', label: 'USD/JPY',      symbol: 'USDJPY=X', kind: 'fx' },
    { group: 'Currencies', label: 'GBP/USD',      symbol: 'GBPUSD=X', kind: 'fx' },
    { group: 'Currencies', label: 'USD/CNY',      symbol: 'USDCNY=X', kind: 'fx' },
]

/**
 * "Major earnings only" is a JUDGMENT, so it is made once, here, in code — market-wide earnings for
 * a week is hundreds of tickers and a model asked to pick the important ones picks differently every
 * morning. Both Berkshire spellings are listed because the calendar provider and Yahoo disagree.
 */
export const MAJOR_EARNINGS = new Set([
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'AMZN', 'META', 'TSLA', 'AVGO', 'ORCL',
    'BRK-B', 'BRK.B', 'LLY', 'JPM', 'V', 'MA', 'XOM', 'CVX', 'WMT', 'UNH',
    'COST', 'HD', 'PG', 'JNJ', 'NFLX', 'CRM', 'AMD', 'BAC', 'KO', 'PEP',
    'TMO', 'CSCO', 'ADBE', 'MCD', 'ABBV', 'WFC', 'GS', 'MS', 'INTC', 'QCOM',
    'TXN', 'IBM', 'DIS', 'BA', 'CAT', 'NKE', 'PFE', 'T', 'VZ', 'MU',
    'PLTR', 'COIN', 'UBER', 'LIN', 'ACN', 'NOW', 'SHOP', 'ASML', 'TSM', 'BABA',
])

/**
 * A number, or null. The null/'' guard is not pedantry: `Number(null)` is 0 and passes a finite
 * check, so a quote that came back with a null price would be printed as "DAX: 0" — a missing
 * number reported as a real one, which is the failure mode this whole file is written against.
 */
const _n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** One tape row → a line, or null when the quote didn't come back (never a guessed number). */
export function formatTapeRow(row, quote) {
    const price = _n(quote?.price)
    if (price == null) return null

    const prev = _n(quote?.prevClose)
    const pct  = prev ? ((price - prev) / prev) * 100 : null
    const sign = (v) => (v >= 0 ? '+' : '')
    const pctStr = pct == null ? '' : ` (${sign(pct)}${pct.toFixed(2)}%)`

    switch (row.kind) {
        case 'index':
            return `${row.label}: ${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}${pctStr}`
        case 'yield': {
            // A yield moves in percentage POINTS. Reporting 4.28 → 4.34 as "+1.4%" is the kind of
            // number a reader mis-reads as the bond market moving 1.4%.
            const chg = prev == null ? '' : ` (${sign(price - prev)}${(price - prev).toFixed(2)} pts)`
            return `${row.label}: ${price.toFixed(2)}%${chg}`
        }
        case 'fx':
            return `${row.label}: ${price.toFixed(4)}${pctStr}`
        default:
            return `${row.label}: ${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}${pctStr}`
    }
}

/** Tape rows + their quotes → the grouped board. Pure — exported for testing. */
export function formatTape(rows = [], quotes = []) {
    const lines = []
    let group = null
    for (let i = 0; i < rows.length; i++) {
        const line = formatTapeRow(rows[i], quotes[i])
        if (!line) continue
        if (rows[i].group !== group) {
            group = rows[i].group
            lines.push(`${group}:`)
        }
        lines.push(`  ${line}`)
    }
    return lines.length ? lines.join('\n') : 'Tape unavailable — no quotes came back.'
}

/** Fetch every tape quote at once; a failed row becomes null and is dropped by the formatter. */
async function _tape(quote = getNumericQuoteWithTime) {
    const settled = await Promise.allSettled(TAPE.map(r => quote(r.symbol)))
    const quotes = settled.map((r, i) => {
        if (r.status === 'fulfilled') return r.value
        logger.warn(LOG, `tape quote failed: ${TAPE[i].symbol}`, r.reason?.message)
        return null
    })
    return formatTape(TAPE, quotes)
}

/**
 * The calendar section: every Fed/macro row in the window, and ONLY major earnings.
 * Pure — exported for testing.
 */
export function formatBriefCalendar({ from, to, earnings = [], fed = [], unavailable = [] } = {}, major = MAJOR_EARNINGS) {
    const lines = [`Calendar ${from} → ${to}:`]

    if (unavailable.includes('fed')) lines.push('Fed / macro: could not be read.')
    else if (fed.length) lines.push('Fed / macro:', ...fed.map(i => `  - ${i.date} ${i.event}${i.impact ? ` (${i.impact})` : ''}`))
    else lines.push('Fed / macro: nothing scheduled in this window.')

    if (unavailable.includes('earnings')) {
        lines.push('Major earnings: could not be read.')
    } else {
        const majors = earnings.filter(e => e?.symbol && major.has(String(e.symbol).toUpperCase()))
        if (majors.length) lines.push('Major earnings:', ...majors.map(e => `  - ${e.date} ${String(e.symbol).toUpperCase()}`))
        else lines.push('Major earnings: none of the large caps report in this window.')
    }

    return lines.join('\n')
}

const _iso = (ms) => new Date(ms).toISOString().slice(0, 10)

/** The whole data block handed to the model. Pure — exported for testing. */
export function buildBriefInput({ date, tape, macro, calendar }) {
    return [
        `Write today's market brief. Today is ${date}.`,
        '',
        '=== TAPE ===',
        tape,
        '',
        '=== MACRO SNAPSHOT ===',
        macro,
        '',
        '=== CALENDAR ===',
        calendar,
        '',
        'These numbers are already correct — use them as given, and do not invent any others.',
        'Use web_search for what the numbers cannot say: what moved the tape overnight and this morning.',
    ].join('\n')
}

// ── Cache + single flight ────────────────────────────────────────────────────
// One key: the brief is the same for everyone. The in-flight promise matters more than the cache
// here — the morning fan-out asks every user's card at once, and without it a cold cache would
// start one LLM run per user instead of one run they all wait on.
const _cache = createTtlCache({ ttlMs: BRIEF_TTL_MS, max: 1 })
const KEY = 'brief'
let _inflight = null

/** Test seam — drops the cached brief and any in-flight build. */
export function _resetBriefCache() {
    _cache.clear()
    _inflight = null
}

/**
 * Today's market brief. Cached across users for BRIEF_TTL_MS; concurrent callers share one build.
 *
 * @param {{ refresh?: boolean }} [opts]
 * @returns {Promise<{ text: string, asOf: number, cached: boolean }>}
 * @throws when the brief cannot be written at all (no cached copy and the model turn failed)
 */
export async function getMarketBrief({ refresh = false } = {}, deps = {}) {
    if (!refresh) {
        const hit = _cache.get(KEY)
        if (hit) return { ...hit, cached: true }
        if (_inflight) return { ...(await _inflight), cached: true }
    }

    const build = _buildBrief(deps)
        .then(brief => { _cache.set(KEY, brief); return brief })
        // Only clear the slot if it is still OURS. An explicit refresh started while a normal build
        // is running replaces `_inflight`, and without this guard whichever finished first would
        // null out the other's registration — leaving the next caller to start a third build.
        .finally(() => { if (_inflight === build) _inflight = null })

    _inflight = build
    return { ...(await build), cached: false }
}

async function _buildBrief(deps = {}) {
    const {
        macro = getMacroSnapshot,
        events = getUpcomingEvents,
        quote = getNumericQuoteWithTime,
        run = runAgentStream,
        now = Date.now(),
    } = deps

    const from = _iso(now)
    const to   = _iso(now + CALENDAR_DAYS * 864e5)

    // Every input is optional: a brief with a missing section is still a brief, and the prompt tells
    // the model to write short rather than invent. Only the model turn itself is allowed to fail.
    const [tapeRes, macroRes, calRes] = await Promise.allSettled([
        _tape(quote),
        macro(),
        events(null, { scope: 'market', from, to }),
    ])

    const tapeText  = tapeRes.status === 'fulfilled' ? tapeRes.value : 'Tape unavailable.'
    const macroText = macroRes.status === 'fulfilled' ? macroRes.value : 'Macro snapshot unavailable.'
    const calText   = calRes.status === 'fulfilled'
        ? formatBriefCalendar(calRes.value)
        : 'Calendar unavailable.'

    if (macroRes.status === 'rejected') logger.warn(LOG, 'macro read failed', macroRes.reason?.message)
    if (calRes.status === 'rejected')   logger.warn(LOG, 'calendar read failed', calRes.reason?.message)

    const systemPrompt = [
        { type: 'text', text: _systemPrompt() + LANGUAGE_RULE, cache_control: { type: 'ephemeral' } },
    ]
    const input = buildBriefInput({ date: from, tape: tapeText, macro: macroText, calendar: calText })

    const text = await run({
        log: LOG,
        messages: [{ role: 'user', content: input }],
        systemPrompt,
        tools: TOOLS,
        toolHandlers: {},   // web_search runs server-side — nothing to dispatch locally
        meta: { brief: from },
    })

    const trimmed = String(text ?? '').trim()
    if (!trimmed) throw new Error('the brief came back empty')

    logger.info(LOG, 'brief built', { date: from, length: trimmed.length })
    return { text: trimmed, asOf: now }
}
