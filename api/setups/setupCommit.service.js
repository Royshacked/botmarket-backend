// What saving or arming a setup DOES beyond the write — one service for the setup routes and Mentor's session
// actions (unified-chat plan phase 8a CR), as coverageCommit and portfolioCommit are for theirs.
//
//   commitSetup  Generate: persist the draft — and when it UPDATES a setup in place, close the cards that asked for
//                it (a redraw, an invalidation). THE RE-DRAW IS THE WORK LANDING: an in-place update does not come
//                through the shared PATCH door, so the card lifecycle is closed here or not at all.
//   armSetup     Arm ('waiting' → 'looking', the gate re-run in patchSetup) — and the cards about it closed, as the
//                shared PATCH door does for the route.
//
// After the write, never before — a refused update has satisfied nothing. Non-fatal by contract (resolveCardsFor
// swallows its own failures). A NEW setup satisfies no outstanding ask.

import { setupService as defaultSetups } from './setups.service.js'
import { resolveCardsFor as defaultResolveCards } from '../chat/chat.service.js'

export function makeSetupCommit({ setups = defaultSetups, resolveCards = defaultResolveCards } = {}) {

    async function commitSetup(draft, opts = {}) {
        const out = await setups.generateSetup(draft, opts)
        if (out.ok && opts.updateId) await resolveCards({ kind: 'setup', id: opts.updateId }, { outcome: 'completed' })
        return out
    }

    async function armSetup(id, userId) {
        const out = await setups.patchSetup(id, { status: 'looking' }, userId)
        if (out.ok) await resolveCards({ kind: 'setup', id }, { outcome: 'completed' })
        return out
    }

    return { commitSetup, armSetup, generateSetups: (...a) => setups.generateSetups(...a) }
}

export const setupCommit = makeSetupCommit()
