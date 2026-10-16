// Axl — reception. No working state: suggestions and the adopt flag are per turn.
// One definition for the HTTP desk stream and the session turn (unified-chat plan phase 4).

import { axlAgentService } from '../agents/axl.agent.service.js'

export const axlDesk = {
    agent: 'axl',
    log:   '[axl:desk]',
    run: ({ user, common }) => axlAgentService.chatStream({ ...common, isAdmin: user.role === 'admin' }),
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
