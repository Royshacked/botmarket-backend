// Proteus — the technical analysis desk (docs/design/proteus.md). Conversational: no working state, no entity — his
// profile is the house's, kept by behaviourProfile.service. Reached from Axl and Mentor (registry routedFrom), or
// opened directly. One definition for the session turn (unified-chat plan phase 4).

import { proteusAgentService } from '../agents/proteus.agent.service.js'

export const proteusDesk = {
    agent: 'proteus',
    log:   '[proteus:desk]',
    run:   ({ common }) => proteusAgentService.chatStream(common),
    done:  (result) => ({ reply: result.reply }),
}
