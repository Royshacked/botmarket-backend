// The chain runner (unified-chat plan phase 5c, decision 11: the SERVER runs the chain).
//
// After EVERY turn — the user's or the chain's — it asks the reply three things, from the declared tables
// (rules.js), never the model's say-so:
//   needs the user?  → a `decision` message (with taps when there is a choice) and the chain stops;
//   routed?          → the chain ends (the floor moved; the user's next message is the next turn);
//   emitted an artifact? → a `handoff` message (sender → receiver, the receiver's brief) and the receiver's
//                          turn runs, queued, with no user message.
// And what a ROUTE carries (plan phase 7, J4): the user's words for the desk it lands on (`opening`) run as
// that desk's first turn; an `edit` reopens the item it names, asking first when its desk holds other work.
// Answering a decision by typing is just the next turn. Only taps need an explicit continue: a paused or
// interrupted chain, the step cap, a real choice (research a list; a busy agent; the next name in a queue).
//
// The chain's state lives on the session (`session.chain`), written BEFORE each step — a restart finds it,
// and the boot sweep pauses it and asks (G4: never an automatic re-run). A chain step that is refused or
// fails pauses the chain and offers to try again — it is never left "running" with nothing in flight.

import { sessionService } from '../session.service.js'
import { deskOf, entryOf } from '../desks/registry.js'
import { DESK_DEFS, hasWork } from '../desks/index.js'
import { canSpeak } from '../desks/sessionTurn.js'
import { withSessionLock } from '../desks/turnLock.js'
import { findForEdit, lookupForEdit } from '../desks/entityLookup.js'
import { sealing as defaultSealing } from '../desks/seal.js'
import { isAdminUserCached } from '../../api/user/user.model.js'
import { coverageService } from '../../api/analyst/coverage.service.js'
import { KIND, makeArtifact } from './artifact.js'
import { receiverOf, briefFor } from './contracts.js'
import { emitted, decisionFor, researchQueueFrom } from './rules.js'
import { logger } from '../logger.service.js'

const LOG = '[chain]'
export const MAX_STEPS = 12
// The name a reopened item's card shows ("NVDA", "Growth book") instead of its id.
const nameOf = (doc) => doc?.asset ?? doc?.name ?? doc?.symbol ?? null
// What an opening may carry: the user's own sentence, passed on — never a document.
const MAX_OPENING_CHARS = 4000
// The per-turn extras the user's turn carried that the desk a route lands on needs too — never a card press's
// ops, a seed or a brief, which were for the turn they rode.
const carried = (input) => {
    const out = {}
    for (const k of ['accounts', 'mainAccountId', 'clientTime']) if (input?.[k] != null) out[k] = input[k]
    return out
}

const newChain = (origin) => ({
    id: `chn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'running', origin, steps: 0, startedAt: Date.now(),
    next: null, current: null, queue: null, awaiting: null, pauseRequested: false,
})

// The user a turn acts as when no request carries one (the restart sweep, a settled sleeve): the id AND the
// role — an admin's chain keeps an admin's reach (Atlas's coverage refresh is admin-only). The cached admin
// read every desk turn already uses, not a second lookup.
const _loadUser = async (userId) => ({ _id: String(userId), role: (await isAdminUserCached(userId)) ? 'admin' : 'trader' })

// Whether a name came into house coverage — what a finished research run reports to Atlas.
const _covered = async (ticker) => !!(await coverageService.getCoverageBySymbol(ticker))

export function makeChainRunner({
    sessions = sessionService, desks = DESK_DEFS, maxSteps = MAX_STEPS,
    loadUser = _loadUser, isCovered = _covered, lock = withSessionLock,
    findEdit = findForEdit, lookupEdit = lookupForEdit, sealing = defaultSealing, saveList = null,
} = {}) {
    // Argus's list, saved through ITS OWN action (Generate, or Update while a saved list is being refined) — the commit
    // a press on its surface makes. Injectable for the chain's suite, which has no database.
    const _saveList = saveList ?? (({ user, state }) => {
        const action = state?.editingScanId ? 'update' : 'generate'
        const run = desks.scanner?.actions?.[action]
        return run ? run({ user, state, args: {} }) : { reason: 'no_such_action' }
    })

    // The queued-turn runner (startTurn's runQueued) — bound after construction, because it needs this
    // runner's afterTurn in return (services/desks/turns.js wires the pair).
    let runQueued = null
    const bindRunQueued = (fn) => { runQueued = fn }

    const save = (user, sessionId, chain) => sessions.setChain({ sessionId, userId: user._id, chain })
    // A finished chain leaves nothing to tap: its choices, its pending step and its in-flight step all go.
    const end  = (user, sessionId, chain) => save(user, sessionId, { ...chain, status: 'done', awaiting: null, next: null, current: null, pending: null, pauseRequested: false })

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
        if (!to || !canSpeak(to, session, user)) return end(user, sessionId, chain)

        // BUSY: the receiver holds the user's own UNSEALED work (its desk says what work is) that this chain
        // did not give it — ask before the chain takes it over. The desk that started the chain is never busy
        // to it: Atlas's own sleeve coming back is the work Atlas is waiting for.
        const theirs = session.agentState?.[to] ?? null
        if (!force && to !== chain.origin && theirs?.chainId !== chain.id && hasWork(to, theirs)) {
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
        // The receiver works FOR this chain now (the busy rule reads the mark). Set aside → it starts clean;
        // otherwise what it holds is kept — a desk's own conversation-long state (Atlas's mandate) is not
        // thrown away to receive a hand-off.
        const base = force ? (desks[to]?.emptyState?.() ?? {}) : (theirs ?? desks[to]?.emptyState?.() ?? {})
        await sessions.setAgentState({ sessionId, userId: user._id, agent: to, state: { ...base, chainId: chain.id } })
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

    /** A route with the user's words: they run as the landing desk's first turn, queued like any turn. */
    function followRoute({ user, session, payload, turnId, input }) {
        const entry = entryOf(payload.route)
        const text  = typeof payload.opening === 'string' ? payload.opening.trim().slice(0, MAX_OPENING_CHARS) : ''
        if (!entry || !text || !canSpeak(entry.agent, session, user)) return
        // origin 'opening', not 'user': an opening runs ONE turn and never another opening or edit — two desks
        // routing to each other with openings would otherwise ping-pong paid turns with no cap and no chain to pause.
        runQueued?.({ user, sessionId: session.sessionId, agent: entry.agent, text, input: carried(input), turnId: `${turnId ?? 'turn'}_open`, origin: 'opening' })
            .catch(err => logger.warn(LOG, 'opening turn failed', err.message))
    }

    /**
     * An `edit`: reopen the item it names in the live session — the same openForEdit the edit route runs. Its
     * desk holding other unsealed work → ask (set it aside, or keep working). Nothing found → say so.
     */
    async function reopen({ user, sessionId, edit, agent }) {
        const say = (content) => sessions.append({ sessionId, userId: user._id, message: { agent, role: 'assistant', content } })
        const found = await findEdit({ kind: edit.kind, ref: edit.ref, user })
        if (!found.ok) {
            // Not theirs to revise (house coverage is an admin's) is a different answer from not found.
            return say(found.reason === 'forbidden'
                ? 'That one is not yours to change here — it is maintained by the house. I can show you what it says.'
                : 'I could not find that one to open — open it from its list and I will pick it up.')
        }
        const out = await sealing.openForEdit({ userId: user._id, sessionId, kind: edit.kind, entity: found.doc, name: nameOf(found.doc) })
        // Its desk lives in another chat (a setup asked for from Pythia's admin session): say where, move nothing.
        if (out.reason === 'wrong_scope') return say('That one opens in the main chat — reopen it there.')
        if (out.reason === 'busy') {
            return decide({ user, sessionId, agent: 'axl', chain: { ...newChain('axl'), pending: { edit: { kind: edit.kind, id: found.id } } }, decision: {
                question: `${deskOf(out.agent)?.brand ?? 'That desk'} is in the middle of something else — set it aside and open this?`,
                choices: [{ id: 'reopen', label: 'Set it aside and open it' }, { id: 'keep', label: 'Keep working' }],
            } })
        }
        if (out.reason) logger.warn(LOG, 'reopen refused', { kind: edit.kind, reason: out.reason })
    }

    /** startTurn's after-hook: what, if anything, runs next. */
    async function afterTurn({ user, sessionId, agent, turnId, origin, out, input }) {
        if (!out) return
        const session = await sessions.get({ sessionId, userId: user._id })
        if (!session) return
        let chain = session.chain && session.chain.status !== 'done' ? session.chain : null

        // A CHAIN step that was refused or failed: pause and offer to try it again — `current` still names it.
        if (out.reason) {
            if (origin === 'chain' && chain) {
                return decide({ user, sessionId, agent, chain: { ...chain, next: null }, decision: {
                    question: 'That step did not go through — try it again?', choices: [{ id: 'continue', label: 'Try again' }],
                } })
            }
            return
        }
        if (out.stopped) { if (chain) await save(user, sessionId, { ...chain, status: 'paused', current: null }); return }

        const payload  = out.payload
        const state    = session.agentState?.[agent] ?? null
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
        if (payload?.edit && origin === 'user') {
            if (chain) await end(user, sessionId, chain)
            return reopen({ user, sessionId, edit: payload.edit, agent })
        }
        if (payload?.route || !art) {
            if (chain) await end(user, sessionId, chain)
            if (payload?.route && origin === 'user') followRoute({ user, session, payload, turnId, input })
            return
        }
        return hop({ user, session, chain: chain ?? newChain(agent), art, from: agent })
    }

    /** A user turn arrived while a chain runs: pause after the turn in flight (G4). */
    async function requestPause({ user, sessionId }) {
        const session = await sessions.get({ sessionId, userId: user._id })
        if (session?.chain?.status === 'running') await save(user, sessionId, { ...session.chain, pauseRequested: true })
    }

    /**
     * A tap on a decision. @returns {{ ok: true } | { reason: string }}
     * Under the session lock, like every turn: its hand-off message must never interleave with a turn still
     * writing. (The receiver's turn it queues runs after the lock is released.)
     */
    function resume(args) { return lock(args.sessionId, () => _resume(args)) }

    async function _resume({ user, sessionId, choice }) {
        const session = await sessions.get({ sessionId, userId: user._id })
        const chain   = session?.chain
        if (!session || session.status !== 'active') return { reason: 'not_found' }
        // Only a chain that is actually waiting on the user takes a tap — a stale card on a finished chain does not.
        const allowed = chain?.status === 'awaiting' ? (chain.awaiting?.choices ?? [])
            : chain?.status === 'paused' ? ['continue', ...(chain.awaiting?.choices ?? [])]
            : []
        if (!allowed.includes(choice)) return { reason: 'no_such_choice' }

        if (choice === 'continue' || choice === 'more' || choice === 'aside') {
            if (chain.next) {
                await hop({ user, session, chain: { ...chain, steps: choice === 'more' ? 0 : chain.steps }, ...chain.next, force: choice === 'aside' })
                return { ok: true }
            }
            if (chain.current) {   // interrupted or failed mid-turn: run that step again, with the brief it had
                await save(user, sessionId, { ...chain, status: 'running', awaiting: null })
                runQueued?.({ user, sessionId, agent: chain.current.to, text: null, input: chain.current.input, turnId: `${chain.id}_${chain.current.step}_r${Date.now()}`, origin: 'chain' })
                    .catch(err => logger.warn(LOG, 'chain re-run failed', err.message))
                return { ok: true }
            }
            await end(user, sessionId, chain)
            return { ok: true }
        }
        if (choice === 'finish' || choice === 'keep') { await end(user, sessionId, chain); return { ok: true } }
        if (choice === 'reopen') {
            const edit  = chain.pending?.edit
            const found = edit ? await lookupEdit({ kind: edit.kind, id: edit.id, user }) : { ok: false }
            await end(user, sessionId, { ...chain, pending: null })
            if (!found.ok) return { reason: 'not_found' }
            const out = await sealing.openForEdit({ userId: user._id, sessionId, kind: edit.kind, entity: found.doc, name: nameOf(found.doc), force: true })
            return out.reason ? { reason: out.reason } : { ok: true }
        }
        if (choice === 'research') {
            const argus = session.agentState?.scanner ?? null
            const art = researchQueueFrom(argus?.pendingScan)
            if (!art) return { reason: 'nothing_to_research' }
            // SAVED FIRST, then researched (Roy 2026-10-17, phase 8d CR decision (a)) — the old one press: the list
            // reaches the Scans tab carrying the names that were NOT queued, which "also do KLAC" reads from later.
            // A list that did not save is not researched: the user would lose it to a hop they cannot see behind.
            const saved = await _saveList({ user, state: argus })
            if (!saved || saved.reason) return { reason: saved?.reason ?? 'save_failed' }
            if (saved.seal) {
                await sealing.sealFromSession({ userId: user._id, sessionId, agent: 'scanner', ...saved.seal })
                    .catch(err => logger.warn(LOG, 'seal after the research save failed (the list is saved)', err.message))
            }
            if (saved.after !== undefined) await sessions.setAgentState({ sessionId, userId: user._id, agent: 'scanner', state: saved.after })
            await hop({ user, session, chain: { ...chain, status: 'running' }, art, from: 'scanner', index: 0 })
            return { ok: true }
        }
        if (choice === 'next') {
            const q = chain.queue
            if (q && q.index + 1 < q.artifact.items.length) {
                await hop({ user, session, chain, art: q.artifact, from: 'scanner', index: q.index + 1 })
                return { ok: true }
            }
            // The run is over. What came back is what is IN coverage now — a name Prometheus passed on, or whose
            // draft was never initiated, is reported as researched-but-not-covered, never as covered.
            const sector = q?.artifact.context?.sector ?? null
            const items = [], declined = []
            for (const c of q?.artifact.items ?? []) {
                const row = { ticker: c.ticker, sector };
                (await isCovered(c.ticker) ? items : declined).push(row)
            }
            const done = makeArtifact({ kind: KIND.COVERAGE_SET, from: { agent: 'analyst', label: 'Research' }, items, context: { unfilled: [], declined } })
            if (chain.origin === 'portfolio') { await hop({ user, session, chain, art: done, from: 'analyst' }); return { ok: true } }
            await end(user, sessionId, { ...chain, queue: null })
            return { ok: true }
        }
        return { reason: 'no_such_choice' }
    }

    /**
     * A sleeve Atlas sent to be sourced has settled (sleeveSource → onSleeveSettled, plan phase 5d). The
     * screen is code (decision 1a), shown as ARGUS's work: Argus's line goes into Argus's segment — so a
     * follow-up to Argus can be answered — then what came back is handed to Atlas as a coverage set, saying
     * what did NOT come back too. Answers false when the session is gone, so the card is posted instead.
     * Under the session lock, like a turn.
     */
    function sleeveSettled(sleeve, outcome) { return lock(sleeve.sessionId, () => _sleeveSettled(sleeve, outcome)) }

    async function _sleeveSettled(sleeve, outcome) {
        const user    = await loadUser(sleeve.userId)
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
            const user = await loadUser(s.userId)
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
