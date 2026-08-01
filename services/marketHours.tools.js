/**
 * Market hours, as a model reads them — "can this actually be traded right now, and if not, when?"
 *
 * The split mirrors tradingContext.tools.js exactly, and for the same reason: market.service is
 * the PIPE (one gate, one calendar, one answer, consumed by the monitors, the paper fill loop, the
 * order-state logic and the FE hook), and this layer is the PHRASING. A tool result is read by a
 * model and must be text; handing back `{open:false,nextOpenMs:…}` would stringify to
 * "[object Object]" — the bug that made the venue tools silent for every desk.
 *
 * ONE renderer (`formatMarketStatus`) serves BOTH surfaces — the explicit `get_market_hours`
 * answer and the tail appended to every quote — so the two can never drift into telling the model
 * different things about the same instrument. Same discipline as `_venueLine` over there.
 *
 * Why this rides on get_quote at all: whether a market is open is a FACT about the venue, not a
 * judgment about the trade (see feedback_data_vs_judgment_separation). The desk still decides what
 * to DO about it — build the idea anyway as a resting order, wait, pick a 24h instrument instead —
 * but it can no longer be unaware. That is the same reason withBrokerAvailability rides there.
 */

import { getMarketStatus } from './market.service.js'
import { makeToolHandler } from './agentUtils.js'
import { isToolError } from './toolResult.util.js'
import { logger } from './logger.service.js'

const LOG = '[marketHours]'

// How each session calendar should be NAMED to a model. The class alone ("futures") does not tell
// a desk that its instrument fills overnight; the hours do.
const _SESSION_COPY = {
    crypto:  '24/7 — crypto never closes',
    forex:   '24/5 — Sun 17:00 ET → Fri 17:00 ET',
    futures: 'CME index-futures hours, near-24/5 — Sun 18:00 ET → Fri 17:00 ET with a 17:00–18:00 ET daily break',
    equity:  'US regular session, 09:30–16:00 ET weekdays',
}

// Session phases worth SAYING. 'mid' is the unremarkable default and adding it to every quote is
// noise; the rest each carry a real trading implication (thin liquidity, the close approaching).
const _PHASE_COPY = {
    opening:       'the opening range',
    lunch:         'the lunch lull — thin, chop-prone',
    power:         'the power hour',
    'into-close':  'the last minutes into the close',
    'pre-market':  'pre-market',
    'after-hours': 'after-hours',
    overnight:     'the overnight session',
}

/** "2d 14h" / "3h 20m" / "45m" — a duration a trader reads at a glance, never raw ms. */
function _untilText(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null
    const mins = Math.round(ms / 60_000)
    const d = Math.floor(mins / 1440)
    const h = Math.floor((mins % 1440) / 60)
    const m = mins % 60
    if (d > 0) return `${d}d ${h}h`
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
}

/** The next open as an ET wall-clock stamp, e.g. "Mon 09:30 ET". */
function _etStamp(ms) {
    if (!Number.isFinite(ms)) return null
    return new Date(ms).toLocaleString('en-US', {
        timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).replace(',', '') + ' ET'
}

/**
 * THE market-status sentence. One line, because it is appended to every quote — a paragraph there
 * would drown the price it is annotating.
 *
 * Pure and date-injectable: the whole thing is unit-testable without a clock.
 *
 * @param {string} symbol
 * @param {string} [assetClass] the entity's stated class; omitted → symbol heuristic
 * @param {Date}   [date]
 * @returns {string}
 */
export function formatMarketStatus(symbol, assetClass, date = new Date()) {
    const ticker = String(symbol ?? '').toUpperCase() || 'this instrument'
    const { open, nextOpenMs, session, phase } = getMarketStatus(symbol, assetClass, date)
    const calendar = _SESSION_COPY[session] ?? _SESSION_COPY.equity

    if (open) {
        const texture = _PHASE_COPY[phase]
        return `${ticker}: market is OPEN right now (${calendar})${texture ? ` — currently ${texture}` : ''}.`
    }

    const until = _untilText(nextOpenMs - date.getTime())
    const when  = _etStamp(nextOpenMs)
    const reopen = when ? ` Next open: ${when}${until ? ` (in ${until})` : ''}.` : ''
    // Said in the imperative because it is the part a desk acts on: an order sent now does not
    // rest politely, it is rejected by the broker.
    return `${ticker}: market is CLOSED right now (${calendar}).${reopen}`
        + ` A market order cannot be filled until it reopens — plan a resting entry or wait.`
}

/**
 * Append market status to a tool payload. Returns the payload UNCHANGED when there is nothing to
 * say or the call FAILED — an error string must never be decorated into something that reads like
 * data. Never throws: a broken status read must not take a working quote down with it.
 *
 * Deliberately NOT cached. The whole value of this is that it flips at the open, and the underlying
 * read is pure arithmetic on a clock — there is nothing to cache and a stale answer is the one
 * failure mode that matters.
 */
export function withMarketStatus(payload, ticker, assetClass = null) {
    if (!ticker || payload == null || isToolError(payload)) return payload
    if (typeof payload !== 'string' && typeof payload !== 'object') return payload
    try {
        const line = formatMarketStatus(ticker, assetClass)
        if (typeof payload === 'string') return `${payload}\n\n${line}`
        return { ...payload, market_status: line }
    } catch (err) {
        logger.warn(LOG, `market-status annotation for ${ticker} failed`, err.message)
        return payload
    }
}

/**
 * The market-hours tool handler. Unbound — market hours are a property of the instrument, not of
 * the user, so unlike the venue handlers there is no userId to bind and one shared instance would
 * do. Still a factory, for symmetry with every other `make*Handlers` and so a caller never has to
 * remember which tool modules are special.
 */
export function makeMarketHoursHandlers() {
    return {
        get_market_hours: makeToolHandler('get_market_hours',
            ({ ticker, asset_class }) => formatMarketStatus(ticker, asset_class ?? null),
            (err, { ticker }) => `Could not resolve market hours for ${ticker}: ${err.message}`, LOG),
    }
}

/**
 * The tool DESCRIPTION. Shared verbatim across desks because, unlike the venue tools, the job
 * genuinely IS identical everywhere: a scanner and an execution desk want the same fact about
 * whether NVDA is tradeable at 03:00. What they DO with it stays theirs.
 */
export const MARKET_HOURS_TOOL_SPEC = {
    get_market_hours: `Whether an instrument's market is OPEN right now, and if not, exactly when it next opens. Asset-class aware: crypto is 24/7, forex is 24/5, index futures run near-24/5 on CME hours, and stocks/ETFs only trade the 09:30–16:00 ET regular session. Every get_quote already comes back with this line attached, so call this only when you need the answer WITHOUT pricing something — "is the market open?", "when does it reopen?", "can we still get in today?". Note it does not know about exchange holidays or half-days.`,
}
