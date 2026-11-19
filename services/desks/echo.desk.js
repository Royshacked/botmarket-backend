// Echo — the event desk (docs/design/echo-desk.md, echo-pipeline.md). Conversational: no working state, no entity — a
// user's event is saved by its tool (map_event → echoEvents + the pipeline, `echo_events`). Reached from Axl
// (registry routedFrom), the Hotlist's Echo tab, or opened directly. One definition for the session turn.

import { echoAgentService } from '../agents/echo.agent.service.js'

export const echoDesk = {
    agent: 'echo',
    log:   '[echo:desk]',
    run:   ({ common }) => echoAgentService.chatStream(common),
    done:  (result) => ({ reply: result.reply }),
}
