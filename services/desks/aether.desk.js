// Aether — event exposure (admin, its own panel and session scope). No working state.
// One definition for the HTTP desk stream and the session turn (unified-chat plan phase 4).

import { aetherAgentService } from '../agents/aether.agent.service.js'

export const aetherDesk = {
    agent: 'aether',
    log:   '[aether:desk]',
    run:   ({ common }) => aetherAgentService.chatStream(common),
    done:  (result) => ({ reply: result.reply }),
}
