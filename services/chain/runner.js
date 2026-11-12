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
// interrupted chain, the step cap, a real choice (a busy agent; the next name in a queue).
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
import { emitted, decisionFor, endedChain } from './rules.js'
import { requestRead as _requestRead, readTarget as _readTarget } from '../mentorReads.service.js'
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

/**
 * Mentor's line on the turn a read is asked for: which read, and how many names are ahead of it on the house's one
 * research run (Roy, 2026-11-11: it waits in line — say so). Pure. `t` — { symbol, horizon }; `r` — readFor's answer.
 */
export function readWaitLine(t, r) {
    const what = r.kind !== 'coverage' ? 'a catalyst read'
        : r.need === 'view' ? `his ${t.horizon} view (he covers it on the other horizon)`
            : r.need === 'reinit' ? 'his coverage again (it was not live)' : 'his full coverage'
    const ahead = r.ahead > 0 ? ` It waits in line behind ${r.ahead} name${r.ahead === 1 ? '' : 's'} in the house's research (about four minutes each).` : ''
    return `Before I build the ${t.horizon} trade on ${t.symbol}, Prometheus is reading it — ${what}.${ahead} I'll carry on as soon as it lands.`
}

/** A build cut short by the tool budget is carried on at most this many turns in a row (Roy, 2026-11-12: auto-continue). */
const MAX_CARRY = 3

/**
 * The desks that can say <go> (argus-rework.md §2.2, Roy 2026-11-12) — what it presses, and whether it needs the marked
 * accounts. Mentor: generate AND arm. Atlas: generate the book — activating it stays the user's press. BOTH take the marked
 * accounts, as their Generate press does: a book's holdings with no venue are refused one by one (`no_venue`, so the book
 * was `nothing_saved` — the Atlas drive, 2026-11-12). Atlas's also needs the plan's capital (`positionSize`) — Roy, 2026-11-12.
 */
const GO = Object.freeze({
    mentor:    Object.freeze({ action: 'generateArmed', accounts: true }),
    portfolio: Object.freeze({ action: 'generate', accounts: true, capital: true }),
})

export function makeChainRunner({
    sessions = sessionService, desks = DESK_DEFS, maxSteps = MAX_STEPS,
    loadUser = _loadUser, isCovered = _covered, lock = withSessionLock,
    findEdit = findForEdit, lookupEdit = lookupForEdit, sealing = defaultSealing,
    reads = { request: _requestRead, target: _readTarget },
} = {}) {
    // The queued-turn runner (startTurn's runQueued) — bound after construction, because it needs this
    // runner's afterTurn in return (services/desks/turns.js wires the pair).
    let runQueued = null
    const bindRunQueued = (fn) => { runQueued = fn }
    // The commit pipe's held entry (act.actHeld) — bound after construction, like runQueued (services/desks/turns.js).
    let actHeld = null
    const bindAct = (fn) => { actHeld = fn }
    // How many turns in a row a build has been carried on, by session and desk (carryOn). In memory: one instance runs
    // the turns, and a restart forgetting a count only allows a few more carries.
    const carryCount = new Map()

    const save = (user, sessionId, chain) => sessions.setChain({ sessionId, userId: user._id, chain })
    const end  = (user, sessionId, chain) => save(user, sessionId, endedChain(chain))

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

        // MENTOR'S READ (argus-rework.md step 3): once the build has a name and a confirmed horizon, Prometheus's read for
        // it must exist — code checks, and asks for a missing one. Said once in the chat, on the turn it is asked for.
        if (agent === 'mentor') await askRead({ user, sessionId, state: session.agentState?.mentor ?? null })
        // A DESK'S GO (argus-rework.md §2.2): Mentor or Atlas said done — generate it (Mentor's armed too), if code lets
        // them. A go that went through ended the session; nothing else runs after it.
        if (out.payload?.go && GO[agent] && await deskGo({ user, sessionId, session, input, agent })) return
        // A one-answer build cut short by the turn's tool budget: carried on into another turn, at most MAX_CARRY in a row
        // (the count resets when the user speaks).
        if (origin === 'user') carryCount.delete(`${sessionId}:${agent}`)
        if (out.payload?.cut_short && GO[agent] && !out.payload?.route && await carryOn({ user, sessionId, agent, input })) return

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

    /**
     * A desk's go (GO below): Mentor saves AND arms the draft, Atlas saves the book — through the commit pipe's held
     * entry (this runs inside the turn's lock). Mentor's takes the accounts the user's screen marked for this turn — or,
     * on the chain turn after a read landed, the ones kept when the go was first held. Refused:
     *   read_pending → the go is held (`go_pending` on Mentor's state): the read's landing runs Mentor's turn, and his
     *                 next go uses the kept accounts. His read-wait line was already said (askRead).
     *   no accounts  → one line: mark the account, then say go.
     *   anything else → one line saying why (the setup routes' own words), nothing saved.
     * @returns {Promise<boolean>} true when it went through (the session has ended)
     */
    async function deskGo({ user, sessionId, session, input, agent }) {
        const rule = GO[agent]
        const state = session.agentState?.[agent] ?? null
        const say = (content) => sessions.append({ sessionId, userId: user._id, message: { agent, role: 'assistant', content } })
        try {
            let args = {}
            if (rule.accounts) {
                const marked = input?.accounts?.length ? { accounts: input.accounts, mainAccountId: input.mainAccountId ?? null } : null
                args = marked ?? state?.go_pending ?? null
                if (!args?.accounts?.length) {
                    await say(`It's ready, but no account is marked to put ${agent === 'portfolio' ? 'the book' : 'the trade'} in — mark one in the account picker and say go.`)
                    return false
                }
            }
            // Atlas's go needs the book's CAPITAL (Roy, 2026-11-12): without it nothing is sized, and a book is never built
            // on money the user did not name. Refused before the press, in words that ask for it.
            if (rule.capital && !(Number(state?.pendingPlan?.positionSize) > 0)) {
                await say('The book is built, but I need its capital before I generate it — how much should it deploy?')
                return false
            }
            if (!actHeld) { logger.warn(LOG, 'go not bound — nothing generated'); return false }
            const r = await actHeld({ user, sessionId, agent, action: rule.action, args })
            if (r.reason === 'read_pending' && rule.accounts) {
                await sessions.setAgentState({ sessionId, userId: user._id, agent, state: { ...state, go_pending: args } })
                return false
            }
            if (r.reason) {
                const reason = desks[agent]?.reasons
                const why = (typeof reason === 'function' ? reason(r.reason) : reason?.[r.reason])?.[1] ?? r.reason
                await say(`Not generated yet — ${why}.`)
                return false
            }
            if (r.result?.armed === false) logger.warn(LOG, 'go: generated, not armed', { reason: r.result.armReason })
            return true
        } catch (err) {
            logger.warn(LOG, 'go failed — nothing generated', { agent, error: err.message })
            return false
        }
    }

    /**
     * Carry a build on that the turn's tool budget cut short (argus-rework.md §2.2: one answer, then the desk finishes —
     * nobody is there to say "continue"). A hand-off line to the same desk, then its turn queued, like a chain hop; the
     * turn's input (the marked accounts) rides along. After MAX_CARRY in a row it stops and says so.
     * @returns {Promise<boolean>} true when another turn was queued
     */
    async function carryOn({ user, sessionId, agent, input }) {
        const key = `${sessionId}:${agent}`
        const n = carryCount.get(key) ?? 0
        if (n >= MAX_CARRY) {
            carryCount.delete(key)
            await sessions.append({ sessionId, userId: user._id, message: { agent, role: 'assistant',
                content: 'This build is taking longer than usual — say "continue" and I will carry on from here.' } })
            return false
        }
        carryCount.set(key, n + 1)
        await sessions.append({ sessionId, userId: user._id, message: {
            agent, role: 'assistant', kind: 'handoff', to: agent, content: 'Carry on the build from where the last turn stopped.',
        } })
        runQueued?.({ user, sessionId, agent, text: null, input: carried(input), turnId: `carry_${agent}_${Date.now()}`, origin: 'chain' })
            ?.catch?.(err => logger.warn(LOG, 'carry-on turn failed', err.message))
        return true
    }

    /** Ask for the read Mentor's build needs, if it is missing; never fails the turn. */
    async function askRead({ user, sessionId, state }) {
        try {
            const t = reads.target(state)
            if (!t) return
            const r = await reads.request({ ...t, sessionId, userId: user._id })
            if (!r?.asked) return
            await sessions.append({ sessionId, userId: user._id, message: { agent: 'mentor', role: 'assistant', content: readWaitLine(t, r) } })
        } catch (err) {
            logger.warn(LOG, 'read not asked for', { error: err.message })
        }
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
        // 'research' (an investing list's top N → Prometheus) left on 2026-11-09 with Argus's lists (archive/README.md).
        // Nothing builds a research queue any more, so the 'next' branch below is dormant; it is the generic queue walk.
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
        // A sleeve is named by what it is: its GICS sub-industry (and code — Atlas places by it), or the old sector sleeve.
        const label = sleeve.industryCode && sleeve.industry ? `${sleeve.industry} (${sleeve.industryCode})` : sleeve.sector
        const tail = [
            outcome.passed.length     ? `${outcome.passed.length} passed on (no edge)` : null,
            outcome.failed.length     ? `${outcome.failed.length} failed to save` : null,
            outcome.unresolved.length ? `${outcome.unresolved.length} left unresearched` : null,
        ].filter(Boolean).join(', ')
        const line = outcome.covered.length
            ? `Screened ${outcome.screened} for the ${label} sleeve${school} → ${outcome.covered.length} now in coverage: ${outcome.covered.join(', ')}${tail ? `; ${tail}` : ''}.`
            : `Screened ${outcome.screened} for the ${label} sleeve${school} → none came into coverage${tail ? ` (${tail})` : ''}.`
        await sessions.append({ sessionId: sleeve.sessionId, userId: user._id, message: { agent: 'scanner', role: 'assistant', content: line } })

        // `sector` on an item is the sleeve's label (the brief groups by it) — the industry for an industry sleeve.
        const declined = [...outcome.passed, ...outcome.failed].map(ticker => ({ ticker, sector: label }))
        const art = makeArtifact({
            kind: KIND.COVERAGE_SET, from: { agent: 'analyst', label: 'Research' },
            items:   outcome.covered.map(ticker => ({ ticker, sector: label })),
            context: { unfilled: outcome.covered.length ? [] : [label], declined },
        })
        const chain = session.chain && session.chain.status !== 'done' ? session.chain : newChain('portfolio')
        await hop({ user, session, chain: { ...chain, origin: 'portfolio' }, art, from: 'analyst' })
        return true
    }

    /**
     * Prometheus's read for a Mentor build has landed (mentorReads → onReadSettled; argus-rework.md step 3). His line goes
     * into his own segment; then, if Mentor is still on that name and horizon, the read is handed to Mentor and his turn
     * runs — the build carries on with the read in front of him. A user who moved on keeps the line, and nothing is
     * pushed into a different trade, nor another desk's running chain taken over. False when the session is gone. Under the
 * session lock, like a turn.
     */
    function readSettled(pending, read) { return lock(pending.sessionId, () => _readSettled(pending, read)) }

    async function _readSettled(pending, read) {
        const user    = await loadUser(pending.userId)
        const session = await sessions.get({ sessionId: pending.sessionId, userId: user._id })
        if (!session || session.status !== 'active') return false
        const line = read.state === 'failed'
            ? `I could not make a read on ${pending.symbol} for the ${pending.horizon}.`
            : `${pending.symbol}, ${pending.horizon}: ${read.facts}`
        await sessions.append({ sessionId: pending.sessionId, userId: user._id, message: { agent: 'analyst', role: 'assistant', content: line } })

        const now = reads.target(session.agentState?.mentor ?? null)
        if (now?.symbol !== pending.symbol || now?.horizon !== pending.horizon) return true
        // Another desk's chain is running (an Atlas sleeve, say): it is not taken over. The line is in the timeline, and
        // Mentor reads the read in his context on his next turn (mentor.desk _prometheusRead).
        const running = session.chain && session.chain.status !== 'done' ? session.chain : null
        if (running && running.origin !== 'mentor') return true
        const art = makeArtifact({
            kind: KIND.PROMETHEUS_READ, from: { agent: 'analyst', label: 'Prometheus' },
            items: [{ ticker: pending.symbol, horizon: pending.horizon, kind: read.kind ?? null, state: read.state, facts: read.facts ?? null, against: Boolean(read.against) }],
        })
        await hop({ user, session, chain: running ?? newChain('mentor'), art, from: 'analyst' })
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

    return { afterTurn, requestPause, resume, sweep, sleeveSettled, readSettled, bindRunQueued, bindAct }
}
