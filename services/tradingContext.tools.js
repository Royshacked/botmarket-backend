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

const LOG = '[tradingContext]'

/**
 * Per-request handlers for the venue tools.
 * @param {string|null} userId  bound into both reads; null yields empty, honest answers
 */
export function makeTradingContextHandlers(userId = null) {
    return {
        get_trading_context: makeToolHandler('get_trading_context',
            () => getTradingContext(userId),
            (err) => `Could not fetch trading context: ${err.message}`, LOG),

        check_broker_symbol: makeToolHandler('check_broker_symbol',
            ({ ticker }) => checkBrokerSymbol(userId, ticker),
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
