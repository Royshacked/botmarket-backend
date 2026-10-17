// Axl — reception. No working state: suggestions and the adopt flag are per turn.
// Axl answers only in the session (unified-chat plan phase 7): its HTTP stream went with the old hub.

import { axlAgentService } from '../agents/axl.agent.service.js'
import { getMarketBrief } from '../marketBrief.service.js'

export const axlDesk = {
    agent: 'axl',
    log:   '[axl:desk]',
    run: ({ user, input, signal, emit, common }) => (input?.brief
        ? briefTurn({ emit, signal })
        : axlAgentService.chatStream({ ...common, isAdmin: user.role === 'admin' })),
    // route / routeSymbol / edit / show / opening are appended by the caller, validated for this user.
    done: (result, { routing: { route } }) => ({
        reply: result.reply,
        // The user already owns the book they want managed → the portfolio desk opens in ADOPT mode
        // instead of on a blank construction. Re-gated on a real portfolio route for the same reason
        // the symbol and the opening are: this tier is the contract.
        adopt: route === 'portfolio' && result.adopt === true,
        // Follow-up chips. Already empty on a routing turn (the agent guards it), and re-gated here
        // for the same reason `route` itself is validated rather than trusted.
        suggestions: route ? [] : (Array.isArray(result.suggestions) ? result.suggestions : []),
        chart: result.chart ?? null,
    }),
}

/**
 * Today's market brief as Axl's turn (plan phase 7, J4; it replaced POST /api/axl/brief/stream): the brief
 * card's button asks for it, and it lands in Axl's segment so a follow-up can be answered. The whole
 * text goes out as one token (it is complete when it exists); the status chip covers a stale brief's rewrite.
 */
export async function briefTurn({ emit, signal, fetchBrief = getMarketBrief }) {
    emit('status', { tool: 'market_brief' })
    const { text } = await fetchBrief()
    if (signal?.aborted) return null
    emit('token', { text })
    return { reply: text }
}
