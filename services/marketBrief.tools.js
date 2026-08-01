/**
 * The market brief, as a tool.
 *
 * UNBOUND — no userId. That is the whole point: the brief is about the world, identical for every
 * reader, and a handler that cannot see a user cannot leak one into it. Same shape as the concept
 * handlers, and for the same reason.
 *
 * The handler returns the SAME text the offer card delivers, because both go through
 * marketBrief.service. Axl does not write the brief and must not paraphrase it away — see the
 * description below and the prompt section that backs it.
 */

import { makeToolHandler } from './agentUtils.js'
import { getMarketBrief }  from './marketBrief.service.js'

const LOG = '[marketBrief]'

/** Minutes since a timestamp, for the freshness line the model reads. */
const _agedMin = (asOf) => Math.max(0, Math.round((Date.now() - asOf) / 60000))

export function makeMarketBriefHandlers(deps = {}) {
    const { brief = getMarketBrief } = deps

    return {
        get_market_brief: makeToolHandler('get_market_brief',
            async ({ refresh } = {}) => {
                const { text, asOf } = await brief({ refresh: refresh === true })
                const age = _agedMin(asOf)
                // The age is stated so a brief read at 4pm isn't relayed as "this morning". The model
                // is told the number; how to say it is its business.
                return `Market brief (written ${age} minute${age === 1 ? '' : 's'} ago):\n\n${text}`
            },
            (err) => `Could not write the market brief: ${err.message}`, LOG),
    }
}

export const MARKET_BRIEF_TOOL_SPEC = {
    get_market_brief: `Today's MARKET BRIEF — a short broadcast of what the world's markets are doing: the tape (US, Europe, Asia), what drove it overnight, rates, the dollar and commodities, major currency pairs, the macro picture, and the week's Fed releases and major earnings. Call it for "what's going on today", "how are markets", "what's happening in the world", "anything I should know", and for any question about global markets, geopolitics, macro data or currencies. It is written for everyone and knows NOTHING about this user — it never mentions their positions, and you must not connect it to them either. Relay it; do not rewrite it into advice. Costs a live write when stale, so call it once per conversation unless the user asks for a refresh.`,
}
