// Every desk definition, by agent key — what the session turn dispatches on. The HTTP controllers import
// their own desk directly; this map exists for the callers that pick a desk at run time (sessionTurn,
// and the chain runner in plan phase 5).

import { axlDesk } from './axl.desk.js'
import { mentorDesk } from './mentor.desk.js'
import { portfolioDesk } from './portfolio.desk.js'
import { scannerDesk } from './scanner.desk.js'
import { analystDesk } from './analyst.desk.js'
import { strategyDesk } from './strategy.desk.js'
import { aetherDesk } from './aether.desk.js'

/**
 * Whether an agent holds UNSEALED work — what the busy rule and openForEdit ask before taking it over. Each
 * desk says what work is (its `hasWork`); a state that is only mode or markers is not work.
 */
export function hasWork(agent, state) {
    return !!state && !!DESK_DEFS[agent]?.hasWork?.(state)
}

export const DESK_DEFS = Object.freeze({
    axl: axlDesk, mentor: mentorDesk, portfolio: portfolioDesk, scanner: scannerDesk,
    analyst: analystDesk, strategy: strategyDesk, aether: aetherDesk,
})
