// A BUILD IN THE BACKGROUND (docs/design/modes-and-builders.md M7/M10, step 5b — Roy, 2026-11-20): after the question
// card is answered, the builder works on its own while the chat goes back to General — Axl answers meanwhile.
//
// The build lives on the builder's own state (one per builder — the state IS the work on its table):
//   build: { id, status, title, since, readyAt?, pending? }
//     queued    another builder is building — its answers wait in `pending` (M10: one build at a time)
//     building  the builder's turns run in the background: they keep no floor and their replies are the build's
//               (ref.build — the work pane shows them, the chat does not)
//     awaiting  the builder needs the user: a turn ended with nothing in flight and no go — its last reply comes into
//               the chat, and the mode goes back to the builder (the user's reply goes to it)
//     ready     the builder said go: built, waiting for the user's Confirm (Generate) — never saved on its own
//     failed    a turn failed
//
// Every call here is made under the session's desk lock (a turn's, a commit's); a queued build's first turn is started
// fire-and-forget, so it queues behind the lock instead of waiting for it.

import { randomUUID } from 'node:crypto'
import { sessionService } from '../session.service.js'
import { sessionDepth } from './turnLock.js'
import { logger } from '../logger.service.js'

const LOG = '[builds]'
// A build turn that stopped on a STATEMENT, not a question — "the earlier price figures are not in this turn, I won't
// invent them" (the drive, 2026-11-20) — has nobody to say "go on" in the background: the build says it, this many times.
export const MAX_CARRIES = 3

/**
 * Does a builder's reply ask the user something? A question mark near its end (its last 400 characters — a question with
 * its options listed under it still counts). In doubt it does: a question is the user's, never carried past. Pure.
 */
export function asksTheUser(text) {
    return /\?/.test(String(text ?? '').trim().slice(-400))
}

/** The app's note that carries a stalled build on. Pure. */
export function carryLine() {
    return "[App note, not the user's words: the user is not here — the build runs in the background. Carry on building from where you stopped: " +
        "call your tools again for any figure you need (a previous turn's numbers are not repeated to you), and finish it. Ask the user only " +
        'what their answers do not settle.]'
}
export const BUILDERS = Object.freeze(['mentor', 'portfolio', 'analyst'])
export const ACTIVE = Object.freeze(['building', 'awaiting'])
const now = () => Date.now()

/** The builder's build, or null. */
export const buildOf = (state) => state?.build ?? null
/** Is the builder working in the background right now? */
export const isBuilding = (state) => state?.build?.status === 'building'
/** The ref a line said FOR a build carries — the pane's, not the chat's — or null (no build in the background). */
export const buildRef = (state) => (isBuilding(state) ? { build: state.build.id } : null)

/** The work a build is about, in a few words — "NVDA trade", "Growth book". Pure. */
export function buildTitle(agent, answers = {}, state = null) {
    if (agent === 'mentor') {
        const name = String(answers.name?.choice && answers.name.choice !== 'Find one for me' ? answers.name.choice : answers.name?.other ?? state?.active_asset ?? '').trim().toUpperCase()
        return name ? `${name} trade` : 'a trade'
    }
    if (agent === 'portfolio') {
        const obj = String(answers.objective?.choice ?? answers.objective?.other ?? '').trim()
        return obj ? `${obj} book` : 'a portfolio'
    }
    return 'coverage'
}

/** Is anything still in flight for this builder's build — a read it waits on, a chain step, a held go, a queued turn? */
export function stillWorking(session, agent, depth = 0) {
    const chain = session?.chain
    if (chain && chain.status !== 'done' && (chain.origin === agent || chain.current?.to === agent)) return true
    if (session?.agentState?.[agent]?.go_pending) return true
    if (Object.values(session?.waiting ?? {}).some(w => w && w.kind !== 'echo_map')) return true
    return depth > 1
}

/** The builds in a session, for Axl's turn context — one line each. Pure. */
export function buildLines(agentState = {}) {
    const ROLE = { mentor: 'the trader', portfolio: 'the portfolio manager', analyst: 'the analyst' }
    const SAY = { queued: 'queued behind another build', building: 'building in the background', awaiting: 'waiting for the user in its own mode', ready: 'READY — waiting for the user to review and Generate it in the pane', failed: 'failed — the user can try it again' }
    return BUILDERS.map(a => [a, agentState?.[a]?.build]).filter(([, b]) => b && SAY[b.status])
        .map(([a, b]) => `- ${ROLE[a]}: ${b.title} — ${SAY[b.status]}`)
}

// The turn path, imported when a queued build starts: turns.js → … → here would otherwise be a cycle.
const defaultRunTurn = async (args) => (await import('./turns.js')).runQueued(args)

export function makeBuilds({ sessions = sessionService, depth = sessionDepth, runTurn = defaultRunTurn } = {}) {
    const write = (user, sessionId, agent, state) => sessions.setAgentState({ sessionId, userId: user._id, agent, state })

    /**
     * Start a build from the answered card — or queue it behind the one running (M10). The caller holds the lock and runs
     * the first turn when `run` is true.
     * @returns {Promise<{ run: boolean, build: object }>}
     */
    async function start({ user, sessionId, agent, state, title, text, input }) {
        const session = await sessions.get({ sessionId, userId: user._id })
        const busy = BUILDERS.some(a => a !== agent && ACTIVE.includes(session?.agentState?.[a]?.build?.status))
        // The account(s) picked on the card go with the build: its later turns are chain steps (a read landing) that carry
        // none of their own — without them the trader stopped to ask for the account (the drive, 2026-11-20).
        const accounts = Array.isArray(input?.accounts) && input.accounts.length ? { accounts: input.accounts, mainAccountId: input.mainAccountId ?? null } : {}
        const build = { id: `bld_${randomUUID().slice(0, 8)}`, status: busy ? 'queued' : 'building', title, since: now(), ...accounts, ...(busy ? { pending: { text, input } } : {}) }
        await write(user, sessionId, agent, { ...(state ?? {}), build })
        logger.info(LOG, busy ? 'build queued' : 'build started', { sessionId, agent, title })
        return { run: !busy, build }
    }

    /** Start the oldest queued build, if no build is running. Fire-and-forget: its turn queues behind the caller's lock. */
    async function startNext({ user, sessionId }) {
        const session = await sessions.get({ sessionId, userId: user._id })
        const st = session?.agentState ?? {}
        if (BUILDERS.some(a => ACTIVE.includes(st[a]?.build?.status))) return null
        const [agent] = BUILDERS.filter(a => st[a]?.build?.status === 'queued').sort((a, b) => st[a].build.since - st[b].build.since)
        if (!agent) return null
        const { pending, ...b } = st[agent].build
        await write(user, sessionId, agent, { ...st[agent], build: { ...b, status: 'building', since: now() } })
        runTurn({ user, sessionId, agent, text: pending?.text ?? '', input: pending?.input ?? {}, origin: 'opening', turnId: `build_${b.id}_${now()}` })
            .catch(err => logger.warn(LOG, 'queued build failed to start', err.message))
        return agent
    }

    /**
     * Carry a build on with the app's note — after a turn that stopped on a statement, or a go that was not ready yet (the
     * reason in `note`). At most MAX_CARRIES a build. Fire-and-forget (the turn queues behind the caller's lock).
     * @returns {Promise<boolean>} false when the carries are spent (the build is the user's then)
     */
    async function carry({ user, sessionId, agent, note = null }) {
        const session = await sessions.get({ sessionId, userId: user._id })
        const state = session?.agentState?.[agent]
        const b = state?.build
        if (!b || b.status !== 'building' || (b.carries ?? 0) >= MAX_CARRIES) return false
        await write(user, sessionId, agent, { ...state, build: { ...b, carries: (b.carries ?? 0) + 1 } })
        runTurn({ user, sessionId, agent, text: note ? `${carryLine()}\n${note}` : carryLine(), input: {}, origin: 'opening', turnId: `build_${b.id}_carry_${now()}` })
            .catch(err => logger.warn(LOG, 'carry failed to start', err.message))
        logger.info(LOG, 'build carried on', { sessionId, agent, carries: (b.carries ?? 0) + 1, note: note ? 'not ready' : 'statement' })
        return true
    }

    /** The builder said go: built, waiting for the user's Confirm. Then the next queued build. */
    async function ready({ user, sessionId, agent }) {
        const session = await sessions.get({ sessionId, userId: user._id })
        const state = session?.agentState?.[agent]
        if (!state?.build) return false
        await write(user, sessionId, agent, { ...state, build: { ...state.build, status: 'ready', readyAt: now() } })
        logger.info(LOG, 'build ready', { sessionId, agent, title: state.build.title })
        await startNext({ user, sessionId })
        return true
    }

    /**
     * After a builder's turn (runQueued, inside the lock): a build still building with nothing in flight needs the user —
     * its last reply comes into the chat and the mode goes back to the builder. A failed turn fails the build.
     */
    async function settle({ user, sessionId, agent, out }) {
        if (!BUILDERS.includes(agent)) return null
        const session = await sessions.get({ sessionId, userId: user._id })
        const state = session?.agentState?.[agent]
        const b = state?.build
        if (!b || b.status !== 'building') return null
        if (out?.reason === 'error') {
            await write(user, sessionId, agent, { ...state, build: { ...b, status: 'failed' } })
            await startNext({ user, sessionId })
            return 'failed'
        }
        if (out?.stopped || stillWorking(session, agent, depth(sessionId))) return null
        const rows = await sessions.messagesForAgent({ sessionId, userId: user._id, agent, afterSeq: 0 })
        const last = [...(rows ?? [])].reverse().find(r => r.role === 'assistant' && r.ref?.build === b.id)
        // Stopped on a statement, not a question: carry it on (a few times) rather than hand it to the user.
        if (!asksTheUser(last?.content) && await carry({ user, sessionId, agent })) return 'carried'
        if (last) {
            const { build: _hidden, ...ref } = last.ref
            await sessions.updateRef({ sessionId, userId: user._id, seq: last.seq, ref: { ...ref, fromBuild: b.id } })
        }
        await write(user, sessionId, agent, { ...state, build: { ...b, status: 'awaiting' } })
        await sessions.setFloor({ sessionId, userId: user._id, agent })
        logger.info(LOG, 'build needs the user', { sessionId, agent, title: b.title })
        return 'awaiting'
    }

    return { start, startNext, carry, ready, settle }
}

export const builds = makeBuilds()
