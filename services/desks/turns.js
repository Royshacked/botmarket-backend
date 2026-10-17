// The session's turns and its chain, wired as one pair (unified-chat plan phase 5).
//
// They need each other: a turn's after-hook is the chain runner (what runs next), and the runner queues
// its chain turns through the same queued-turn path a user turn takes (one at a time per session,
// stoppable, streamed). Constructed here, once, so neither module imports the other.

import { makeStartTurn } from './startTurn.js'
import { makeChainRunner } from '../chain/runner.js'

export const chain = makeChainRunner()

const turns = makeStartTurn({ afterTurn: chain.afterTurn, onUserTurn: chain.requestPause })
chain.bindRunQueued(turns.runQueued)

export const { startTurn, runQueued } = turns
