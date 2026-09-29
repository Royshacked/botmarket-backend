import { fileURLToPath } from 'url'
import { parseEmitBlock, mergeDraft, runAgentStream } from '../agentIO.js'
import { dirname, join } from 'path'
import { makePromptLoader, stripEmitTags, buildAccountLines, buildTimeSection, buildAudienceSection, attachTurnContext, LANGUAGE_RULE, BREVITY_RULE, VENUE_RULE, cachedBlock, buildDeskMessages, makeToolHandler } from '../agentUtils.js'
import { makeNewsHandlers } from '../tools/news.tools.js'
import { getAnalystActions } from '../../providers/fmp.provider.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { makeRouteCapture, ROUTE_TAGS, buildRouteRule } from '../routing.util.js'
import { TRADING_TOOLS, buildTradingToolHandlers } from '../tools/trading.tools.js'
import { toolsFor } from '../agentTools.registry.js'
import { consultDescription } from '../deepThink.service.js'
import { FLIP_TOOL, FLIP_DESCRIPTION, makeFlipHandler } from '../flipTest.service.js'
import { buildVenueSection } from '../tools/tradingContext.tools.js'
import { normalizeSetup, setupReadiness, computeRR, validityProblems, normalizeChallenges } from '../setup.schema.js'
import { summarizeTrade, applySizing } from '../mentorSummary.util.js'
import {
    normalizeBuild, sanitizeBuildOps, applyBuildOps, claimsFromDraft, settledConflicts,
    normalizeSpans, spanIds, normalizeEntries, entryIds, entryProblems, fieldsClearedBy, alternativesFromSpans,
    recordReads, ALWAYS_REFETCH, sanitizeUserOps, applyUserOps, gateView,
    activeName, stageOf, firstUnsettled, isWaived, STAGES,
} from '../mentorBuild.util.js'
import { logger } from '../logger.service.js'

// Mentor — the trade ASSISTANT (Pipeline F). A conversation → a draft `setup` entity.
//
// Forked from the Kairos scaffold, which is the right shape for this: the emitted worksheet IS
// the state (no separate <state> block to carry), the client owns chat history, and nothing
// persists until the user presses Generate. What differs is the CONVERSATION contract — Mentor
// has no phase capture. The guided build (a name and no plan) climbs a ladder of rungs in the
// prompt, but the ladder is a checklist the model reads off its own last worksheet, not a state
// the server tracks: the first blank field IS the next rung, so nothing here has to remember
// where the conversation was (docs/desks/mentor-talos.md). The user always brings the ticker.
//
// The tool kit is Mentor's own — services/tools/trading.tools.js, which carried Kairos's name until
// that desk was archived (2026-08-18) and is now named for its only live consumer. Taken WHOLE and
// deliberately un-subsetted: subsetting by lens suits a desk that picks one lens per build, but
// Mentor's lens is per-SETUP and it must weigh a classical candidate against an SMC one in a
// single conversation.

const __dirname   = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = join(__dirname, '../../prompts/mentor_system_prompt.md')
const LOG         = '[mentorAgent]'
const MAX_RECENT_MESSAGES = 8

const _baseSystemPrompt = makePromptLoader(PROMPT_PATH, LOG)

/** The dimensions <coverage> may claim. Anything else is dropped. */
const COVERAGE_DIMENSIONS = ['markets', 'company', 'technicals']

// Kairos's kit plus the reasoning sidecar, APPENDED so the shared array is the exact prefix of
// this one — the tools cache breakpoint sits inside TRADING_TOOLS, and inserting anywhere before it
// would re-write that cache on every Mentor turn.
//
// The sidecar now runs at every conversational desk. Mentor was the trial, and the shape it proved
// is the one they all follow: declare the tool, pass your OWN when-clause, wire nothing. The
// mechanism paragraphs come from consultDescription (deepThink.service.js) so they cannot drift
// desk to desk; the clause below is Mentor's own judgment and is the only part that is Mentor's.
//
// Gate it on DATA, not on it feeling useful: `byAgent.consult` in token_usage carries the reach
// rate and cost, and per-desk reach is now the thing to watch — a desk that consults on most turns
// has a description too permissive and wants tightening; one that never consults is paying a tool
// declaration for nothing.
export const MENTOR_TOOLS = [
    ...TRADING_TOOLS,
    // Mentor's own additions past the shared kit, for the guided build's company read (rungs 3
    // and 5 of the ladder in the prompt). APPENDED after the kit for the same cache reason as the
    // sidecar. The descriptions are Mentor's — Axl carries get_news too, with the front-page
    // framing reception needs; here it is the catalyst check on ONE name inside the horizon.
    ...toolsFor({
        get_news: `Recent NEWS on the name — dated, attributed headlines with the publisher's own summary, newest first. \`companies\` with the TICKER as \`subject\` is the one you reach for: the catalyst check inside the horizon (rung 3 and rung 5 of the guided build), and the first place to look before web_search, because it is cached and dated where a search is neither. \`topic\` for a theme with no ticker; \`headlines\` is the market's front page and is rarely a Mentor question. Read them as what was WRITTEN — a headline is a fact to weigh, never a level.`,
        get_analyst_actions: `Recent analyst rating changes on the name — upgrades, downgrades, initiations, with the house and the date. Pass \`symbols\` with the ticker; the market-wide feed (no symbols) is a scanner's tool and not yours. Positioning's slow leg: it belongs to the \`institutional\` read at rung 5 and to a swing or long-term company read, and it is a line of context on an intraday trade at most. US-listed equities.`,
    }),
    // The blinded direction red-team (flipTest.service.js). It sits BEFORE the sidecar, which is
    // contractually last everywhere, and still past the tools cache breakpoint inside TRADING_TOOLS —
    // so declaring it re-writes no cached prefix.
    ...toolsFor({ [FLIP_TOOL]: FLIP_DESCRIPTION }),
    ...toolsFor({
        // The sidecar is contractually last at every desk that declares it
        // (agentToolsRegistry.test.js), and it sits past the tools cache breakpoint — which is
        // inside TRADING_TOOLS, on get_derivatives_context — so declaring it here touches no
        // cached prefix.
        consult: consultDescription(`Reach for it in exactly three situations: **final sizing on real money** (live or manual — the account is at risk and the arithmetic has to be right); **two readings that genuinely disagree** and you cannot settle which one governs — most often the direction call at rung 2 of the guided build, when the structure leans one way and momentum or positioning the other and the user is waiting on your lean; and **placing a level where the structure is ambiguous** — a price that is both a prior high and a supply shelf, say. The wider-target check at rung 7 is NOT a consult: it is a tool question, answered by the levels.`),
    }),
]

export function emptyMentorState() {
    return { active_asset: '', draft: null, coverage: [] }
}

export const mentorAgentService = { chatStream }

async function chatStream({
    messages, userPrompt, chatState = emptyMentorState(), accounts = [], mainAccountId = null,
    clientTime = null, audience = null, seed = null,
    model: requestedModel, reasoningEffort, userId,
    onToken, onAsset, onInterval, onChart, onToolStart, onReasoning, onCoverage, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
    _venueSection = buildVenueSection,
    _newsHandlers = makeNewsHandlers,
    _analystActions = getAnalystActions,
    _flipHandler = makeFlipHandler,   // the blinded red-team, injectable so the stamp below is testable without a model call
}) {

    const tools        = MENTOR_TOOLS
    // `consult` is deliberately absent: runAgentStream builds it from the tool declaration, which is
    // also the only place that holds `onReasoning` — wiring it here would swallow the sidecar's
    // thinking silently. See the MENTOR_TOOLS note above.
    // SERVER-RECORDED, never model-authored: a desk that files its own verdict on its own plan has
    // produced provenance worth less than none. The handler hands the parsed verdict back here and
    // the stamp below is the only writer.
    let flipVerdict = null
    const toolHandlers = {
        ...buildTradingToolHandlers(onChart, userId),
        [FLIP_TOOL]: _flipHandler({
            userId, agent: 'mentor', onReasoning,
            onVerdict: (v) => { flipVerdict = v },
        }),
        ..._newsHandlers(),
        get_analyst_actions: makeToolHandler('get_analyst_actions',
            ({ symbols, limit }) => _analystActions(Array.isArray(symbols) ? symbols : [], limit),
            (err) => `Could not fetch analyst actions: ${err.message}`, LOG),
    }

    // WHAT THIS TURN READ. Wrapped here rather than taken from `onToolStart`, which belongs to the
    // caller: the record has to be the server's own, because it is what the NEXT turn is told it
    // already has (see recordReads — "fetch once" is unenforceable without it).
    const readThisTurn = []
    for (const [name, fn] of Object.entries(toolHandlers)) {
        toolHandlers[name] = async (...args) => { readThisTurn.push(name); return fn(...args) }
    }

    // THE USER'S PRESSES, APPLIED FIRST. A button is not an inference: the client knows what was
    // pressed, so the ledger moves before the turn is built and the model is TOLD what was agreed
    // rather than asked to spot it in prose (which five live builds showed it does not).
    const incoming = applyUserOps(
        normalizeBuild(chatState?.build ?? chatState?.draft?.build),
        sanitizeUserOps(chatState?.ops),
    )
    if (incoming.settled.length) logger.info(LOG, 'user ops settled', { fields: incoming.settled })
    const turnState = { ...chatState, build: incoming.build }

    const systemPrompt  = _buildSystemPrompt(turnState, accounts, mainAccountId, audience, seed)
    // The venue (mode / broker / accounts / free cash) rides the last USER message rather than
    // the system prompt: free cash moves whenever anything fills, so a volatile system block
    // would sit ahead of the whole conversation in the cache prefix. See buildVenueSection.
    const builtMessages = attachTurnContext(
        attachTurnContext(_buildMessages({ messages, userPrompt }), _buildTurnContext(turnState, clientTime, incoming.settled)),
        await _venueSection(userId))

    // Coverage is CUMULATIVE across the conversation: the model re-states everything it has read,
    // but a turn that forgets a dimension must not un-read it. Union with the prior state.
    let capturedCoverage = null
    const onCoverageCapture = (raw) => {
        // Merge against what we've accumulated THIS turn, not the turn's starting state — a model
        // that emits <coverage> twice would otherwise have its second emit discard the first.
        const merged = mergeCoverage(capturedCoverage ?? chatState?.coverage, raw)
        capturedCoverage = merged
        onCoverage?.(merged)
    }

    // <route>/<open>: the user asked to be sent to another desk with a name (routing.util).
    const route = makeRouteCapture('mentor')
    const tagCaptures = buildTagCaptures({
        asset:    onAsset,
        interval: onInterval,
        coverage: onCoverageCapture,
        ...route.captures,
    })

    const raw = await _run({
        log: LOG, requestedModel, userId, messages: builtMessages, systemPrompt, tools, toolHandlers,
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onChart,
        meta: { userPrompt, asset: chatState?.active_asset || '', accounts: accounts?.length ?? 0 },
    })

    const { reply, setup, setups, buildOps, spanBlock, entryBlock } = _parseMentorResponse(raw)

    // A candidate-offer turn and a worksheet turn are mutually exclusive by contract; if the model
    // emits both, the picked worksheet wins (it's the more committed artifact).
    const merged     = _mergeSetupDraft(chatState?.draft, setup)
    const normalized = merged ? normalizeSetup(merged) : null
    if (normalized) normalized.rr = computeRR(normalized) ?? normalized.rr

    // The challenge record is the SERVER's. It carries forward from the draft the server stamped last
    // turn (the model's own emit of this field is ignored, whatever it says) and gains at most one
    // entry per turn, from the handler above. `at` is stamped here because this is the only layer
    // that knows the turn actually happened.
    if (normalized) {
        normalized.challenges = normalizeChallenges([
            ...(Array.isArray(chatState?.draft?.challenges) ? chatState.draft.challenges : []),
            ...(flipVerdict ? [{ pass: 'flip', verdict: flipVerdict, at: new Date().toISOString() }] : []),
        ])
    }

    // THE LEDGER. It rides on the draft because the draft is the one thing that round-trips: the
    // client rebuilds `chatState` from the fields it was sent, so a new top-level key would be
    // dropped every turn and the flow would reset on each message.
    //
    // Claims are taken from the worksheet the model just emitted as well as from its <build> tag, so
    // a turn that forgets the tag still records what was PROPOSED. Settling always needs the tag:
    // a proposal is not an agreement, and only the user's confirmation moves the ledger.
    // The candidate trades are CONTENT, so they live on the draft beside the rest of it; the ledger
    // only ever holds their ids. A turn that emits none keeps the ones already on the table — the
    // gate is a conversation, and re-listing four spans to change one word is not one.
    //
    // A block that arrives and normalises to NOTHING is not the same as no block: the model meant
    // to put candidates on the table and none of them survived. The old ones stand (better than an
    // empty gate), and it is logged, because a silently ignored emit is a bug nobody sees.
    // A REOPENED stage drops its content as well as its settlement. The ledger clearing `spans`
    // while four candidate trades stay on the draft is the ledger and the screen disagreeing: the
    // gate is open again and the user is still looking at the answers to it. What the model emits
    // THIS turn survives — a reopen usually arrives with the replacement.
    //
    // Answered from the OPS, before they are applied, because the content it drops is also what the
    // claims below are derived from.
    const ops      = sanitizeBuildOps(buildOps) ?? {}
    const reopened = new Set(fieldsClearedBy(ops.unsettle))

    // The gates' content belongs to ONE name, so it only carries forward while the build is still
    // on that name: handing AMD the candidate trades drawn for NVDA would claim NVDA's ids onto
    // AMD's ledger, and a later settle would agree to the wrong name's trades.
    const activeAsset = String(normalized?.asset || chatState?.active_asset || '').toUpperCase()
    const sameName    = Boolean(activeAsset) && String(chatState?.draft?.asset ?? '').toUpperCase() === activeAsset
    const carryGates  = sameName ? chatState?.draft : null

    const emitted = normalizeSpans(spanBlock)
    if (spanBlock && !emitted) logger.warn(LOG, '<spans> emitted but no candidate survived normalisation — keeping the previous set')
    const spans = emitted ?? (reopened.has('spans') ? null : normalizeSpans(carryGates?.spans))

    // The ways in, per trade. Scoped to the spans on the table: an entry for a trade the user never
    // agreed to look at is an entry for nothing, and the gate would show a way into a trade that is
    // not being built. Carried forward the same way the spans are.
    const emittedEntries = normalizeEntries(entryBlock, spanIds(spans))
    if (entryBlock && !emittedEntries) logger.warn(LOG, '<entries> emitted but nothing survived normalisation — keeping the previous set')
    const entries = emittedEntries
        ?? (reopened.has('entries') ? null : normalizeEntries(carryGates?.entries, spanIds(spans)))

    const priorBuild = recordReads(incoming.build, readThisTurn)
    const { build, refused, cleared } = applyBuildOps(priorBuild, {
        asset: normalized?.asset || chatState?.active_asset || '',
        derived: {
            // `lensStated` guards the one field with a non-null schema default: normalizeSetup
            // fills `trade_mode` with 'discretionary', and claiming that would put a lens nobody
            // proposed into the opening turn's settlement.
            ...(normalized ? claimsFromDraft(normalized, { lensStated: Boolean(setup?.trade_mode) }) : {}),
            ...(spans ? { spans: spanIds(spans) } : {}),
            ...(entries ? { entries: entryIds(entries) } : {}),
            // The summary stage settles on the FIGURES being in front of the user, so its claim is
            // derived from them existing. `generate` used to be the field here and nothing could
            // ever claim it — pressing Generate happens outside the conversation — so the build
            // could never complete and every settle of it was refused.
            ...(_summaryClaim(chatState?.draft) ?? {}),
        },
        ...ops,
    })

    // The ledger owns the FLOW, the draft owns the CONTENT. Where they contradict each other the
    // settled value is restored — visibly: the conflict rides back into the next turn's context
    // with the refusals, because a silent correction teaches the model nothing.
    const conflicts = settledConflicts(normalized, activeName(build))
    for (const c of conflicts) normalized[c.key] = c.settled
    if (conflicts.length) build.refused = [...build.refused, ...conflicts.map(c => ({ field: c.field, reason: c.reason }))]

    // THE LEDGER MUST GO HOME, and the draft is the only vehicle. A turn that settles something but
    // emits no worksheet is the ordinary case, not an edge one — the user says "yes, long and swing",
    // Mentor answers in prose — and without this the confirmation is simply lost: the client would
    // send back last turn's draft, carrying last turn's ledger, and the same question would be asked
    // again. So an unchanged draft is re-issued rather than skipped.
    //
    // What cannot be rescued here is a settlement made before ANY worksheet exists; that is why the
    // opening turn emits one (the nucleus it proposes IS the worksheet).
    // Three ways to find a carrier, in order: the worksheet emitted this turn, the one the client
    // sent back, or — on the opening turn, where neither exists yet — a bare stub holding the
    // ticker. The prompt asks for a worksheet on that first turn precisely so the stub is rarely
    // needed, but "the model did as it was told" is not a storage strategy, and the ledger cannot
    // be the one thing whose survival depends on it.
    const ledgerName = activeName(build)
    const hasLedger  = Boolean(ledgerName && (Object.keys(ledgerName.claimed).length || Object.keys(ledgerName.settled).length))
    const carrier = normalized
        ?? (chatState?.draft ? normalizeSetup(chatState.draft) : null)
        ?? (hasLedger ? normalizeSetup({ asset: ledgerName.asset }) : null)
    if (carrier) {
        carrier.build = build
        if (spans) {
            carrier.spans = spans
            // THE REJECTS ARE AUTHORED ONCE, at the gate. `alternatives[]` used to be a second
            // section asking for the same judgment in the same `why_not` key — the same thing
            // written twice is the same thing drifting twice, and it rode every re-emit. Derived
            // here unless the model authored its own (a plan the user brought has no gate).
            const fromGate = alternativesFromSpans(spans)
            if (fromGate.length && !carrier.alternatives?.length) carrier.alternatives = fromGate
        }
        if (entries) carrier.entries = entries
        // THE MONEY IS COMPUTED, NEVER NARRATED FROM THE MODEL'S OWN ARITHMETIC. The summary rides
        // on the draft so the panel shows the same figures the model was handed, and both come from
        // one place (mentorSummary.util). A model that is roughly right about R:R is wrong about
        // dollars on a live account, and nobody can tell a computed figure from a fluent one.
        // SIZING: the user names a unit and a number, the server turns it into a quantity — per
        // scenario, because two ways into one trade have different stops and therefore different
        // sizes for the same risk. A problem (no balance to take a percentage of, a stop equal to
        // the entry) comes back as a refusal rather than a guess, and the stage stays open.
        const balance = _mainBalance(accounts, mainAccountId)

        // SIZE IS DERIVED, AND RE-DERIVED EVERY TURN. It used to be computed only on the turn the
        // `size` op arrived, which left two ways to have a ledger that says "sized" over a
        // worksheet that carries no quantity: a size settled by any other route, and a stop that
        // moved afterwards — the same risk budget is a different number of shares once the
        // distance changes, and the stale count looked identical on the page.
        //
        // Read from the LEDGER (settled first, else the standing claim) so the answer survives the
        // turn it was given on. A plain number there is a quantity the plan already carries and
        // needs no arithmetic; only the {unit, value} shape is something to resolve.
        const sizeAsked = activeName(build)?.settled?.size ?? activeName(build)?.claimed?.size?.value ?? null
        if (sizeAsked && typeof sizeAsked === 'object' && sizeAsked.unit) {
            const { quantities, problems } = applySizing(carrier, sizeAsked, { balance, multiplier: sizeAsked.multiplier })
            for (const q of quantities) {
                const sc = carrier.scenarios?.find(x => x.id === q.id) ?? carrier.scenarios?.[0]
                if (!sc) continue
                sc.quantity = q.quantity
                // One way in takes the whole position; a scaling-in ladder is the entries stage's
                // shares to split, and phase 7 is where that lands on the legs.
                if (sc.entry_legs?.length === 1) sc.entry_legs[0].quantity = q.quantity
            }
            if (problems.length) build.refused = [...build.refused, ...problems.map(p => ({ field: 'size', reason: p }))]
            logger.info(LOG, 'sizing resolved', { unit: sizeAsked.unit, value: sizeAsked.value, sized: quantities.length, problems: problems.length })
        }

        carrier.summary = summarizeTrade(carrier, { balance, multiplier: ops.size?.multiplier })
        if (!normalized) carrier.rr = computeRR(carrier) ?? carrier.rr
    }

    // SEVERAL NAMES IN ONE BUILD (#15). The active name's plan is `setup`, as it always was; the
    // others ride in `drafts`, keyed by asset, so a user who built NVDA and moved on to AMD still
    // has the NVDA plan when they press Generate all.
    //
    // Only the ACTIVE draft carries the ledger: it is build-wide, and a copy on every plan would be
    // several records of one truth, which is how they start disagreeing.
    const drafts = _mergeDrafts(chatState?.drafts, carrier, chatState?.draft)

    const readiness = carrier ? setupReadiness(carrier, (accounts?.length ?? 0) > 0) : null

    logger.info(LOG, 'chatStream done', {
        replyLength: reply.length,
        hasSetup: Boolean(normalized),
        carried: Boolean(carrier && !normalized),
        candidates: setups?.candidates?.length ?? 0,
        ready: readiness?.ready ?? false,
        coverage: capturedCoverage ?? chatState?.coverage ?? [],
        stage: stageOf(activeName(build)) ?? 'done',
        settled: Object.keys(activeName(build)?.settled ?? {}),
        refused: refused.map(r => r.field),
        ...(cleared.length ? { cleared } : {}),
    })

    return {
        reply,
        coverage: capturedCoverage ?? chatState?.coverage ?? [],
        // Returned at the top level as well as on the draft: harmless today (the client ignores what
        // it does not know) and the seam a future frontend uses to carry the ledger on its own.
        build,
        // What the UI draws a confirm card from, so the client never has to know what a stage is.
        ...(gateView(build) ? { gate: gateView(build) } : {}),
        ...(carrier ? { setup: carrier, readiness } : {}),
        // Absent until there is a second name, so an ordinary one-name build sends nothing new.
        ...(Object.keys(drafts).length > 1 ? { drafts } : {}),
        ...(setups && !normalized ? { setups } : {}),
        ...route.result(),   // { route, routeSymbol, opening, edit } — the controller validates
    }
}

// ─── Coverage (pure) ──────────────────────────────────────────────────────────

/**
 * Merge a `<coverage>` emit into the running set. Accepts the comma-separated tag body or an
 * array; unknown dimensions are dropped. Union, never replace — coverage only ever grows within
 * a conversation, so a turn that omits an already-read dimension can't reset the progress display.
 */
export function mergeCoverage(prior, raw) {
    const incoming = Array.isArray(raw)
        ? raw
        : String(raw ?? '').split(',')
    const next = incoming
        .map(s => String(s).trim().toLowerCase())
        .filter(s => COVERAGE_DIMENSIONS.includes(s))
    return [...new Set([...(Array.isArray(prior) ? prior : []), ...next])]
}

// ─── Draft carry-forward (pure) ───────────────────────────────────────────────

/**
 * Merge a freshly emitted setup onto the prior draft so an OMITTED field carries forward.
 *
 * The prompt demands the complete worksheet every turn, but on an edit turn the model sometimes
 * narrates "everything else stands" and emits only the changed field. The client replaces its
 * draft wholesale, so that thin block would wipe settled legs.
 *
 * Shallow BY DESIGN (same rule as Kairos's `_mergeCallDraft`): a re-emitted array or object
 * replaces its prior value outright, so the model can still DROP a leg or clear a field with an
 * explicit null — only omission is protected. Returns null when there's no new setup this turn.
 */
export const _mergeSetupDraft = mergeDraft

// ─── Emit-block extraction (pure) ─────────────────────────────────────────────

/**
 * Pull `<setup>` (the live worksheet) and `<setups>` (the 2–3 candidate offer) out of the raw
 * model output, returning the user-visible reply with both blocks stripped. A malformed block is
 * logged and treated as absent — the client keeps its existing draft rather than being handed
 * a half-parsed one.
 */
export function _parseMentorResponse(raw) {
    const text  = raw ?? ''
    const reply = stripEmitTags(text, ['setup', 'setups', 'build', 'spans', 'entries', 'asset', 'interval', 'coverage', ...ROUTE_TAGS]).trim()

    return {
        reply,
        setup:    _parseBlock(text, 'setup'),
        setups:   _parseCandidates(text),
        // The ledger moves this turn: what the user confirmed, reopened, or waived. Validated by the
        // ledger itself — this only pulls the block out.
        buildOps: _parseBlock(text, 'build'),
        // The candidate trades at the spans gate. `<spans>` is the TABLE the user chooses from;
        // `<setups>` is a menu of complete alternative plans, and they are not the same thing.
        spanBlock: _parseBlock(text, 'spans'),
        // The ways INTO each candidate trade, at the second gate.
        entryBlock: _parseBlock(text, 'entries'),
    }
}

// The shared extractor already matches the tag EXACTLY, which is what keeps <setups> from being
// read as a <setup> whose body happens to start with an "s".
const _parseBlock = (text, tag) => parseEmitBlock(text, tag, LOG)

/**
 * The candidate offer. Each entry is a full setup plus a label and a pitch; the setups are
 * normalised here so the client renders comparable cards (rr, readiness) rather than raw model
 * output. Candidates that don't normalise to anything are dropped; an empty list → null.
 */
export function _parseCandidates(text) {
    const parsed = _parseBlock(text, 'setups')
    const list   = Array.isArray(parsed?.candidates) ? parsed.candidates : null
    if (!list) return null

    const candidates = list.reduce((out, c) => {
        const setup = normalizeSetup(c?.setup)
        if (!setup) return out
        setup.rr = computeRR(setup) ?? setup.rr
        out.push({
            label: typeof c?.label === 'string' && c.label.trim() ? c.label.trim() : setup.trade_mode,
            pitch: typeof c?.pitch === 'string' ? c.pitch.trim() : '',
            setup,
        })
        return out
    }, [])

    return candidates.length ? { candidates } : null
}

// ─── Prompt / messages ────────────────────────────────────────────────────────

/**
 * What the readiness gate says about the draft the agent itself emitted — fed BACK to it next turn.
 *
 * Without this the agent is the only party that can't see the verdict on its own work: the panel
 * shows a dark Generate button and the reason, the user has to read it out, and the agent re-emits
 * the same mistake because nothing told it. Live runs made that concrete — with two scenarios, the
 * validity ordering was right on one and wrong on the other about every other build, and each time
 * the refusal was invisible to the model that could have fixed it in one line.
 *
 * `missing` is deliberately NOT included: an unfinished setup is the normal state of a
 * conversation, and reciting the gaps every turn would push the agent to fill them by guessing
 * rather than by asking. A `problem` is different — the setup is complete and CONTRADICTS itself,
 * which is never something to wait out.
 */
export function _buildProblemsSection(draft) {
    // Scaling-in shares belong here rather than in readiness: they are not a MISSING field, they
    // are a stated plan that does not add up, and the user would be filled for a size nobody chose.
    const problems = draft ? [...validityProblems(draft), ...entryProblems(draft.entries)] : []
    if (!problems.length) return ''
    return `\nTHE PLAN YOU EMITTED DOES NOT ADD UP — fix this in your next <setup>, and say so plainly rather than silently re-emitting:\n${
        problems.map(p => `- ${p}`).join('\n')}\nGenerate refuses a setup in this state, so the user cannot save it until you correct it.`
}

/**
 * SESSION-STABLE only. Talos carries THREE per-turn things and all three moved to
 * _buildTurnContext: the setup draft (and the problems derived from it), the coverage tally (it
 * grows on the turns the model reads something new), and the clock. Any one of them left here
 * would have been enough to keep the history breakpoint from hitting — the cache prefix does not
 * care how small the volatile block is, only that it sits ahead of the conversation.
 */
function _buildSystemPrompt(chatState, accounts, mainAccountId, audience = null, seed = null) {
    const asset = chatState?.active_asset || 'none'
    const today = new Date().toISOString().slice(0, 10)
    const audienceBlock = buildAudienceSection(audience)
    const dynamicContext = `---
CURRENT DATE: ${today}. Resolve relative dates (today, next week, this month) against it — when setting active_from / valid_until, AND inside the text of a condition. A condition is read by the monitor days after you wrote it, so "a false break yesterday on last week's low" must be filed as the dated fact it was on the day you filed it — the date, and the level if you know it.
${audienceBlock ? `
${audienceBlock}

` : ''}
CONVERSATION CONTEXT:
Active asset: ${asset}${_buildAccountsSection(accounts, mainAccountId)}${_buildSeedSection(seed)}`

    return [
        cachedBlock(_baseSystemPrompt() + buildRouteRule('mentor') + LANGUAGE_RULE + VENUE_RULE + BREVITY_RULE),
        { type: 'text', text: dynamicContext },
    ]
}

/**
 * The name Argus handed over, and the lens it recommends. PURE; empty string when the user arrived
 * on their own, which is the ordinary case.
 *
 * The LENS IS A RECOMMENDATION, not a decision, and the prompt says so out loud because the two
 * read identically to a model handed a field called `recommended_mode`. Mentor's whole contract is
 * that it works on what the user brought and hands the decision back — silently adopting a scanner's
 * lens would be the desk quietly authoring for them, which is the one thing it must not do.
 *
 * It also has to be SAID. A recommendation the user never hears is indistinguishable from Mentor
 * having decided.
 */
function _buildSeedSection(seed) {
    if (!seed?.ticker) return ''
    const lens = String(seed.recommended_mode ?? '').trim()
    return `

ARGUS HANDED YOU THIS NAME: ${seed.ticker}${seed.direction ? ` (${seed.direction})` : ''}`
        + `${seed.thesis ? `
  thesis: ${seed.thesis}` : ''}`
        + `${seed.analysis ? `
  Argus's read: ${seed.analysis}` : ''}`
        + (lens ? `
  Argus recommends the ${lens} lens.` : '')
        + `

Open on it: say the name, relay Argus's read in a sentence rather than restating it wholesale, and`
        + (lens
            ? ` NAME THE RECOMMENDED LENS AND WHY IT FITS. It is Argus's recommendation, not a decision: if the user wants a different lens, or the chart disagrees with it, say so and use theirs. A lens adopted without the user hearing it is one they never chose.`
            : ` say that you will ask which lens they want to build it through when the ladder reaches it.`)
        + ` Then run the OPENING TURN as for any name: read it cheapest-first, and come back with direction, horizon and lens together. The ticker is settled unless they change it; everything Argus sent is a CLAIM you validate against your own read, never a settled value — its direction is a lean you test, its lens a recommendation the user still has to agree to. Everything else is theirs to shape.`
}

/**
 * Everything that is true only for THIS turn. Rides on the last user message. PURE.
 *
 * The COVERAGE tally travels with its own re-state instruction, and the draft with its
 * carry-forward rule and the problems block: an instruction separated from the data it governs is
 * how a prompt quietly stops meaning what it says.
 */
export function _buildTurnContext(chatState, clientTime = null, justSettled = []) {
    // THE WORKSHEET, WITHOUT WHAT IS ALREADY WRITTEN OUT ABOVE IT. `build`, `spans`, `entries` and
    // `summary` each have their own section in prose; dumping them again as JSON paid for them
    // twice and buried the instructions under a wall of fields.
    const { build: _b, spans: _s, entries: _e, summary: _m, ...plan } = chatState?.draft ?? {}
    const draft = chatState?.draft
        ? `\nSetup so far (carry every settled field forward; change only what's discussed):\n${JSON.stringify(plan, null, 2)}${_buildProblemsSection(chatState.draft)}`
        : ''

    const covered = Array.isArray(chatState?.coverage) && chatState.coverage.length
        ? chatState.coverage.join(', ')
        : 'nothing yet'

    // ORDER IS AN INSTRUCTION. The ledger goes LAST, closest to where the model starts writing. It
    // used to sit above the worksheet dump, so the final thing read before generating was a page of
    // JSON rather than "they agreed — settle it", and five live builds re-asked a question the user
    // had already answered.
    return `---
${buildTimeSection(clientTime, 'active_from / valid_until')}
COVERAGE SO FAR: ${covered}. Re-state these in every <coverage> tag plus anything new you read this turn.${draft}${_buildMoneySection(chatState?.draft)}${_buildLedgerSection(chatState)}${_buildPressSection(justSettled, chatState)}`
}

/**
 * WHAT THE USER JUST PRESSED. Not a reading of their words — the client said so, because they hit a
 * button, and the server has already recorded it. Stated out loud so the model does not re-ask a
 * question that is now answered or re-propose a value that is now settled.
 */
export function _buildPressSection(justSettled = [], chatState = null) {
    if (!justSettled.length) return ''
    const build = normalizeBuild(chatState?.build ?? chatState?.draft?.build)
    const next  = firstUnsettled(activeName(build))
    return '\n\nTHE USER JUST PRESSED THE CONFIRM BUTTON. This is not a reading of their words — the'
        + ` client told the server which button, and the ledger ALREADY RECORDS IT: ${justSettled.join(', ')} are SETTLED.`
        + `\n  They answered the pacing question by pressing it too: ${build.waiver
            ? 'run all the way to sizing, so do not stop at the two gates.'
            : 'stop at the checkpoints, so show them each gate as you reach it.'}`
        + '\n  NOTHING about that stage is outstanding. Do not say that it is, do not ask for it again,'
        + ' and do not repeat the values back as a question.'
        + (next ? `\n  Your job this turn is the NEXT stage — ${next.stage} — and nothing else.` : '')
}

/**
 * THE MONEY, COMPUTED. Handed to the model as figures to read out, never as arithmetic to do.
 *
 * The summary stage is where a user decides with their gut, and it decides on money: "2.4R" is an
 * abstraction, "$740 if it works, $310 if it doesn't, 1.2% of the account" is a decision. Those
 * numbers come from `mentorSummary.util` — the same ones the panel renders, so the screen and the
 * sentence cannot disagree.
 */
export function _buildMoneySection(draft) {
    const s = draft?.summary
    if (!s || (s.gainCash == null && s.lossCash == null)) return ''

    const money = (cash, pct) => (cash == null ? '—' : `${cash}${pct != null ? ` (${pct}% of the account)` : ''}`)
    const lines = [
        '\n\nTHE MONEY ON THIS TRADE — computed from the plan and the size, not by you. Read these out; never recompute them:',
        `  pays ${money(s.gainCash, s.gainPct)} · costs ${money(s.lossCash, s.lossPct)}${s.rr != null ? ` · ${s.rr}R` : ''}${s.quantity != null ? ` · ${s.quantity} unit(s)` : ''}`,
    ]
    if (s.estimated) {
        lines.push('  ESTIMATED: this entry has no authored price, so the figures are measured off the live price. Say so when you quote them — the real ones are computed at the fill.')
    }
    return lines.join('\n')
}

/**
 * WHERE THE BUILD IS — the server's answer, not the model's recollection.
 *
 * This is what makes a detour free (docs/design/mentor-flow-intent.md D4): the model never has to
 * remember where the conversation was, because the first unsettled stage is recomputed and handed
 * over every single turn. The user can ask about earnings in the middle of sizing and nothing here
 * moves — the ledger records settlements, and knows nothing about topics.
 *
 * It also carries last turn's REFUSALS. A settlement the server rejected is invisible to the model
 * otherwise, and an invisible refusal is a silently skipped gate, which is the failure this whole
 * design exists to prevent.
 */
export function _buildLedgerSection(chatState) {
    const build = normalizeBuild(chatState?.build ?? chatState?.draft?.build)
    const name  = activeName(build)
    if (!name) return ''

    const at    = firstUnsettled(name)
    const lines = [`\n\nBUILD LEDGER — ${name.asset} (the server's record; you do not carry it yourself)`]

    const settled = Object.entries(name.settled)
    lines.push(settled.length
        ? `  SETTLED (never re-ask, never re-litigate): ${settled.map(([f, v]) => `${f}=${_short(v)}`).join(' · ')}`
        : '  SETTLED: nothing yet.')

    const open = Object.entries(name.claimed).filter(([f]) => !(f in name.settled))
    if (open.length) {
        lines.push(`  CLAIMED but NOT settled — validate, then ask: ${
            open.map(([f, c]) => `${f}=${_short(c.value)} (${c.source})`).join(' · ')}`)
    }

    if (at?.awaiting) {
        // THE STAGE IS DONE AND WAITING. Reported separately from a blank one because conflating
        // the two cost a whole turn in the first live run: told "still blank", the model re-read
        // the name and re-proposed values it had already put to the user, with their "yes" in
        // front of it. Nothing here is left to work out — the next move is theirs, then yours.
        lines.push(`  YOU ARE AT: ${at.stage} — ALREADY PROPOSED, AWAITING THEIR ANSWER: ${at.fields.join(', ')}.`)
        lines.push('  You put these to the user last turn. Their message IS the answer:')
        lines.push(`    - they agreed → settle it now: <build>{"settle":[${at.fields.map(f => `"${f}"`).join(',')}],"source":"user"}</build>`)
        lines.push('    - they changed one → claim the new value in the same tag, then settle.')
        lines.push('    - they asked something else → answer it, and leave this exactly where it is.')
        lines.push('  DO NOT re-derive these, do not re-read the name for them, and do not ask again.')
    } else if (at) {
        const waived = isWaived(build, at.stage)
        lines.push(`  YOU ARE AT: ${at.stage} — still blank: ${at.blank.join(', ')}.`)
        lines.push(waived
            ? '  The user waived this gate: make the call yourself, record it, and say in one line what you decided so they can overturn it.'
            : '  This stage ends in something the user says yes to. Settle it with <build>{"settle":["…"]}</build> only once they have.')
    } else {
        lines.push('  YOU ARE AT: done — every stage is settled. Summarise and offer Generate.')
    }

    if (build.names.length > 1) {
        lines.push(`  OTHER NAMES IN THIS BUILD: ${build.names
            .filter(n => n.asset !== name.asset)
            .map(n => `${n.asset} (${stageOf(n) ?? 'done'})`).join(' · ')}`)
    }

    if (build.refused.length) {
        lines.push(`  REFUSED LAST TURN — it did not happen, so do not build on it:\n${
            build.refused.map(r => `    - ${r.field}: ${r.reason}`).join('\n')}`)
    }

    // WHAT YOU HAVE ALREADY READ. The prompt's "never fetch twice in one build" is a rule about a
    // fact the model has no way to check — on the first live run it re-read the news, the
    // fundamentals and the macro one turn after reading them. This is the fact.
    const reads = Object.entries(build.reads ?? {})
    if (reads.length) {
        lines.push(`  ALREADY READ THIS BUILD (turn ${build.turn}) — you HAVE these answers; cite what you concluded instead of calling again:`)
        lines.push(`    ${reads.map(([tool, turn]) => `${tool} (turn ${turn})`).join(' · ')}`)
        lines.push(`    Re-read only ${ALWAYS_REFETCH.join(' / ')} — a level is placed against the price that IS — or when something makes an answer genuinely out of date, and say why.`)
    }

    lines.push(`  The stages, in order: ${STAGES.map(s => s.key).join(' → ')}. Nothing settles out of order, and reopening one reopens every stage below it.`)
    lines.push('  A question about anything else is always answered in full — talking never moves this ledger, and it never has to.')
    return lines.join('\n')
}

/**
 * Every plan in this build, keyed by asset: what the client sent back, with this turn's on top.
 *
 * A build can hold up to ten names and the conversation only ever works on one at a time, so the
 * others have to be kept somewhere or they are lost the moment the user says "now AMD". They are
 * kept as CONTENT only — the ledger stays on the active draft, because one build has one ledger.
 *
 * Pure.
 */
export function _mergeDrafts(prior, carrier, lastDraft = null) {
    const out = {}
    // Re-normalised on the way in, and keyed by the asset the DOCUMENT says rather than by the key
    // it arrived under: this came back through a client, and the two could disagree.
    //
    // `lastDraft` is what makes a second name possible at all. The client only holds a `drafts` map
    // once the server has sent one, and the server only sends one at two names — so on the turn the
    // user says "now AMD", the NVDA plan exists ONLY as the draft being sent back, and seeding from
    // `prior` alone dropped it. That is the bug that made "Generate all" unreachable.
    for (const draft of [...Object.values(prior ?? {}), lastDraft]) {
        if (!draft) continue
        const normalized = normalizeSetup(draft)
        if (!normalized?.asset) continue
        // normalizeSetup returns a fixed shape, so the gate content and the money would be stripped
        // off every parked plan on each round trip — leaving the ledger saying `spans` are settled
        // with nothing behind them. Carried explicitly; the LEDGER is not, because one build has one.
        for (const key of ['spans', 'entries', 'summary']) {
            if (draft[key]) normalized[key] = draft[key]
        }
        out[normalized.asset] = normalized
    }
    if (carrier?.asset) out[carrier.asset] = carrier
    return out
}

/**
 * The summary stage's claim: what the user is being shown, once there is money to show.
 *
 * Read off the PREVIOUS turn's draft rather than this one's, because the claim has to exist before
 * the model can settle it, and both happen in the same turn: the figures were computed last turn,
 * presented in that reply, and this turn's `settle` is the user agreeing with what they read.
 */
function _summaryClaim(draft) {
    const s = draft?.summary
    if (!s || (s.gainCash == null && s.lossCash == null)) return null
    return { summary: { rr: s.rr ?? null, gain: s.gainCash ?? null, loss: s.lossCash ?? null, estimated: Boolean(s.estimated) } }
}

/** Ledger values are short by construction; a list is summarised rather than spelled out. */
const _short = (v) => (Array.isArray(v) ? `${v.length} item(s)` : String(v))

/**
 * The balance every percentage is measured against: the MAIN account's, or the only one marked.
 *
 * Deliberately narrow. With several accounts marked and no main, a percentage would silently pick
 * one of several different answers, so it picks none and the sizing stage says it cannot see a
 * balance — which is true, and is a sentence the user can act on.
 */
export function _mainBalance(accounts, mainAccountId = null) {
    const valid = Array.isArray(accounts) ? accounts.filter(a => a && a.id != null) : []
    if (!valid.length) return null
    const main = valid.length === 1
        ? valid[0]
        : valid.find(a => String(a.id) === String(mainAccountId))
    // freeMargin is what can actually be deployed; balance counts capital already in positions.
    const n = Number(main?.freeMargin ?? main?.balance)
    return Number.isFinite(n) && n > 0 ? n : null
}

function _buildAccountsSection(accounts, mainAccountId = null) {
    if (!Array.isArray(accounts) || accounts.length === 0) {
        return '\n\nACCOUNTS: none marked. Tell the user to mark a trading account (paper / live / manual) at the bank icon — the setup can\'t be generated or monitored without one.'
    }
    const lines = buildAccountLines(accounts, mainAccountId)
    const mainNote = accounts.length > 1
        ? ' The account tagged ← MAIN is the one the setup binds to — its broker sets the venue (symbol + price space) it executes and is monitored in.'
        : ''
    return `\n\nACCOUNTS (marked at the bank icon — the setup will bind here):\n${lines.join('\n')}${mainNote}`
}

function _buildMessages({ messages, userPrompt }) {
    return buildDeskMessages({ messages, userPrompt, max: MAX_RECENT_MESSAGES })
}
