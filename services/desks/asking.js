// A BUILDER'S QUESTION CARD, posted and answered (docs/design/modes-and-builders.md step 4). The card itself is
// desks/questions.js (pure); this is its life in the session:
//
//   post     a new build starts (the picker, a route's opening, the user's first message) → the card as a 'questions'
//            row (`ref.state: 'open'`), the builder's state marked `asking` (the card's seq and the turn's input)
//   answer   POST /sessions/:id/answers → checked, the card marked answered, `asking` → `asked`, and the builder's
//            turn runs on the answers as its opening, with the account(s) the user picked
//   set aside  the user types instead of answering → the card goes, the build goes on in words (sessionTurn)
//
// Built as a factory so the tests run it on memDb.

import { sessionService } from '../session.service.js'
import { userProfileService } from '../userProfile.service.js'
import { withSessionLock } from './turnLock.js'
import { questionsFor, checkAnswers, answersText } from './questions.js'
import { logger } from '../logger.service.js'

const LOG = '[asking]'
export const CARD_LINE = 'A few questions before I build it.'

// The per-turn input a card keeps for the answer's turn — the seed (a Hotlist hand-off's levels), the clock. Never the
// accounts: the answer names them.
const keptInput = (input = {}) => ({ ...(input.seed ? { seed: input.seed } : {}), ...(input.clientTime ? { clientTime: input.clientTime } : {}) })

// The turn path, imported when an answer runs its turn: turns.js → … → sessionTurn → here would otherwise be a cycle.
const defaultRunTurn = async (args) => (await import('./turns.js')).runQueued(args)

export function makeAsking({ sessions = sessionService, profiles = userProfileService, lock = withSessionLock, runTurn = defaultRunTurn } = {}) {
    /**
     * Post the card for a new build. The caller holds the session lock (a turn, the mode switch).
     * @returns {Promise<{ seq: number } | { reason: string }>}
     */
    async function post({ user, sessionId, agent, state = null, input = {} }) {
        const profile = await profiles.read(user._id).catch(() => null)
        // The name the build came with: a hand-off's seed, the route's ticker (runner.followRoute), the desk's own.
        const symbol  = input.seed?.ticker ?? input.routeSymbol ?? state?.active_asset ?? null
        const questions = questionsFor(agent, { symbol, size: profile?.size ?? null })
        if (!questions) return { reason: 'no_questions' }
        const row = await sessions.append({ sessionId, userId: user._id, message: {
            agent, role: 'assistant', kind: 'questions', content: CARD_LINE, ref: { state: 'open', questions },
        } })
        if (!row?.message) return { reason: row?.reason ?? 'not_found' }
        await sessions.setAgentState({ sessionId, userId: user._id, agent, state: { ...(state ?? {}), asking: { seq: row.message.seq, input: keptInput(input) } } })
        return { seq: row.message.seq }
    }

    /** The user typed instead of answering: the card is set aside, and the build goes on in words. Caller holds the lock. */
    async function setAside({ user, sessionId, agent, state }) {
        const seq = state?.asking?.seq
        if (!Number.isFinite(seq)) return state
        const card = (await sessions.messagesSince({ sessionId, userId: user._id, afterSeq: seq - 1, limit: 1 }))?.[0]
        if (card?.kind === 'questions') await sessions.updateRef({ sessionId, userId: user._id, seq, ref: { ...card.ref, state: 'set_aside' }, match: { 'ref.state': 'open' } }).catch(() => {})
        const { asking: _gone, ...rest } = state
        return { ...rest, asked: true }
    }

    /**
     * Answer the open card: checked, marked, and the builder's turn run on the answers.
     * @param {{ user, sessionId, seq: number, answers: object, accounts: object[], mainAccountId?: string|null, clientTime?: object }} p
     * @returns {Promise<{ turnId: string, agent: string } | { reason: string }>}
     */
    async function answer({ user, sessionId, seq, answers, accounts = [], mainAccountId = null, clientTime = null }) {
        const ready = await lock(sessionId, async () => {
            const session = await sessions.get({ sessionId, userId: user._id })
            if (!session || session.status !== 'active') return { reason: 'not_found' }
            const card = (await sessions.messagesSince({ sessionId, userId: user._id, afterSeq: Number(seq) - 1, limit: 1 }))?.[0]
            if (!card || card.seq !== Number(seq) || card.kind !== 'questions') return { reason: 'not_found' }
            if (card.ref?.state !== 'open') return { reason: 'already_answered' }
            const agent = card.agent
            const state = session.agentState?.[agent] ?? null
            if (state?.asking?.seq !== card.seq) return { reason: 'stale_card' }
            const checked = checkAnswers(card.ref.questions, answers)
            if (!checked.ok) return { reason: checked.reason }
            // The accounts the turn binds to are the ones the user picked — and only those.
            const picked = Object.values(checked.answers).flatMap(a => a.accountIds ?? [])
            const chosen = (Array.isArray(accounts) ? accounts : []).filter(a => a && picked.includes(String(a.id)))
            if (picked.length && chosen.length !== picked.length) return { reason: 'unknown_account' }
            const marked = await sessions.updateRef({ sessionId, userId: user._id, seq: card.seq, ref: { ...card.ref, state: 'answered', answers: checked.answers }, match: { 'ref.state': 'open' } })
            if (marked.reason) return { reason: 'already_answered' }
            const { asking, ...rest } = state
            await sessions.setAgentState({ sessionId, userId: user._id, agent, state: { ...rest, asked: true } })
            await sessions.setFloor({ sessionId, userId: user._id, agent })
            const main = mainAccountId && picked.includes(String(mainAccountId)) ? String(mainAccountId) : (picked[0] ?? null)
            return {
                agent, text: answersText(agent, card.ref.questions, checked.answers),
                input: { ...(asking?.input ?? {}), accounts: chosen, mainAccountId: main, answered: true, ...(clientTime ? { clientTime } : {}) },
            }
        })
        if (ready.reason) return ready
        const turnId = `answers_${sessionId}_${Date.now()}`
        runTurn({ user, sessionId, agent: ready.agent, text: ready.text, input: ready.input, origin: 'opening', turnId })
            .catch(err => logger.warn(LOG, 'the answers turn failed', err.message))
        return { turnId, agent: ready.agent }
    }

    return { post, setAside, answer }
}

export const asking = makeAsking()
