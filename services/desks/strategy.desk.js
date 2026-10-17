// Pythia — the industry desk (admin, its own panel and session scope). Working state: the chat state
// its client sends (the industry in focus, a review reason).
// One definition for the HTTP desk stream and the session turn (unified-chat plan phase 4).

import { strategyAgentService } from '../agents/strategy.agent.service.js'

export const strategyDesk = {
    agent: 'strategy',
    log:   '[strategy:desk]',
    parse: (body, turn) => ({ state: turn.chatState ?? {} }),
    // Unsealed work: industry-view drafts not yet published.
    hasWork: (state) => (state?.draftViews?.length ?? 0) > 0,
    // The focus (industry, review reason) carries over; the drafts on the table are the latest ones.
    nextState: (prev, result) => ({ ...(prev ?? {}), draftViews: result.views?.length ? result.views : (prev?.draftViews ?? []) }),
    run: ({ state, emit, common }) => strategyAgentService.chatStream({
        ...common,
        chatState: state ?? {},
        onPhase:   phase => emit('phase', { phase }),
    }),
    // The <industry_view> drafts, for preview — publishing is POST /industries/:code.
    done: (result) => ({ reply: result.reply, phase: result.phase ?? null, views: result.views ?? [], assessments: result.assessments ?? [] }),
}
