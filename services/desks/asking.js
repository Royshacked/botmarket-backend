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
import { builds as defaultBuilds, buildTitle } from './builds.js'
import { candidates as defaultCandidates, pickQuestion, FIND_ONE } from './candidates.js'
import { logger } from '../logger.service.js'

const LOG = '[asking]'
export const CARD_LINE = 'A few questions before I build it.'

// The per-turn input a card keeps for the answer's turn — the seed (a Hotlist hand-off's levels), the clock. Never the
// accounts: the answer names them.
const keptInput = (input = {}) => ({ ...(input.seed ? { seed: input.seed } : {}), ...(input.clientTime ? { clientTime: input.clientTime } : {}) })

// The turn path, imported when an answer runs its turn: turns.js → … → sessionTurn → here would otherwise be a cycle.
const defaultRunTurn = async (args) => (await import('./turns.js')).runQueued(args)

export function makeAsking({ sessions = sessionService, profiles = userProfileService, lock = withSessionLock, runTurn = defaultRunTurn, builds = defaultBuilds, finder = defaultCandidates } = {}) {
    /**
     * "Find one for me" (M18, step 8): the stock picker's candidates, then a card to pick from — the build waits on it.
     * Fire-and-forget after the answer; the card is posted under the lock.
     */
    async function pickJob({ user, sessionId, agent }) {
        const found = await finder.find({ userId: user._id })
        await lock(sessionId, async () => {
            const session = await sessions.get({ sessionId, userId: user._id })
            const state = session?.agentState?.[agent]
            const b = state?.build
            if (!b || b.status !== 'building' || !b.picking) return
            const card = await sessions.append({ sessionId, userId: user._id, message: {
                agent, role: 'assistant', kind: 'questions', content: 'Pick the name for the trade.',
                ref: { state: 'open', mid: true, pick: true, buildId: b.id, questions: [pickQuestion(found.candidates, found.reply)] },
            } })
            await sessions.setAgentState({ sessionId, userId: user._id, agent, state: { ...state, build: { ...b, status: 'awaiting', ...(card?.message ? { card: card.message.seq } : {}) } } })
        }).catch(err => logger.warn(LOG, 'the pick card failed', err.message))
    }

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
            // A BUILD's question, mid-build (step 8): the answer sends it back to work, the chat stays where it is.
            if (card.ref.mid) {
                if (state?.build?.id !== card.ref.buildId || state.build.status !== 'awaiting') return { reason: 'stale_card' }
                const midChecked = checkAnswers(card.ref.questions, answers)
                if (!midChecked.ok) return { reason: midChecked.reason }
                const marked = await sessions.updateRef({ sessionId, userId: user._id, seq: card.seq, ref: { ...card.ref, state: 'answered', answers: midChecked.answers }, match: { 'ref.state': 'open' } })
                if (marked.reason) return { reason: 'already_answered' }
                // The pick card: the trader builds on the name picked; any other card: back to work with the answer.
                const picked = card.ref.pick ? String(midChecked.answers.name?.other || midChecked.answers.name?.choice || '').toUpperCase().trim() : null
                const said = answersText(agent, card.ref.questions, midChecked.answers).split('\n').filter(l => l.startsWith('- ')).join('\n')
                const r = picked
                    ? await builds.resume({ user, sessionId, agent, pick: picked })
                    : await builds.resume({ user, sessionId, agent, text: `My answer:\n${said}` })
                return r.reason ? r : { agent, mid: true }
            }
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
            const main = mainAccountId && picked.includes(String(mainAccountId)) ? String(mainAccountId) : (picked[0] ?? null)
            const text = answersText(agent, card.ref.questions, checked.answers)
            const input = { ...(asking?.input ?? {}), accounts: chosen, mainAccountId: main, answered: true, ...(clientTime ? { clientTime } : {}) }
            // THE BUILD GOES TO THE BACKGROUND (step 5b): the chat is back with Axl, and the builder works — or waits its
            // turn behind the build already running (M10).
            const started = await builds.start({ user, sessionId, agent, state: { ...rest, asked: true }, title: buildTitle(agent, checked.answers, state), text, input })
            await sessions.setFloor({ sessionId, userId: user._id, agent: 'axl' })
            // No name ("Find one for me"): the build waits for the user's pick before the trader runs (M18).
            const picking = agent === 'mentor' && started.run && checked.answers.name?.choice === FIND_ONE && !checked.answers.name?.other
            if (picking) {
                const now = (await sessions.get({ sessionId, userId: user._id }))?.agentState?.[agent]
                await sessions.setAgentState({ sessionId, userId: user._id, agent, state: { ...now, build: { ...now.build, picking: true, pending: { text, input } } } })
            }
            return { agent, text, input, run: started.run, build: started.build, picking }
        })
        if (ready.reason) return ready
        if (ready.mid) return { agent: ready.agent, resumed: true }
        if (!ready.run) return { agent: ready.agent, queued: true, build: ready.build.id }
        if (ready.picking) {
            pickJob({ user, sessionId, agent: ready.agent }).catch(() => {})
            return { agent: ready.agent, picking: true, build: ready.build.id }
        }
        const turnId = `answers_${sessionId}_${Date.now()}`
        runTurn({ user, sessionId, agent: ready.agent, text: ready.text, input: ready.input, origin: 'opening', turnId })
            .catch(err => logger.warn(LOG, 'the answers turn failed', err.message))
        return { turnId, agent: ready.agent, build: ready.build.id }
    }

    return { post, setAside, answer }
}

export const asking = makeAsking()
