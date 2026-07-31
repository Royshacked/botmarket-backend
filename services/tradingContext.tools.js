/**
 * The venue tools, in one place — the answer to "where am I trading, with what, holding what, and
 * can I even trade this here?" that EVERY desk needs before it recommends anything.
 *
 * Both handlers are bound to a userId, so unlike the static COMMON_TOOL_HANDLERS they are built
 * per request (the same shape kairos/idea already use for onChart). One factory rather than one
 * per agent: the mechanism is identical everywhere, only the tool DESCRIPTION is tuned per desk —
 * that description is the instruction the model reads, and it legitimately differs between a
 * scanner deciding what is worth surfacing and an execution desk sizing a live order.
 *
 * See tradingContext.service.js for what the two reads actually do.
 */

import { getTradingContext, checkBrokerSymbol } from './tradingContext.service.js'
import { makeToolHandler } from './agentUtils.js'
import { isToolError } from './toolResult.util.js'
import { logger } from './logger.service.js'

const LOG = '[tradingContext]'

// ─── Formatting: the read is data, the tool result is TEXT ────────────────────
// Both reads return structured objects, because sizing, the feasibility gate and the order layer
// consume them as data. A TOOL result is a different audience: it is read by a model, and it must
// be text. Handing the object straight back is what made these two tools silent — the provider
// stringified `{modes,accounts}` to "[object Object]", so every desk was told nothing at all about
// accounts, balances, open positions or live P&L, and Axl answered "I don't know" to a P&L
// question the app could answer down to the cent.
//
// Same split userData.tools.js documents: the service is the pipe, this layer is the phrasing.
// The services below are untouched — their other callers keep the object.

const _fixed = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v).toFixed(dp))
/** Signed, so a P&L reads as a direction at a glance. Sign comes off the NUMBER, not the string. */
const _signed = (v, dp = 2) => {
    const n = Number(v)
    if (v == null || !Number.isFinite(n)) return null
    return `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(dp)}`
}

function _positionLine(p) {
    const pnl = _signed(p.pnl)
    const pct = _signed(p.pnlPct)
    return `  - ${p.symbol ?? '?'} ${p.direction ?? '?'} ${p.quantity ?? '?'} @ ${_fixed(p.entryPrice, 4) ?? '?'}`
        + `${p.currentPrice != null ? ` → now ${_fixed(p.currentPrice, 4)}` : ''}`
        + (pnl ? ` · P&L ${pnl}${pct ? ` (${pct}%)` : ''}` : ' · P&L unknown')
}

/** Open P&L for one account: the sum, plus how many legs could not be priced. */
function _openPnl(positions) {
    let sum = 0, priced = 0
    for (const p of positions) {
        const n = Number(p.pnl)
        if (p.pnl != null && Number.isFinite(n)) { sum += n; priced++ }
    }
    return { sum, priced, unpriced: positions.length - priced }
}

function _accountBlock(a, workspace = null) {
    const caps = Object.entries(a.capabilities ?? {}).filter(([, on]) => on).map(([k]) => k)
    // Which side of the workspace line this account sits on. Stamped per account because the header
    // alone was not enough: a desk reading a flat list of accounts, one of them marked SELECTED,
    // will happily answer about the live book while the user is sat in paper.
    const here = workspace ? (a.mode === workspace ? ' · THIS IS THE USER’S CURRENT WORKSPACE'
                                                   : ` · NOT the current workspace (user is in ${workspace})`) : ''
    const head = `[${a.mode}${a.broker !== a.mode ? ` · ${a.broker}` : ''}] ${a.id}${a.name != null && String(a.name) !== a.id ? ` "${a.name}"` : ''}`
        + here
        + `${a.selected ? ' · SELECTED (where a live order goes today)' : ''}`
        + ` · balance ${_fixed(a.balance) ?? 'unknown'}${a.currency ? ` ${a.currency}` : ''}`

    const positions = Array.isArray(a.positions) ? a.positions : []
    if (!positions.length) return [head, '  no open positions in this account'].join('\n')

    const { sum, priced, unpriced } = _openPnl(positions)
    return [
        head,
        `  ${positions.length} open position${positions.length === 1 ? '' : 's'} · open P&L ${priced ? `${_signed(sum)}${a.currency ? ` ${a.currency}` : ''}` : 'unknown'}`
            + (unpriced ? ` (${unpriced} could not be priced — not counted)` : ''),
        ...positions.map(_positionLine),
        caps.length ? `  can: ${caps.join(', ')}` : null,
    ].filter(Boolean).join('\n')
}

/**
 * The venue, as a model reads it.
 *
 * `unavailable` is rendered before anything else and never collapsed into "no positions": a broker
 * whose auth failed returns an empty book that looks exactly like a flat one, and telling a trader
 * they hold nothing when we simply could not ask is the one failure mode worth being loud about.
 */
export function formatTradingContext({ modes = {}, workspace = null, accounts = [], unavailable = [] } = {}) {
    const live = modes.live_brokers?.length ? modes.live_brokers.join(', ') : 'none connected'
    const header = `Venue: paper ${modes.paper ? 'ON' : 'off'} · manual ${modes.manual ? 'ON' : 'off'} · live brokers: ${live}.`

    // WHICH BOOK THE USER IS LOOKING AT. The line above says what EXISTS; on its own it reads as a
    // menu, and a desk asked "how am I doing" would answer about the live cTrader account while the
    // user sat in the paper workspace — every number true, none of them theirs. Stated first, and in
    // the imperative, because it governs how everything below should be read.
    const ws = workspace
        ? workspace === 'paper'
            ? `CURRENT WORKSPACE: PAPER (simulated money). The user is working in the paper workspace right now — "my account", "my positions" and "my P&L" mean the PAPER account. Any live account below is listed for completeness only: do not present it as their book, and do not describe an order as going to a real broker unless they ask to switch to live.`
            : `CURRENT WORKSPACE: LIVE (real money). "My account" means the live account below.`
        : null

    const warn = unavailable.length
        ? `WARNING — could not read positions at: ${unavailable.join(', ')}. Those accounts show empty here because the read FAILED, not because they are flat. Say so; do not report them as having no positions.`
        : null

    if (!accounts.length) return [header, ws, warn, 'No trading accounts available.'].filter(Boolean).join('\n')

    // Totals per currency, so two books in different currencies are never added together — and only
    // over the workspace the user is in, so "what's my P&L" in paper is never answered with a number
    // that quietly folds in the live book.
    const counted = workspace ? accounts.filter(a => a.mode === workspace) : accounts
    const byCcy = new Map()
    for (const a of counted) {
        const { sum, priced } = _openPnl(Array.isArray(a.positions) ? a.positions : [])
        if (!priced) continue
        const ccy = a.currency ?? ''
        byCcy.set(ccy, (byCcy.get(ccy) ?? 0) + sum)
    }
    const totals = [...byCcy].map(([ccy, sum]) => `${_signed(sum)}${ccy ? ` ${ccy}` : ''}`).join(' · ')

    return [
        header,
        ws,
        warn,
        `${accounts.length} account${accounts.length === 1 ? '' : 's'}.`,
        ...accounts.map(a => _accountBlock(a, workspace)),
        totals ? `Total open P&L ${workspace ? `in the ${workspace} workspace` : 'across all accounts'}: ${totals}.` : null,
    ].filter(Boolean).join('\n')
}

/**
 * ONE venue's three-state answer, in words — the shared piece.
 *
 * Both surfaces that state availability render through this: the explicit `check_broker_symbol`
 * answer and the tail appended to every quote. They frame it differently (a full block vs a one-line
 * tail) but the ANSWER must be identical, and above all the third state must survive both trips:
 * "the broker could not be reached" is not "you cannot trade this".
 */
function _venueLine(v, ticker) {
    const from = v.mappedFrom && v.brokerSymbol ? ` (the app's ${v.mappedFrom} → ${v.brokerSymbol} there)` : ''
    if (v.tradable === true) return `${v.broker}: TRADABLE as ${v.brokerSymbol ?? ticker}${from}`
    if (v.tradable === false) return `${v.broker}: NOT LISTED — the broker answered and does not carry it.`
    return `${v.broker}: UNKNOWN — ${v.error ?? 'the broker could not be reached'}. Treat as unknown, NEVER as unavailable.`
}

/** The three-state availability answer, kept three-state in words. */
export function formatBrokerSymbol({ ticker, venues = [] } = {}) {
    if (!venues.length) {
        return `${ticker}: no live trading venue is connected, so there is no broker to ask. Paper and manual accept anything the app can price.`
    }
    return [
        `${ticker} at the user's live venue${venues.length === 1 ? '' : 's'}:`,
        ...venues.map(v => `- ${_venueLine(v, ticker)}`),
    ].join('\n')
}

// ─── Availability, enforced rather than requested ─────────────────────────────
// Whether an instrument exists at the user's broker is a FACT about the venue, not a judgment
// about the trade — so it is wired in code instead of left to a prompt the model may or may not
// obey (see feedback_agent_decides_no_hardcoded_rules: the desk still decides what to DO about it).
// Every price read a desk makes therefore carries the answer with it: a desk physically cannot
// discuss entering AVGO on a live book without having been told whether AVGO is listed there.
//
// IT NEVER ONCE FIRED. Written service-side next to the read, it guarded `typeof payload !== 'object'`
// and returned early — but its only caller passes `getQuote`'s formatted TEXT, so every quote went
// out untouched from the day it shipped. A rule enforced in code still has to match the shape it
// enforces on. It now appends to text (the normal path) and still enriches an object (any future
// object-returning tool), and lives beside the renderer it shares with check_broker_symbol.
//
// Cached per user+ticker because the check rides on get_quote, which is called constantly, while a
// broker's instrument list changes on the order of days. A miss costs one cached-map lookup plus a
// selected-account read; a hit costs nothing.
const _AVAILABILITY_TTL_MS = 5 * 60 * 1000
const _availabilityCache = new Map()   // `${userId}:${TICKER}` → { at, venues }

/**
 * Attach live-broker availability to a tool payload. Returns the payload UNCHANGED when there is
 * nothing meaningful to say — no user, no ticker, no live trading venue connected (paper and manual
 * accept anything the app can price, so the question doesn't arise there), or a FAILED call, whose
 * error text must not be decorated into something that reads like data. Never throws: a broken
 * availability read must not take a working quote down with it.
 */
export async function withBrokerAvailability(payload, userId, ticker, deps = {}) {
    if (!userId || !ticker || payload == null || isToolError(payload)) return payload
    if (typeof payload !== 'string' && typeof payload !== 'object') return payload
    try {
        const symbol = String(ticker).trim().toUpperCase()
        const key = `${userId}:${symbol}`
        const hit = _availabilityCache.get(key)
        let venues
        if (hit && (Date.now() - hit.at) < _AVAILABILITY_TTL_MS) {
            venues = hit.venues
        } else {
            ;({ venues } = await checkBrokerSymbol(userId, ticker, deps))
            _availabilityCache.set(key, { at: Date.now(), venues })
        }
        if (!venues?.length) return payload   // no live venue → nothing to enforce
        // Text in, text out — same renderer as check_broker_symbol, so the two can never drift into
        // giving one answer to the tool and a different one to the quote.
        if (typeof payload === 'string') {
            return `${payload}\n\nAt the user's live broker — ${venues.map(v => _venueLine(v, symbol)).join(' | ')}`
        }
        return { ...payload, broker_availability: venues }
    } catch (err) {
        logger.warn(LOG, `availability check for ${ticker} failed`, err.message)
        return payload
    }
}

/** Test seam — drop cached availability so a test isn't answered by a previous test's read. */
export function _clearAvailabilityCache() { _availabilityCache.clear() }

/**
 * Per-request handlers for the venue tools.
 * @param {string|null} userId  bound into both reads; null yields empty, honest answers
 */
export function makeTradingContextHandlers(userId = null) {
    return {
        get_trading_context: makeToolHandler('get_trading_context',
            async () => formatTradingContext(await getTradingContext(userId)),
            (err) => `Could not fetch trading context: ${err.message}`, LOG),

        check_broker_symbol: makeToolHandler('check_broker_symbol',
            async ({ ticker }) => formatBrokerSymbol(await checkBrokerSymbol(userId, ticker)),
            (err, { ticker }) => `Could not check broker availability for ${ticker}: ${err.message}`, LOG),
    }
}

/**
 * The tool DESCRIPTIONS, shared where the job really is the same and overridden where it isn't.
 * Spread into an agent's toolsFor({...}) spec.
 */
export const TRADING_CONTEXT_TOOL_SPEC = {
    get_trading_context: `The user's live trading venue + accounts: which modes are available (paper / live / manual), which live brokers are connected, and every account with its balance, capabilities, whether it is the SELECTED one, and the positions currently open in it. Call it before you size anything, commit to a venue, or answer any question about accounts, balances, buying power or what the user is already holding — never guess these.`,

    check_broker_symbol: `Check whether a specific instrument is actually TRADABLE at the user's connected live broker, and what the broker calls it (e.g. NQ → US100.cash). Three answers: tradable true (with brokerSymbol), false (the broker answered and does not list it), or null (the broker could not be reached — UNKNOWN, never treat as unavailable). Call it before recommending or building anything on a live book: a perfect setup on an instrument the broker does not list cannot be traded. Paper and manual accept anything the app can price, so this is a live-broker question.`,
}
