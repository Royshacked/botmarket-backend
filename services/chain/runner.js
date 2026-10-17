// The chain runner (unified-chat plan phase 5c, decision 11: the SERVER runs the chain).
//
// After EVERY turn — the user's or the chain's — it asks the reply three things, from the declared tables
// (rules.js), never the model's say-so:
//   needs the user?  → a `decision` message (with taps when there is a choice) and the chain stops;
//   routed?          → the chain stops (the floor moved; the user's next message is the next turn);
//   emitted an artifact? → a `handoff` message (sender → receiver, the receiver's brief) and the receiver's
//                          turn runs, queued, with no user message.
// Answering a decision by typing is just the next turn. Only four things need an explicit continue (a tap):
// a paused chain, an interrupted one, the step cap, and a real choice (research a list; a busy agent; the
// next name in a research queue).
//
// The chain's state lives on the session (`session.chain`), written BEFORE each step — a restart finds it,
// and the boot sweep pauses it and asks (G4: never an automatic re-run).

import { sessionService } from '../session.service.js'
import { deskOf } from '../desks/registry.js'
import { DESK_DEFS } from '../desks/index.js'
import { canSpeak } from '../desks/sessionTurn.js'
import { KIND, makeArtifact } from './artifact.js'
import { receiverOf, briefFor } from './contracts.js'
import { emitted, decisionFor, researchQueueFrom } from './rules.js'
import { logger } from '../logger.service.js'

const LOG = '[chain]'
export const MAX_STEPS = 12

const newChain = (origin) => ({
    id: `chn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'running', origin, steps: 0, startedAt: Date.now(),
    next: null, current: null, queue: null, awaiting: null, pauseRequested: false,
})

export function makeChainRunner({ sessions = sessionService, desks = DESK_DEFS, maxSteps = MAX_STEPS } = {}) {
    // The queued-turn runner (startTurn's runQueued) — bound after construction, because it needs this
    // runner's afterTurn in return (services/desks/turns.js wires the pair).
    let runQueued = null
    const bindRunQueued = (fn) => { runQueued = fn }

    const save = (user, sessionId, chain) => sessions.setChain({ sessionId, userId: user._id, chain })

    async function decide({ user, sessionId, agent, decision, chain }) {
        await sessions.append({ sessionId, userId: user._id, message: {
            agent, role: 'assistant', kind: 'decision', content: decision.question,
            ref: { choices: decision.choices, view: agent },
        } })
        if (chain) {
            await save(user, sessionId, {
                ...chain, pauseRequested: false,
                status:   decision.choices.length ? 'awaiting' : 'waiting',
                awaiting: decision.choices.length ? { agent, choices: decision.choices.map(c => c.id) } : null,
            })
        }
    }

    /** Hand an artifact to its receiver and run the receiver's turn. */
    async function hop({ user, session, chain, art, from, index = 0, force = false }) {
        const sessionId = session.sessionId
        const to = receiverOf(art)
        if (!to || !canSpeak(to, session, user)) { await save(user, sessionId, { ...chain, status: 'done' }); return }

        // BUSY: the receiver holds the user's own unsealed work — ask before the chain takes it over.
        const theirs = session.agentState?.[to] ?? null
        if (!force && theirs && theirs.chainId !== chain.id) {
            return decide({ user, sessionId, agent: 'axl', chain: { ...chain, next: { art, from, index } }, decision: {
                question: `${deskOf(to).brand} is in the middle of something else — finish that first or set it aside?`,
                choices: [{ id: 'finish', label: 'Finish that first' }, { id: 'aside', label: 'Set it aside' }],
            } })
        }
        if (chain.steps >= maxSteps) {
            return decide({ user, sessionId, agent: from, chain: { ...chain, next: { art, from, index } }, decision: {
                question: `The chain has taken ${chain.steps} steps on its own — keep going?`,
                choices: [{ id: 'more', label: 'Keep going' }],
            } })
        }

        const brief = briefFor(art, { index })
        await sessions.append({ sessionId, userId: user._id, message: {
            agent: from, role: 'assistant', kind: 'handoff', to, content: brief.text,
            ref: { artifact: { kind: art.kind, key: art.key, items: art.items, context: art.context, status: art.status } },
        } })
        // The receiver works FOR this chain now: its state is marked, which is what the busy rule reads.
        await sessions.setAgentState({ sessionId, userId: user._id, agent: to, state: {
            ...(force || !theirs ? (desks[to]?.emptyState?.() ?? {}) : theirs), chainId: chain.id,
        } })
        await sessions.setFloor({ sessionId, userId: user._id, agent: to })
        const step = chain.steps + 1
        // Written BEFORE the turn runs: a restart mid-turn finds `current` and can offer to run it again.
        await save(user, sessionId, {
            ...chain, status: 'running', steps: step, next: null, awaiting: null, pauseRequested: false,
            current: { to, input: brief.input, step },
            queue:   art.context?.queued ? { artifact: art, index } : chain.queue,
        })
        runQueued?.({ user, sessionId, agent: to, text: null, input: brief.input, turnId: `${chain.id}_${step}`, origin: 'chain' })
            .catch(err => logger.warn(LOG, 'chain turn failed', err.message))
    }

    /** startTurn's after-hook: what, if anything, runs next. */
    async function afterTurn({ user, sessionId, agent, origin, out }) {
        if (!out || out.reason) return
        const session = await sessions.get({ sessionId, userId: user._id })
        if (!session) return
        let chain = session.chain && session.chain.status !== 'done' ? session.chain : null

        if (out.stopped) { if (chain) await save(user, sessionId, { ...chain, status: 'paused', current: null }); return }

        const payload = out.payload
        const state   = session.agentState?.[agent] ?? null
        const decision = decisionFor(agent, payload, state, chain)
        const art = decision || payload?.route ? null : emitted(agent, payload, state)

        // The user interjected while this chain turn ran: stop here, keep what comes next, ask.
        if (origin === 'chain' && chain?.pauseRequested) {
            return decide({ user, sessionId, agent, chain: { ...chain, next: art ? { art, from: agent, index: 0 } : null, current: null }, decision: {
                question: 'Paused while you spoke — continue the chain?', choices: art ? [{ id: 'continue', label: 'Continue' }] : [],
            } })
        }
        if (decision) {
            // Inside a chain, or when there is a real choice, the decision shows in the timeline as a card.
            if (chain || decision.choices.length) return decide({ user, sessionId, agent, decision, chain: chain ?? newChain(agent) })
            return
        }
        if (payload?.route || !art) { if (chain) await save(user, sessionId, { ...chain, status: 'done', current: null }); return }
        return hop({ user, session, chain: chain ?? newChain(agent), art, from: agent })
    }

    /** A user turn arrived while a chain runs: pause after the turn in flight (G4). */
    async function requestPause({ user, sessionId }) {
        const session = await sessions.get({ sessionId, userId: user._id })
        if (session?.chain?.status === 'running') await save(user, sessionId, { ...session.chain, pauseRequested: true })
    }

    /** A tap on a decision. @returns {{ ok: true } | { reason: string }} */
    async function resume({ user, sessionId, choice }) {
        const session = await sessions.get({ sessionId, userId: user._id })
        const chain   = session?.chain
        if (!session || session.status !== 'active') return { reason: 'not_found' }
        const allowed = chain?.awaiting?.choices ?? (chain?.status === 'paused' ? ['continue'] : [])
        if (!allowed.includes(choice)) return { reason: 'no_such_choice' }

        if (choice === 'continue' || choice === 'more' || choice === 'aside') {
            if (chain.next) {
                await hop({ user, session, chain: { ...chain, steps: choice === 'more' ? 0 : chain.steps }, ...chain.next, force: choice === 'aside' })
                return { ok: true }
            }
            if (chain.current) {   // interrupted mid-turn: run that step again, with the brief it had
                await save(user, sessionId, { ...chain, status: 'running', awaiting: null })
                runQueued?.({ user, sessionId, agent: chain.current.to, text: null, input: chain.current.input, turnId: `${chain.id}_${chain.current.step}_r`, origin: 'chain' })
                    .catch(err => logger.warn(LOG, 'chain re-run failed', err.message))
                return { ok: true }
            }
            await save(user, sessionId, { ...chain, status: 'done' })
            return { ok: true }
        }
        if (choice === 'finish' || choice === 'keep') { await save(user, sessionId, { ...chain, status: 'done', awaiting: null, next: null }); return { ok: true } }
        if (choice === 'research') {
            const art = researchQueueFrom(session.agentState?.scanner?.pendingScan)
            if (!art) return { reason: 'nothing_to_research' }
            await hop({ user, session, chain: { ...chain, status: 'running' }, art, from: 'scanner', index: 0 })
            return { ok: true }
        }
        if (choice === 'next') {
            const q = chain.queue
            if (q && q.index + 1 < q.artifact.items.length) {
                await hop({ user, session, chain, art: q.artifact, from: 'scanner', index: q.index + 1 })
                return { ok: true }
            }
            // The run is over: what came back goes to Atlas when Atlas started it; otherwise the chain ends.
            const done = makeArtifact({
                kind: KIND.COVERAGE_SET, from: { agent: 'analyst', label: 'Research' },
                items: (q?.artifact.items ?? []).map(c => ({ ticker: c.ticker, sector: q.artifact.context?.sector ?? null })),
                context: { unfilled: [], declined: [] },
            })
            if (chain.origin === 'portfolio') { await hop({ user, session, chain, art: done, from: 'analyst' }); return { ok: true } }
            await save(user, sessionId, { ...chain, status: 'done', queue: null, awaiting: null })
            return { ok: true }
        }
        return { reason: 'no_such_choice' }
    }

    /**
     * A sleeve Atlas sent to be sourced has settled (sleeveSource → onSleeveSettled, plan phase 5d). The
     * screen is code (decision 1a), shown as ARGUS's work: Argus's line goes into Argus's segment — so a
     * follow-up to Argus can be answered — then what came back is handed to Atlas as a coverage set, saying
     * what did NOT come back too. Answers false when the session is gone, so the card is posted instead.
     */
    async function sleeveSettled(sleeve, outcome) {
        const user    = { _id: sleeve.userId }
        const session = await sessions.get({ sessionId: sleeve.sessionId, userId: user._id })
        if (!session || session.status !== 'active') return false
        const school = sleeve.school ? ` (${sleeve.school})` : ''
        const tail = [
            outcome.passed.length     ? `${outcome.passed.length} passed on (no edge)` : null,
            outcome.failed.length     ? `${outcome.failed.length} failed to save` : null,
            outcome.unresolved.length ? `${outcome.unresolved.length} left unresearched` : null,
        ].filter(Boolean).join(', ')
        const line = outcome.covered.length
            ? `Screened ${outcome.screened} for the ${sleeve.sector} sleeve${school} → ${outcome.covered.length} now in coverage: ${outcome.covered.join(', ')}${tail ? `; ${tail}` : ''}.`
            : `Screened ${outcome.screened} for the ${sleeve.sector} sleeve${school} → none came into coverage${tail ? ` (${tail})` : ''}.`
        await sessions.append({ sessionId: sleeve.sessionId, userId: user._id, message: { agent: 'scanner', role: 'assistant', content: line } })

        const declined = [...outcome.passed, ...outcome.failed].map(ticker => ({ ticker, sector: sleeve.sector }))
        const art = makeArtifact({
            kind: KIND.COVERAGE_SET, from: { agent: 'analyst', label: 'Research' },
            items:   outcome.covered.map(ticker => ({ ticker, sector: sleeve.sector })),
            context: { unfilled: outcome.covered.length ? [] : [sleeve.sector], declined },
        })
        const chain = session.chain && session.chain.status !== 'done' ? session.chain : newChain('portfolio')
        await hop({ user, session, chain: { ...chain, origin: 'portfolio' }, art, from: 'analyst' })
        return true
    }

    /** At boot: every chain a restart cut off is PAUSED and its floor-holder asks (G4). */
    async function sweep() {
        const cut = await sessions.findRunningChains()
        for (const s of cut) {
            const user = { _id: s.userId }
            await save(user, s.sessionId, { ...s.chain, status: 'paused', next: null, awaiting: null, pauseRequested: false })
            await sessions.append({ sessionId: s.sessionId, userId: s.userId, message: {
                agent: s.chain.current?.to ?? s.floor ?? 'axl', role: 'assistant', kind: 'decision',
                content: 'I was interrupted — continue?', ref: { choices: [{ id: 'continue', label: 'Continue' }] },
            } })
        }
        if (cut.length) logger.info(LOG, `paused ${cut.length} chain(s) a restart cut off`)
        return cut.length
    }

    return { afterTurn, requestPause, resume, sweep, sleeveSettled, bindRunQueued }
}
