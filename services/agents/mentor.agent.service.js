import { fileURLToPath } from 'url'
import { parseEmitBlock, mergeDraft, runAgentStream } from '../agentIO.js'
import { dirname, join } from 'path'
import { makePromptLoader, cleanReply, buildAccountLines, buildTimeSection, buildAudienceSection, attachTurnContext, LANGUAGE_RULE, BREVITY_RULE, VENUE_RULE, cachedBlock, normalizeMessages, makeToolHandler } from '../agentUtils.js'
import { makeNewsHandlers } from '../tools/news.tools.js'
import { getAnalystActions } from '../../providers/fmp.provider.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { DESKS } from '../desks/registry.js'
import { makeRouteCapture, buildRouteRule } from '../routing.util.js'
import { TRADING_TOOLS, buildTradingToolHandlers } from '../tools/trading.tools.js'
import { THESIS_STRUCTURE_HANDLERS, thesisTurnFacts } from '../tools/thesisStructure.tools.js'
import { STRUCTURE } from '../swingStructure.service.js'
import { toolsFor } from '../agentTools.registry.js'
import { consultDescription } from '../deepThink.service.js'
import { FLIP_TOOL, FLIP_DESCRIPTION, makeFlipHandler } from '../flipTest.service.js'
import { buildVenueSection } from '../tools/tradingContext.tools.js'
import { normalizeSetup, setupReadiness, computeRR, validityProblems, normalizeChallenges, scenarioView, scenarioLabel, legReference, stopEdge } from '../setup.schema.js'
import { summarizeTrade, sizePlan, cashFit } from '../mentorSummary.util.js'
import { resolveSize, SIZE_UNITS } from '../positionSize.util.js'
import {
    normalizeBuild, sanitizeBuildOps, applyBuildOps, claimsFromDraft, settledConflicts,
    normalizeSpans, spanIds, normalizeEntries, resolveEntryTrades, entryIds, entryProblems, fieldsClearedBy, alternativesFromSpans,
    recordReads, ALWAYS_REFETCH, sanitizeUserOps, applyUserOps, gateView, delegationPicks, heldAnswers,
    activeName, nameFor, stageOf, firstUnsettled, isWaived, STAGES,
} from '../mentorBuild.util.js'
import { readTarget } from '../mentorReads.service.js'
import { resolveMode, readSetup, kitFor, handlersFor, lensOf as lensOfName, MODE_THESIS, MODE_USER } from '../mentorMode.service.js'
import { logger } from '../logger.service.js'
import { setupService } from '../../api/setups/setups.service.js'
import { setupCommit } from '../../api/setups/setupCommit.service.js'
import { STATUS } from '../entity/vocabulary.js'

// Mentor — the trade ASSISTANT (Pipeline F). A conversation → a draft `setup` entity.
//
// The shape: the emitted worksheet IS
// the state (no separate <state> block to carry), the client owns chat history, and nothing
// persists until the user presses Generate. What differs is the CONVERSATION contract — Mentor
// has no phase capture. The guided build (a name and no plan) climbs a ladder of rungs in the
// prompt, but the ladder is a checklist the model reads off its own last worksheet, not a state
// the server tracks: the first blank field IS the next rung, so nothing here has to remember
// where the conversation was (docs/desks/mentor-talos.md). The user always brings the ticker.
//
// The tool kit is Mentor's own — services/tools/trading.tools.js. Taken WHOLE in the
// user's-setup mode, where Mentor must weigh a classical candidate against an SMC one in a single
// conversation; the RISK-BASED mode drops the pattern and indicator tools (mentorMode.kitFor,
// docs/design/mentor-modes.md).

const __dirname   = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = join(__dirname, '../../prompts/mentor_system_prompt.md')
const LOG         = '[mentorAgent]'
const MAX_MESSAGES = DESKS.mentor.maxMessages

const _baseSystemPrompt = makePromptLoader(PROMPT_PATH, LOG)

/** The dimensions <coverage> may claim. Anything else is dropped. */
const COVERAGE_DIMENSIONS = ['markets', 'company', 'technicals']

/** The sizing call. An ACTION, not a read — so it is kept out of the "already read" record. */
export const SIZE_TOOL = 'size_position'
/** Closing the saved setup being edited, once the user said so. */
export const CLOSE_TOOL = 'close_setup'
/** Calls that compute on the user's numbers rather than read the market — never recorded as "already read". */
const ACTION_TOOLS = new Set([SIZE_TOOL, CLOSE_TOOL, 'get_entry_level'])

// The trading kit plus the reasoning sidecar, APPENDED so the shared array is the exact prefix of
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
    // THE SIZING ANSWER, as a call rather than a tag. A tag is read after the model has finished
    // writing, so the figures it produces could only ever be read out NEXT turn — and the turn the
    // user gave their size ended on "I'll give you the share count before calling it ready", which is
    // a turn spent on nothing. Same slot rules as the flip test: past the breakpoint, before consult.
    ...toolsFor({
        [SIZE_TOOL]: `Record the USER's sizing answer and get the server's figures back in the same turn. Call it the moment they give a size — "risk $1,000", "1%", "$20k position", "300 shares" — with their unit and their number, never yours ("never choose it for them"). It returns, per scenario, the quantity, the cash at risk, the position value and whether that fits the cash the account can deploy (with the largest size that does, when it does not); the money the trade pays and costs; and whether the Generate button is now lit. Read those out — do not recompute any of them. The answer is recorded as theirs and settles sizing by itself as soon as the stages before it are settled, so never ask for the size again after calling this. Call it again only when they CHANGE the size.`,
    }),
    // THE THESIS LENS (docs/design/stock-playbook.md). Same slot rules as the sizing call: past the breakpoint, before
    // consult. The facts and the arithmetic are code; the stop and the targets stay Mentor's judgement.
    ...toolsFor({
        get_price_structure: `The \`thesis\` lens's chart facts, on the day (swing) or week (long-term) chart: the confirmed swings with their dates, the normal daily move (ATR), WHO IS IN CONTROL (buyers since a close over the last swing high, sellers since a close under the last swing low) and the context of the last break (reversal · continuation · breakout), the last fall (its start and its low), the heavy-volume days of the last 60 sessions, and CANDIDATE levels from the tested rule — the stop under the sellers' last swing, a deeper one under the whole fall (with the last date price traded under it), the target at the start of the fall (or a measured move at the highs) — and the BREAK CANDIDATE (the nearest high over the price, which a day close over arms scenario B; B's ASSUMED stop, target and context). The candidates are a starting point: judge the stop and the targets yourself against the chart and the candles, and say where you differ and why.`,
        get_entry_level: `The \`thesis\` lens's entry arithmetic. After you judged the stop and the target and the USER gave their risk limit (the stop at most X% from the entry) and/or their minimum reward to risk: the highest entry worth paying (the lowest, on a short) — the entry leg's price, valid "at the level and below". Never compute it yourself; read it out. It also says the last date price traded past the stop you gave — the date for "not traded under since", never a guess.`,
    }),
    ...toolsFor({
        [CLOSE_TOOL]: `Close the saved setup being edited here: its status turns to closed and Talos stops watching it. It cannot be reopened. Call it only when the USER has said to close it or let it go, never on your own read that the trade is gone: say that, and ask. Saying a setup is closed without this call leaves it open.`,
    }),
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
    messages, chatState = emptyMentorState(), accounts = [], mainAccountId = null,
    clientTime = null, audience = null, seed = null,
    prometheusRead = null,   // Prometheus's read on the build's name for its horizon (mentorReads.readFor; argus-rework.md step 3)
    readNow = null,          // (target) → its read now — the post-turn re-check when this turn confirmed the horizon
    model: requestedModel, reasoningEffort, userId,
    onToken, onAsset, onInterval, onChart, onToolStart, onReasoning, onCoverage, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
    _venueSection = buildVenueSection,
    _newsHandlers = makeNewsHandlers,
    _analystActions = getAnalystActions,
    _flipHandler = makeFlipHandler,   // the blinded red-team, injectable so the stamp below is testable without a model call
    _readSetup = readSetup,           // the cheap "did they bring a setup?" read on a typed first turn (mentorMode.service)
    _thesisFacts = thesisTurnFacts,   // the chart's stops, normal move and break scenario, read for a thesis trade at entries
    _listSetups = setupService.listSetups,   // the setups on this account that have not filled yet
    _closeSetup = setupCommit.closeSetup,    // a saved setup the user decided to close
    onFinished = null,                       // the item is finished, whatever becomes of the rest of this turn
}) {

    // `consult` is deliberately absent: runAgentStream builds it from the tool declaration, which is
    // also the only place that holds `onReasoning` — wiring it here would swallow the sidecar's
    // thinking silently. See the MENTOR_TOOLS note above.
    // SERVER-RECORDED, never model-authored: a desk that files its own verdict on its own plan has
    // produced provenance worth less than none. The handler hands the parsed verdict back here and
    // the stamp below is the only writer.
    let flipVerdict = null
    // The account the plan binds to, read once: the sizing tool needs it mid-turn and the
    // re-derivation after the turn needs the same figure, or the two would disagree about the money.
    const balance    = _mainBalance(accounts, mainAccountId)
    const available  = _mainAvailable(accounts, mainAccountId)
    const hasAccount = (accounts?.length ?? 0) > 0
    // Read at most once a turn, and only once there is money to set it beside.
    let waitingRead = null
    const readWaiting = () => (waitingRead ??= _readWaitingSetups(_listSetups, { userId, accountId: _mainAccount(accounts, mainAccountId)?.id, editingId: chatState?.editing?.entityId }))
    // The gates' content as the user last SAW it (normalised — it has been to the client). What a
    // "you pick" press settles on, and what the sizing tool splits a scale-in by.
    const shown = _gateContent(chatState?.draft)
    // The size the user gave THIS turn, as reported through the tool. Applied after the turn exactly
    // like a `size` in the tag: one op, whichever way it arrived.
    let toolSize = null
    // The setup this turn closed, for the desk's fold. Only the tool below writes it.
    let closedSetup = null
    const toolHandlers = {
        ...buildTradingToolHandlers(onChart, userId),
        [FLIP_TOOL]: _flipHandler({
            userId, agent: 'mentor', onReasoning,
            onVerdict: (v) => { flipVerdict = v },
        }),
        ..._newsHandlers(),
        ...THESIS_STRUCTURE_HANDLERS,
        get_analyst_actions: makeToolHandler('get_analyst_actions',
            ({ symbols, limit }) => _analystActions(Array.isArray(symbols) ? symbols : [], limit),
            (err) => `Could not fetch analyst actions: ${err.message}`, LOG),
        [CLOSE_TOOL]: async () => {
            const editing = chatState?.editing?.kind === 'setup' ? chatState.editing.entityId : null
            if (!editing) return 'Not closed: no saved setup is open here, so there is nothing to close.'
            // The turn a card opens on is the card's words, not an answer from the user (redrawAsk). A pencil's first turn is theirs.
            if (chatState?.redraw?.event && !chatState.redraw.offer) return 'Not closed: the user has not answered yet. Give your read and ask whether to close it; it closes on their yes.'
            // The tool takes no name, so it must not close one the talk has left (code review).
            const saved = chatState.editing.asset ?? null, talking = chatState?.draft?.asset ?? null
            if (saved && talking && String(saved).toUpperCase() !== String(talking).toUpperCase()) {
                return `Not closed: the saved setup open here is ${saved}, and the talk has moved to ${talking}. Ask them which one they mean.`
            }
            const out = await _closeSetup(editing, userId)
            if (!out?.ok) {
                return out?.reason === 'not_closable'
                    ? 'Not closed: an order is working or the position is filled, and those have their own way out. Tell the user the setup stays open.'
                    : `Not closed (${out?.reason ?? 'failed'}). Tell the user the setup stays open.`
            }
            closedSetup = { id: String(editing), asset: saved ?? talking }
            onFinished?.({ closedSetup })
            return `Closed${closedSetup.asset ? ` ${closedSetup.asset}` : ''}: the status is now closed and Talos has stopped watching it. Say so in one line, and write no worksheet.`
        },
        [SIZE_TOOL]: async (args = {}) => {
            const size = sanitizeBuildOps({ size: args })?.size
            if (!size) return `Not recorded: \`unit\` must be one of ${SIZE_UNITS.join(', ')} and \`value\` a positive number. Ask the user for their size in one of those.`
            toolSize = size
            const plan = chatState?.draft ? normalizeSetup(chatState.draft) : null
            // The NORMALISED gate content: the draft has been to the client, and the scale-in shares
            // are read off it.
            return _sizingReport(plan, size, { balance, available, hasAccount, entries: shown.entries, waiting: plan?.scenarios?.length ? await readWaiting() : null })
        },
    }

    // WHAT THIS TURN READ. Wrapped here rather than taken from `onToolStart`, which belongs to the
    // caller: the record has to be the server's own, because it is what the NEXT turn is told it
    // already has (see recordReads — "fetch once" is unenforceable without it). The sizing call is
    // an action, not a read: recorded as read, a CHANGED size would be declined as already fetched.
    // The thesis lens's entry arithmetic is an action too: a CHANGED risk limit must be computed again, never "cited".
    // Every call, actions too, in order: logged with the turn, so a build that skipped a read can be told from one that
    // read and ignored it (NXST, 2026-10-31 — the log could not say whether get_price_structure ran).
    const readThisTurn = [], calledThisTurn = []
    for (const [name, fn] of Object.entries(toolHandlers)) {
        toolHandlers[name] = async (...args) => { calledThisTurn.push(name); if (!ACTION_TOOLS.has(name)) readThisTurn.push(name); return fn(...args) }
    }

    // THE USER'S PRESSES, APPLIED FIRST. A button is not an inference: the client knows what was
    // pressed, so the ledger moves before the turn is built and the model is TOLD what was agreed
    // rather than asked to spot it in prose (which five live builds showed it does not).
    //
    // A "you pick" press settles on Mentor's recommendation over the content the user was LOOKING AT
    // — last turn's gate, carried on the draft — so the gate is closed before the model reads a word.
    const incoming = applyUserOps(
        normalizeBuild(chatState?.build ?? chatState?.draft?.build),
        sanitizeUserOps(chatState?.ops),
        delegationPicks(shown),
    )
    if (incoming.settled.length || incoming.delegated.length) {
        logger.info(LOG, 'user ops applied', { settled: incoming.settled, delegated: incoming.delegated })
    }
    if (incoming.refused.length) logger.warn(LOG, 'a press was refused — the client offered something the ledger will not take', { refused: incoming.refused })
    const turnState = { ...chatState, build: incoming.build }

    // THE MODE, BEFORE THE TURN (docs/design/mentor-modes.md): the kit is picked before the model reads a word, so the
    // mode comes from the ledger's lens, a seed (no setup of the user's — risk-based), or one cheap read of a typed
    // first message. Undecided (the read failed) = the whole kit, and the prompt's rule decides.
    // The read and the venue are independent I/O, so they run together: the read must not delay the first token by
    // a round trip of its own.
    const [{ mode, source: modeSource }, venue, thesisFacts, waiting] = await Promise.all([
        resolveMode({ name: activeName(incoming.build), seed, messages, userId, signal, read: _readSetup }),
        _venueSection(userId),
        _readThesisFacts(turnState, _thesisFacts, { signal }),
        turnState?.draft?.summary?.lossCash != null ? readWaiting() : null,
    ])
    const waitingLine = waiting ? _waitingLine(waiting, _setupCommitment(turnState.draft, _sizeMultiplier(turnState.draft.build, turnState.draft.asset)), available) : ''
    const tools = kitFor(mode, MENTOR_TOOLS, TRADING_TOOLS.length)
    // The kit is enforced on the HANDLERS too: a call to an undeclared tool comes back "no handler" instead of running.
    const kitHandlers = handlersFor(mode, toolHandlers)

    const systemPrompt  = _buildSystemPrompt(turnState, accounts, mainAccountId, audience, seed, prometheusRead)
    // The venue (mode / broker / accounts / free cash) rides the last USER message rather than
    // the system prompt: free cash moves whenever anything fills, so a volatile system block
    // would sit ahead of the whole conversation in the cache prefix. See buildVenueSection.
    const builtMessages = attachTurnContext(
        attachTurnContext(normalizeMessages(messages, MAX_MESSAGES), _buildTurnContext(turnState, clientTime, incoming.settled, { delegated: incoming.delegated, hasAccount, mode, thesisFacts, waitingLine })),
        venue)

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
        log: LOG, requestedModel, userId, messages: builtMessages, systemPrompt, tools, toolHandlers: kitHandlers,
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onChart,
        meta: { asset: chatState?.active_asset || '', accounts: accounts?.length ?? 0 },
    })

    const { reply, setup, setups, buildOps, spanBlock, entryBlock, scenarioOffer, go } = _parseMentorResponse(raw)

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
    // THE NAME THIS TURN WRITES TO — the tag's, else the worksheet's, else the one on the table, else a hand-off's
    // ticker (so the seed's lens has somewhere to land on a turn that drew no worksheet). applyBuildOps applies the
    // ops to this name, so the switch is judged against THIS name's lens, not whichever was active before the turn.
    const asset = ops.asset || normalized?.asset || chatState?.active_asset || (modeSource === 'seed' ? seed.ticker : '')
    // A MODE SWITCH reopens the trades the same way (mentorBuild.switchLens) — only when it changes the lens.
    const switching = Boolean(ops.switchLens) && ops.switchLens !== lensOfName(nameFor(incoming.build, asset))
    const reopened = new Set([...fieldsClearedBy(ops.unsettle), ...(switching ? fieldsClearedBy('spans') : [])])

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
    // Keyed to the spans FIRST: the model writes scenario ids (`s1`) where span ids (`t1`) belong,
    // and an entry keyed to no span is dropped — which emptied the whole gate (resolveEntryTrades).
    const keyed = resolveEntryTrades(entryBlock, spanIds(spans))
    if (keyed.remapped.length) logger.info(LOG, '<entries> trades re-keyed to the spans on the table', { remapped: keyed.remapped })
    const emittedEntries = normalizeEntries(keyed.entries, spanIds(spans))
    if (entryBlock && !emittedEntries) logger.warn(LOG, '<entries> emitted but nothing survived normalisation — keeping the previous set', { unresolved: keyed.unresolved, spans: spanIds(spans) })
    const entries = emittedEntries
        ?? (reopened.has('entries') ? null : normalizeEntries(carryGates?.entries, spanIds(spans)))

    // The size, whichever way it came: the tag or the tool. One op either way, applied once.
    if (toolSize && !ops.size) ops.size = toolSize

    const priorBuild = recordReads(incoming.build, readThisTurn)
    const first = applyBuildOps(priorBuild, {
        asset,
        derived: {
            // A HAND-OFF IS RISK-BASED BY DEFINITION, and the seed rides the first request only: claimed here, the lens
            // is on the ledger from turn one, so turn two never asks the cheap read about Argus's words as if they were
            // the user's setup. A lens the worksheet STATES (below) replaces it in this same object.
            ...(modeSource === 'seed' ? { lens: MODE_THESIS } : {}),
            // `lensStated` guards the one field with a non-null schema default: normalizeSetup
            // fills `trade_mode` with 'discretionary', and claiming that would put a lens nobody
            // proposed into the opening turn's settlement.
            ...(normalized ? claimsFromDraft(normalized, { lensStated: Boolean(setup?.trade_mode) }) : {}),
            ...(spans ? { spans: spanIds(spans) } : {}),
            ...(entries ? { entries: entryIds(entries) } : {}),
        },
        // Mentor's pick on whatever is on the table now. Only ever used for a gate the user handed
        // back — `applyBuildOps` ignores it everywhere else — so it is safe to pass on every turn,
        // and passing it always is what lets "you decide" in WORDS settle the same way a press does.
        picks: delegationPicks({ spans, entries }),
        ...ops,
    })
    let build = first.build
    const { refused, cleared } = first

    // THE SWITCH REDRAWS THE WORKSHEET. The new lens goes onto the plan (or settledConflicts would "restore" it and
    // report a refusal for the switch itself), and the old mode's levels go unless this turn drew new ones — a thesis
    // stop left standing under a breakout idea is the screen and the ledger disagreeing.
    if (first.switched && normalized) Object.assign(normalized, _forNewLens(normalized, ops.switchLens, setup))

    // An entry the server could not key to any trade on the table is DROPPED — so the model is told,
    // by name, rather than left to wonder why the gate it just drew is empty on the user's screen.
    if (keyed.unresolved.length) {
        build.refused = [...build.refused, {
            field: 'entries',
            reason: `ways in for ${keyed.unresolved.map(id => `"${id}"`).join(', ')} name no trade on the table — key each trade in <entries> by its span id (${spanIds(spans).join(', ') || 'none settled'}), never a scenario id, and emit them again`,
        }]
    }

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
        // The stub carries the ledger's lens: left out, the schema's `discretionary` default would sit on a hand-off's
        // worksheet whose ledger says thesis.
        ?? (hasLedger ? normalizeSetup({ asset: ledgerName.asset, ...(lensOfName(ledgerName) ? { trade_mode: lensOfName(ledgerName) } : {}) }) : null)
    if (carrier) {
        carrier.build = build
        // A switch on a turn that emitted no worksheet: the carried plan still holds the old mode's lens and levels.
        if (first.switched && !normalized) Object.assign(carrier, _forNewLens(carrier, ops.switchLens))
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
        // THE MEASURED MOVE IS ARITHMETIC (Roy, 2026-11-05). Before the money below, which is priced off the target.
        const measured = _snapMeasuredTarget(carrier, thesisFacts, messages?.findLast?.(m => m?.role === 'user')?.content)
        if (measured) {
            carrier.rr = computeRR(carrier) ?? carrier.rr
            const entered = (carrier.scenarios ?? []).some(sc => sc?.arm_close == null && sc?.entry_legs?.length)
            // The entry level comes from the target and their minimum reward to risk, so it may no longer clear it (code review).
            const redo = entered ? ' Any entry drawn on the old target is stale, and may no longer clear their minimum reward to risk: call get_entry_level with this target and redraw the entry leg before you quote a level or an R:R.' : ''
            build.refused = [...build.refused, { field: 'target', reason: `the measured move is ${measured.to}, the server's number, not ${measured.from}. The worksheet holds ${measured.to}: use it from here. A different price takes another anchor.${redo}` }]
            logger.info(LOG, 'measured move set to the calculated target', measured)
        }
        // THE MONEY IS COMPUTED, NEVER NARRATED FROM THE MODEL'S OWN ARITHMETIC. The summary rides
        // on the draft so the panel shows the same figures the model was handed, and both come from
        // one place (mentorSummary.util). A model that is roughly right about R:R is wrong about
        // dollars on a live account, and nobody can tell a computed figure from a fluent one.
        // SIZING: the user names a unit and a number, the server turns it into a quantity — per
        // scenario, because two ways into one trade have different stops and therefore different
        // sizes for the same risk. A problem (no balance to take a percentage of, a stop equal to
        // the entry) comes back as a refusal rather than a guess, and the stage stays open.
        //
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
            const sized = sizePlan(carrier, sizeAsked, { balance, entries })
            carrier.scenarios = sized.plan.scenarios
            // A size that cannot be resolved YET is not a refusal. Given in the opening turn, the
            // answer is held while the plan is still being drawn, and "sizing by risk needs an entry
            // and a stop" was reported as REFUSED on every turn until there was a stop — the exact
            // signal that sends a model back to ask for the size again. So problems are reported
            // once the plan is DRAWN — every scenario with an entry and a stop — and from then on
            // they are real: no balance, a missing multiplier, two rivals in one scenario.
            const drawn = (carrier.scenarios ?? []).length > 0 && carrier.scenarios.every(sc =>
                legReference(sc.entry_legs?.[0]) != null && stopEdge(scenarioView(carrier, sc)) != null)
            if (sized.problems.length && drawn) build.refused = [...build.refused, ...sized.problems.map(p => ({ field: 'size', reason: p }))]
            logger.info(LOG, 'sizing resolved', { unit: sizeAsked.unit, value: sizeAsked.value, sized: sized.quantities.length, problems: sized.problems.length })
        }

        // The multiplier travels with the size the LEDGER holds, not with this turn's op: priced off
        // `ops.size` it was lost on every turn after the one the size was given on.
        carrier.summary = summarizeTrade(carrier, { balance, multiplier: sizeAsked?.multiplier })
        if (!normalized) carrier.rr = computeRR(carrier) ?? carrier.rr

        // THE SUMMARY SETTLES ON ITS OWN FIGURES — this turn's, now that they exist. It used to be
        // claimed off LAST turn's draft and settled only on a "yes" in prose, so the turn the user
        // sized could never finish the build and Mentor asked them to "confirm the summary" while
        // Generate was already lit (Marce's INTC build, 2026-10-01). Its answer is pressing Generate
        // (intent #12); here the server only records that there is something to press on.
        const second = applyBuildOps(build, { asset, derived: _summaryClaim(carrier) ?? {} })
        build = { ...second.build, refused: [...build.refused, ...second.refused] }
        carrier.build = build
    }

    // SEVERAL NAMES IN ONE BUILD (#15). The active name's plan is `setup`, as it always was; the
    // others ride in `drafts`, keyed by asset, so a user who built NVDA and moved on to AMD still
    // has the NVDA plan when they press Generate all.
    //
    // Only the ACTIVE draft carries the ledger: it is build-wide, and a copy on every plan would be
    // several records of one truth, which is how they start disagreeing.
    const drafts = _mergeDrafts(chatState?.drafts, carrier, chatState?.draft)

    let readiness = carrier ? setupReadiness(carrier, (accounts?.length ?? 0) > 0) : null
    // THE READ HOLDS GENERATE (argus-rework.md step 3): while Prometheus's read on the name is still running, the setup is
    // not ready, whatever the draft says — the button stays dark, and the press is refused too (mentor.actions).
    // The turn may have CONFIRMED the horizon (or moved the name): the read the turn started with is then the wrong one,
    // and Generate would light now only to refuse the press (CR 2026-11-11). Re-checked for the build as it now stands.
    const after = readTarget({ draft: { build }, active_asset: asset })
    let heldBy = prometheusRead
    if (after && readNow && (after.symbol !== prometheusRead?.symbol || after.horizon !== prometheusRead?.horizon)) {
        heldBy = { ...after, ...(await Promise.resolve(readNow(after)).catch(() => ({ state: 'unknown' }))) }
    }
    if (readiness && ['waiting', 'missing'].includes(heldBy?.state)) {
        readiness = { ...readiness, ready: false, problems: [...(readiness.problems ?? []), "Prometheus's read is still running"] }
    }

    logger.info(LOG, 'chatStream done', {
        replyLength: reply.length,
        hasSetup: Boolean(normalized),
        carried: Boolean(carrier && !normalized),
        candidates: setups?.candidates?.length ?? 0,
        ready: readiness?.ready ?? false,
        coverage: capturedCoverage ?? chatState?.coverage ?? [],
        stage: stageOf(activeName(build)) ?? 'done',
        missing: readiness?.missing ?? [],
        settled: Object.keys(activeName(build)?.settled ?? {}),
        refused: refused.map(r => r.field),
        ...(cleared.length ? { cleared } : {}),
        mode: mode ?? 'undecided', modeSource,
        ...(first.switched ? { switchedTo: ops.switchLens } : {}),
        tools: calledThisTurn,
        // What the chat's chart can draw this turn, price by price (Roy, 2026-11-07: B on the chart before he answered).
        worksheet: (carrier?.scenarios ?? []).map(s => ({
            name: s?.name ?? null, arm: s?.arm_close ?? null,
            entry: (s?.entry_legs ?? []).map(l => l?.price ?? null),
            stop: (s?.stop_legs ?? []).map(l => l?.price ?? null),
            target: (s?.target_legs ?? []).map(l => l?.price ?? null),
        })),
        offered: scenarioOffer?.options?.map(o => o.id) ?? [],
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
        ...(scenarioOffer ? { scenarioOffer } : {}),
        ...(closedSetup ? { closedSetup } : {}),
        // Done — generate and arm it (argus-rework.md §2.2). CODE decides whether it may (the chain runner's go step).
        ...(go ? { go } : {}),
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
 * Shallow BY DESIGN: a re-emitted array or object
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
    const reply = cleanReply(text)

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
        scenarioOffer: _parseScenarioOffer(text),
        go: _parseGo(text),
    }
}

/**
 * `<go>{ "position_size": 5000, "risk": 100, "rr": 2 }</go>` — Mentor is done: the user's three numbers (argus-rework.md
 * §2.2 — the position's money, the money at risk, the minimum reward to risk) and "generate and arm it". All three must
 * be positive numbers, or there is no go (the runner never acts on a guess). → `{ position_size, risk, rr }` or null. Pure.
 */
export function _parseGo(text) {
    const g = _parseBlock(text, 'go')
    if (!g || typeof g !== 'object') return null
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
    const out = { position_size: n(g.position_size), risk: n(g.risk), rr: n(g.rr) }
    return out.position_size && out.risk && out.rr ? out : null
}

// The shared extractor already matches the tag EXACTLY, which is what keeps <setups> from being
// read as a <setup> whose body happens to start with an "s".
const _parseBlock = (text, tag) => parseEmitBlock(text, tag, LOG)

const _offerPrice = (v) => (v != null && Number(v) > 0 ? Number(v) : null)

/**
 * THE SCENARIOS MENTOR IS ASKING ABOUT, for his pane (Roy, 2026-11-07: "show them when mentor asks — it showed after I
 * already chose"). The worksheet holds only what the user took, so an offer has no place there: it lives on the turn that
 * makes it (mentorNextState's view) and goes when the next turn does not repeat it. An option with no id or no stop is
 * dropped; none left → null.
 */
export function _parseScenarioOffer(text) {
    const parsed = _parseBlock(text, 'scenario_offer')
    const options = (Array.isArray(parsed?.options) ? parsed.options : [])
        .filter(o => typeof o?.id === 'string' && o.id.trim() && _offerPrice(o.stop))
        .map(o => ({
            id:     o.id.trim(),
            label:  typeof o.label === 'string' ? o.label.trim() : '',
            arm:    _offerPrice(o.arm),
            stop:   _offerPrice(o.stop),
            target: _offerPrice(o.target),
        }))
    return options.length ? { options } : null
}

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
function _buildSystemPrompt(chatState, accounts, mainAccountId, audience = null, seed = null, prometheusRead = null) {
    const asset = chatState?.active_asset || 'none'
    const today = new Date().toISOString().slice(0, 10)
    const audienceBlock = buildAudienceSection(audience)
    const dynamicContext = `---
CURRENT DATE: ${today}. Resolve relative dates (today, next week, this month) against it — when setting active_from / valid_until, AND inside the text of a condition. A condition is read by the monitor days after you wrote it, so "a false break yesterday on last week's low" must be filed as the dated fact it was on the day you filed it — the date, and the level if you know it.
${audienceBlock ? `
${audienceBlock}

` : ''}
CONVERSATION CONTEXT:
Active asset: ${asset}${_buildAccountsSection(accounts, mainAccountId)}${_buildSeedSection(seed)}${_buildReadSection(prometheusRead)}`

    return [
        cachedBlock(_baseSystemPrompt() + buildRouteRule('mentor') + LANGUAGE_RULE + VENUE_RULE + BREVITY_RULE),
        { type: 'text', text: dynamicContext },
    ]
}

/**
 * PROMETHEUS'S READ on the build's name for its confirmed horizon (argus-rework.md step 3; Roy, 2026-11-11) — checked by
 * CODE every turn (mentorReads.readFor), never asked of the model. Mentor validates with it; a read AGAINST the trade is
 * said plainly and the user asked once (their call — he does not refuse); a read still running holds the finish. PURE;
 * empty when the horizon needs no read (intraday) or no horizon is confirmed yet.
 */
export function _buildReadSection(read) {
    if (!read?.kind || !read.symbol) return ''
    const on = `${read.symbol} for the ${read.horizon} trade`
    const what = read.kind !== 'coverage' ? 'his catalyst read'
        : read.view || read.need === 'view' ? `his ${read.horizon} view` : 'his coverage'
    if ((read.state === 'ready' || read.state === 'passed') && read.against) {
        return `

PROMETHEUS'S READ on ${on} is AGAINST it (${what}): ${read.facts}
  If you have not said so yet, say it plainly in one line and ask the user ONCE whether to build anyway. It is their call: build if they say so, and do not ask again.`
    }
    if (read.state === 'ready') {
        return `

PROMETHEUS'S READ on ${on} (${what}): ${read.facts}
  Validate the trade with it — the direction and the levels you set sit with this read, not against it. Name it in one line when you open the levels.`
    }
    if (read.state === 'waiting' || read.state === 'missing') {
        const ahead = read.state === 'waiting' && read.ahead > 0 ? `, ${read.ahead} name${read.ahead === 1 ? '' : 's'} ahead of it in the house's research` : ''
        return `

PROMETHEUS IS READING ${on} (${what}${ahead}) — or is about to: the platform asks him, and brings you his read when it lands. Do not finish the trade before then: no setup put up to generate. Meanwhile answer the user, and work the chart if they want to.`
    }
    if (read.state === 'failed') {
        return `

PROMETHEUS COULD NOT MAKE A READ on ${on} (${what}) — his research on it failed; it is asked again tomorrow. If you have not said so yet, say it once and ask the user whether to build without it. Their call: build if they say so.`
    }
    if (read.state === 'unknown') {
        return `

PROMETHEUS'S READ on ${on} could not be checked just now. If it matters to the user, say so in one line; build on the chart and their word.`
    }
    return ''
}

/**
 * The name handed over — by Argus, the Hotlist or the house's book. PURE; empty string when the user arrived on
 * their own, which is the ordinary case.
 *
 * A HAND-OFF CARRIES NO SETUP OF THE USER'S, so it opens RISK-BASED (docs/design/mentor-modes.md, Roy 2026-11-01).
 * Argus no longer recommends a lens — the lens is Mentor's to recommend and the user's to agree — so a
 * `recommended_mode` still arriving from an old client is ignored here. The mode is SAID, because a mode the user
 * never hears is one they never chose.
 */
export function _buildSeedSection(seed) {
    if (!seed?.ticker) return ''
    return `

${seed.book_facts ? "FROM THE HOUSE'S BOOK" : 'ARGUS HANDED YOU THIS NAME'}: ${seed.ticker}${seed.direction ? ` (${seed.direction})` : ''}`
        + `${seed.thesis ? `
  thesis: ${seed.thesis}` : ''}`
        + `${seed.analysis ? `
  Argus's read: ${seed.analysis}` : ''}`
        // From today's HOTLIST (daily-names.md): read back from the stored board by code, not from the
        // request. The board measures ROOM — free range to the next overhead level — and sets no
        // entry, stop or target; those are built here, with the user.
        + (seed.hotlist_facts ? `
  From today's HOTLIST: ${seed.hotlist_facts}.${seed.horizon ? ` That column's horizon is ${seed.horizon} — the user's to confirm.` : ''}${seed.caution ? `
  Argus's caution: ${seed.caution}` : ''}
  Free range is room, not a target: the board has no entry, stop or target, and you build those with the user.${seed.catalyst_facts ? `
  Prometheus's catalyst read on it: ${seed.catalyst_facts}.
  His target, when he set one, is CONTEXT — the house's price for the run-up, said in one line — never the take-profit: YOU find the target on the chart, as § The thesis lens says (Roy, 2026-11-01). The trade is out by the read's date: before the report, unless he says HOLD THROUGH it — then the report is part of the trade, and say so.` : ''}` : '')
        // From the house's SWING / LONG TERM book (the Hotlist's longer lists, 2026-10-24): read back from the name's
        // coverage by code. Its horizon is the price target's; the target is Prometheus's valuation, not a take-profit.
        + (seed.book_facts ? `
  From the house's ${seed.book_name === 'long_term' ? 'LONG TERM' : 'SWING'} book: ${seed.book_facts}.${seed.horizon ? ` The horizon is ${seed.horizon} — the user's to confirm.` : ''}${seed.caution ? `
  What would break the thesis: ${seed.caution}` : ''}
  The target is Prometheus's valuation over that horizon, not a take-profit: the entry, the stop and any exit are built here, with the user.` : '')
        // Worked out by code from the ticker (houseLabel.service), not by Argus: the house's industry desk holds this
        // name's industry on its list. Context the user hears once — never a reason the trade will work.
        + (seed.house ? `
  The house: ${seed.house}. Say it in one line as the house's view of the INDUSTRY, not of this stock; it settles nothing about the trade.` : '')
        + `

Open on it: start with the rules (§ The thesis lens, the opening), because you are building it RISK-BASED (the \`thesis\` lens); then say the name and relay the read in a sentence rather than restating it wholesale — a hand-off brings no setup of the user's, so this is the default, not a decision: if they bring their own setup, switch (§ Two modes).`
        + ` Then run the OPENING TURN as for any name. The ticker is settled unless they change it; everything handed over is a CLAIM you validate against your own read, never a settled value — its direction is a lean you test. Everything else is theirs to shape.`
}

/**
 * Everything that is true only for THIS turn. Rides on the last user message. PURE.
 *
 * The COVERAGE tally travels with its own re-state instruction, and the draft with its
 * carry-forward rule and the problems block: an instruction separated from the data it governs is
 * how a prompt quietly stops meaning what it says.
 */
export function _buildTurnContext(chatState, clientTime = null, justSettled = [], { delegated = [], hasAccount = null, mode = undefined, thesisFacts = null, waitingLine = '' } = {}) {
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
COVERAGE SO FAR: ${covered}. Re-state these in every <coverage> tag plus anything new you read this turn.${draft}${_buildMoneySection(chatState?.draft, waitingLine)}${_buildGenerateSection(chatState, hasAccount)}${_buildModeSection(mode)}${_buildRedrawSection(chatState?.redraw, chatState?.draft)}${_buildTargetSection(thesisFacts, chatState?.draft)}${_buildRiskReadSection(thesisFacts, chatState?.draft, { redraw: !!chatState?.redraw?.event && !chatState.redraw.offer })}${_buildBreakSection(thesisFacts, chatState?.draft, { redraw: !!chatState?.redraw?.event && !chatState.redraw.offer })}${_buildLedgerSection(chatState)}${_buildPressSection(justSettled, chatState, delegated)}`
}

/**
 * THE RE-DRAW, AS A FACT (Roy, 2026-11-03: "is the revising really happening?"). The card's button reopened the setup
 * with every stage settled, and Mentor asked whether the direction still stood — no read, no new level (redraw drive).
 * The desk now reopens the entries (mentorStateFromEntity → reopenForRedraw) and marks the turn with what Talos saw;
 * this says what the turn is for. One turn's: the marker is not carried past it. PURE.
 */
export function _buildRedrawSection(redraw, draft) {
    if (!redraw?.event) return ''
    const which = redraw.scenarios?.length ? ` (${redraw.scenarios.join(', ')})` : ''
    // THE PENCIL IS NOT THE CARD (Roy, 2026-11-05): they may have come to change one thing, so nothing is reopened until they say.
    if (redraw.offer) {
        const flagged = redraw.event === 'ran_away' ? `it ran away without filling${which}` : redraw.event === 'stale' ? 'the map has drifted' : `its premise broke${which}`
        return `\n\nTALOS FLAGGED THIS SETUP — ${flagged}${redraw.reason ? `: ${redraw.reason}` : ''}. The user opened it themselves, so do what they asked; nothing is reopened. Say once, in one line, what Talos saw and offer to redraw it. If they take the offer, that is their yes to the direction and the horizon, so do not ask § Coming back's question: put <build>{"unsettle":"spans","waiver":false}</build> on that turn and, on that same turn, check the whole trade again on today's chart: the entry, the stop, every target, the reward to risk and the validity range, old against new. If they say to close it, call ${CLOSE_TOOL}.`
    }
    const saw = redraw.event === 'ran_away'
        ? `it RAN AWAY without filling${which}${redraw.reason ? ` — ${redraw.reason}` : ''}. The read was not wrong; the entry never came.`
        : redraw.event === 'stale'
            ? `the map has DRIFTED${redraw.reason ? ` — ${redraw.reason}` : ''}. The trade may still be there, on levels that are no longer the chart's.`
            : `its premise BROKE${which}${redraw.reason ? ` — ${redraw.reason}` : ''}.`
    const how = draft?.trade_mode === 'thesis'
        ? 'Redraw it on TODAY\'s chart with the lens (§ The thesis lens, step 9): read get_price_structure, the stop under the NEW higher low, the target read again, the user\'s same risk limit and minimum reward to risk (from the conversation — ask once if they are not in it), the new level from get_entry_level, a new validity range. A scenario that waits on a break takes its line and its assumed stop from THE BREAK SCENARIO below instead, and a new arm_close.'
        : 'Redraw its levels on TODAY\'s chart, in its own lens — read the structure again, never the old levels.'
    // EVERY scenario on the worksheet is from the old chart (CR: the old B rode into the regenerate unexamined — with
    // two scenarios the break section stays silent).
    const all = (draft?.scenarios?.length ?? 0) > 1
        ? ' Every scenario on the worksheet was drawn on the old chart — the break scenario too: judge each again, and drop B if the break no longer changes the stop.'
        : ''
    const verdict = redraw.event === 'ran_away'
        ? 'If the redrawn level fails their limits, say plainly there is no trade here and they let it go — never a chase.'
        : 'First say whether the trade still stands at all; if the structure went the other way, say plainly there is no trade.'
    // Said only when it happened (CR): an older setup has no ledger to reopen.
    const where = redraw.reopened === false ? '' : ' The span and the entries are reopened for it; the direction, the horizon and their size stand.'
    // THE WHOLE TRADE (Roy, 2026-11-05). The worksheet's "carry every settled field forward" must not read as "keep the old numbers".
    const whole = 'CHECK THE WHOLE TRADE AGAIN, nothing on trust: the numbers on the worksheet above are the OLD plan. Go through the entry, the stop, every target, the reward to risk and the validity range, in every scenario, and say for each what it was and what it is now, in one short table: "stop: was $X, now $Y, because…" or "still $X, the low held". A level that did not change is an answer too.'
    const close = `If the answer is no trade, ask whether to close the setup, and call ${CLOSE_TOOL} when they say yes. Telling them it is gone does not close it.`
    return `\n\nTHE RE-DRAW — the user opened this setup from Talos's card: ${saw}${where} Do not ask them whether the direction and the horizon still stand: answer that yourself from the chart, in one line, and redraw on this turn. ${how}${all} ${whole} ${verdict} ${close}`
}

/**
 * The chart's facts, read before a thesis trade's SPANS or ENTRIES turn — the stops, the risk read and B live at
 * entries, and the limits are asked in the very turn spans settles (drive 9: that turn started at spans, read nothing,
 * and asked for the limits bare). `stage` rides along — B is offered at entries only. Anything else, or a read that
 * fails, → null: the turn goes on without them, never stalls.
 */
export async function _readThesisFacts(chatState, read, { signal = null, timeoutMs = THESIS_FACTS_MS } = {}) {
    const d = chatState?.draft
    const stage = stageOf(activeName(chatState?.build))
    if (d?.trade_mode !== 'thesis' || !d.asset || (stage !== 'spans' && stage !== 'entries')) return null
    // The chart the lens reads (§ The thesis lens, step 1): a long-term trade the week, a swing the day — the horizon
    // decides, as the prompt says; the timeframe field only when it names the week (CR: it is not always set).
    const timeframe = _lensTimeframe(d)
    // It runs BEFORE the first token: bounded, and dropped on the user's Stop (CR) — a slow feed costs these facts,
    // never the turn.
    let timer = null
    const giveUp = new Promise(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
        signal?.addEventListener?.('abort', () => resolve('aborted'), { once: true })
    })
    try {
        const facts = await Promise.race([read({ ticker: d.asset, timeframe, side: d.direction === 'short' ? 'short' : 'long' }), giveUp])
        if (facts === 'timeout' || facts === 'aborted') {
            logger.warn(LOG, `thesis facts ${facts} — the turn goes on without them`, { asset: d.asset })
            return null
        }
        return facts ? { ...facts, stage, asset: d.asset } : null
    } catch (err) {
        logger.warn(LOG, 'thesis facts read failed — the turn goes on without them', { asset: d.asset, err: err.message })
        return null
    } finally {
        clearTimeout(timer)
    }
}
const THESIS_FACTS_MS = 6000

const _pctFrom = (from, to) => Math.round(Math.abs(from - to) / Math.abs(from) * 1000) / 10
const _atrs = (from, to, atr) => (atr > 0 ? Math.round(Math.abs(from - to) / atr * 10) / 10 : null)
/** A distance the way the user reads it: dollars AND percent (Roy, 2026-11-05). */
const _distance = (from, to) => `$${Math.round(Math.abs(from - to) * 100) / 100} (${_pctFrom(from, to)}%)`

/** The chart a thesis plan reads: a long-term trade the week, a swing the day. */
const _lensTimeframe = (d) => (d?.type === 'long_term' || /week/i.test(d?.timeframe ?? '') ? 'week' : 'day')

/**
 * THE TARGET AT THE HIGHS, AS A FACT (Roy, 2026-11-05): price at the highs with no other price to sell at takes the
 * current range's height added to its high. Said only while the worksheet has no target and the candidate is that move:
 * the tool's answer is not on every turn. The price stays Mentor's to judge. PURE.
 */
export function _buildTargetSection(facts, draft) {
    if (facts?.target_kind !== 'measured_move' || !(facts.target > 0)) return ''
    // Said until the worksheet has this number, or another price of its own: a measured move of Mentor's own arithmetic
    // is still waiting for this one.
    // The regular scenario's: a lone B has its target from the break candidate, and the server never rewrites that (CR).
    const scenarios = draft?.scenarios ?? []
    const regular = scenarios.find(s => s?.arm_close == null)
    if (scenarios.length && !regular) return ''
    const leg = regular?.target_legs?.[0]
    if (Number.isFinite(Number(leg?.price ?? NaN)) && (leg.anchor !== 'measured_move' || Number(leg.price) === facts.target)) return ''
    const short = facts.side === 'short'
    const side = short ? 'under' : 'over'
    const high = Number.isFinite(facts.range_high) ? ` ${facts.range_high} is the ${short ? 'low' : 'high'} price is already at, so it is NOT the target, on a span or a leg, even from a pullback entry.` : ''
    return `\n\nTHE TARGET — price is ${short ? 'at the lows' : 'at the highs'}, with no price worth taking ${side} them.${high} The target is the measured move, exactly ${facts.target}: the current range's height added ${short ? 'under its low' : 'to its high'}. Use it as the span's \`to\` and the target leg, \`anchor: "measured_move"\`, and say how it is measured. Never work out a measured move of your own: the server writes this number on any regular target leg with that anchor. Only the user, or a level you can name ${side} ${facts.range_high ?? 'it'} on the chart, changes it, and that price takes another anchor (\`structure\`, \`liquidity\`).`
}

/**
 * THE MEASURED MOVE ON THE WORKSHEET IS THE CALCULATED ONE (Roy, 2026-11-05): it is arithmetic, nothing to judge, and it
 * came out differently from one run to the next when Mentor did it. `anchor: "measured_move" on a thesis target means this arithmetic; a price the user or
 * the chart gives carries another anchor and is left alone. The first such leg of each regular scenario; B (`arm_close`)
 * has its own target from the break candidate. Only when the facts call for a measured move, and are of THIS plan: they
 * are read from the turn's starting draft, and the turn can change the name, the side or the horizon (CR). A price the
 * user named this turn is theirs, whatever anchor it was left with: it stays, under `structure`, so no later turn takes it
 * back. MUTATES `plan`: the leg, its scenario's R, the flat projection of the first scenario, and the span drawn to the
 * old price → `{ from, to }` of the first change, or null.
 */
export function _snapMeasuredTarget(plan, facts, userText = '') {
    if (plan?.trade_mode !== 'thesis' || facts?.target_kind !== 'measured_move' || !(facts.target > 0)) return null
    if (String(plan.asset ?? '').toUpperCase() !== String(facts.asset ?? '').toUpperCase()) return null
    if ((plan.direction === 'short' ? 'short' : 'long') !== facts.side || _lensTimeframe(plan) !== facts.timeframe) return null
    let changed = null
    const replaced = new Set()
    for (const sc of plan.scenarios ?? []) {
        if (sc?.arm_close != null) continue
        const leg = (sc?.target_legs ?? []).find(l => l?.anchor === 'measured_move')
        if (!leg || Number(leg.price) === facts.target) continue
        if (_namesPrice(userText, leg.price)) { leg.anchor = 'structure'; continue }
        changed ??= { from: leg.price, to: facts.target }
        replaced.add(leg.price)
        leg.price = facts.target
        sc.rr = computeRR({ direction: plan.direction, ...sc }) ?? sc.rr
    }
    if (changed && plan.scenarios[0]?.target_legs) plan.target_legs = plan.scenarios[0].target_legs
    for (const c of plan.spans?.candidates ?? []) {
        if (!replaced.has(c.to_price)) continue
        c.to = String(c.to ?? '').replaceAll(String(c.to_price), String(facts.target))
        c.to_price = facts.target
    }
    return changed
}

/** Does this text name exactly this price? 400 is not in 4000, and 400.00 is 400. PURE. */
function _namesPrice(text, price) {
    if (!text || !Number.isFinite(Number(price))) return false
    // Compared as numbers: 354.50 is 354.5 (code review).
    return (String(text).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? []).some(n => Number(n) === Number(price))
}

/**
 * THE RISK READ, AS FACTS (Roy, 2026-11-02: "can't Mentor tell it from the chart?" — and 2026-11-03: "give Mentor the
 * read of risk before the user is asked for his limit"). Three drives asked for the limits first; the read the prompt
 * asks for came after, or never. Each stop's distance from today's close in % and in this chart's normal moves — the
 * judgment of what limit fits stays the model's. PURE.
 */
export function _buildRiskReadSection(facts, draft, { redraw = false } = {}) {
    if (!Number.isFinite(facts?.close) || !(facts.close !== 0)) return ''
    const unit = facts.timeframe === 'week' ? 'weeks' : 'days'
    const aStop = Number(draft?.scenarios?.[0]?.stop_legs?.[0]?.price)
    // The deep stop's date rides here too: the prompt's "from the tool on this turn" met the ledger's "already read —
    // do not call again", and Mentor withheld the offer (drive 9: "can't responsibly quote it without its date").
    const past = facts.side === 'short' ? 'over' : 'under'
    const deepName = `the deep stop${facts.deep_stop_last_traded !== undefined ? ` (not traded ${past} since ${facts.deep_stop_last_traded ?? 'any day in the history read'})` : ''}`
    const stops = [['the structure stop', facts.stop], [deepName, facts.deep_stop]]
    if (Number.isFinite(aStop) && !stops.some(([, p]) => p === aStop)) stops.unshift(['the worksheet\'s stop', aStop])
    const sg = facts.side === 'short' ? -1 : 1
    const said = stops.filter(([, p]) => Number.isFinite(p))
        // A stop price has crossed is no distance to size from: "2.2% away" read as a tight stop on a dead one (code review).
        .map(([name, p]) => sg * (p - facts.close) >= 0 ? `${name} ${p} is already crossed at today's ${facts.close}, so give no distance for it` : `${name} ${p} is ${_distance(facts.close, p)} from today's ${facts.close}${_atrs(facts.close, p, facts.atr) != null ? ` — ${_atrs(facts.close, p, facts.atr)} normal ${unit} (ATR ${facts.atr})` : ''}`)
    if (!said.length) return ''
    // THE NUMBERS, never this line's name (drive 12: "the risk read measured these stops from $210.88", and no % at all).
    return `\n\nTHE RISK READ (step 5) — SAY IT with the result (their limits come from the ONE question: risk ÷ position size, and their R:R — never ask for limits), in the user's words with these numbers (each stop's dollars, its % and its normal ${unit}) — never call it "the risk read": ${said.join('; ')}. From that, your read of what kind of limit gets in near today's price and what kind waits for a deep pullback toward the stop — judgment, no fixed menu; any level you name comes from get_entry_level.${redraw ? '' : ' The stop and the target must be on the worksheet\'s scenario on the turn you give the result: the chat draws them on a chart under your reply. Say "the chart below"; get_chart does not put a picture in the chat.'} Say it once.`
}

/**
 * THE BREAK SCENARIO, AS A FACT (Roy, 2026-11-04: every build offers the regular scenario and, if a price move would
 * move the stop, that as a second; the user takes the first, the second or both). Prose alone never got B offered, so
 * the server says whether B is on offer THIS turn, from the worksheet's stop, or the structure stop before there is one.
 * "Clearly over" is the stop's own noise buffer (STRUCTURE.buffer × ATR), not a new number. Two scenarios, or a lone one
 * that waits on an arming event (they took B alone) → B is settled, nothing to say. A regular stop price has already gone
 * through (5 of 20 charts, 2026-11-04: the last swing low is over the close) leaves no regular trade: Roy, the same day,
 * says the regular scenario is off and B is the offer, whether or not B's stop clears that dead one. The deep stop stays on
 * offer while it is on the right side of the price (Roy, the same day), offered and never recommended: GNRC's drive had
 * Mentor recommend it, then read a bare "agreed" as taking it.
 * B's ENTRY (Roy, 2026-11-03): its level from get_entry_level on B's stop — at or over the arming line, the break price
 * itself fits the limits and the break is the entry; under it, B waits for a pullback to the level after the break.
 * Either is B; drive 8 refused it for a level under the line, pricing B at the break with its own R:R. PURE.
 */
export function _buildBreakSection(facts, draft, { redraw = false } = {}) {
    const b = facts?.break
    if (!b?.swing_to_break || !b.stop || (facts.stage && facts.stage !== 'entries' && facts.stage !== 'spans')) return ''
    const scenarios = Array.isArray(draft?.scenarios) ? draft.scenarios : []
    const loneB = scenarios.length === 1 && (scenarios[0]?.conditions ?? []).some(c => c?.persistence === 'latching' && c?.weight === 'primary')
    // Settled, unless the turn is a redraw: the chart moved and the old B needs fresh numbers (code review).
    if (!redraw && (scenarios.length > 1 || loneB)) return ''
    const short = facts.side === 'short', sg = short ? -1 : 1
    const onSheet = loneB ? NaN : Number(scenarios[0]?.stop_legs?.[0]?.price)
    // Null is no stop: Number(null) is 0, which told a turn "the structure stop 0" (code review).
    const aStop = Number.isFinite(onSheet) ? onSheet : facts.stop != null ? Number(facts.stop) : NaN
    const aTarget = Number(scenarios[0]?.target_legs?.[0]?.price)
    const arm = b.swing_to_break.price
    const tested = b.context === 'reversal' ? 'a reversal, the one context that held an edge in the tests' : `a ${b.context ?? 'continuation'}, a context that tested around zero: say so`
    const lines = [`\n\nTHE BREAK SCENARIO (B) — on this chart (get_price_structure's break_candidate): a DAY close ${short ? 'under' : 'over'} ${arm} arms it; the stop you ASSUME for then is ${b.stop} — ${_distance(arm, b.stop)} from the break; the ${short ? 'lower high' : 'higher low'} it stands for has not printed, so judge it and say it is assumed. Target ${b.target}, from the chart. This break would be ${tested}.`]
    // THE TURN THAT SETTLES THE SPAN STARTS AT SPANS and goes on to the entries (AMD drive, 2026-11-04): with nothing said
    // here Mentor offered B on a line of its own, $497.40, and built it on $579.18 after the user had said "both". So it
    // gets the whole of what it would be told at the entries, and only the timing differs.
    const atSpans = facts.stage === 'spans'
    const onOffer = atSpans ? 'ON OFFER ONCE THE SPAN SETTLES' : 'ON OFFER THIS TURN'
    if (atSpans) lines.push(`  Not an offer yet: B waits for the entries. If this turn settles the span and goes on to the entries, offer B with these numbers, not a line of your own.`)
    const changes = Number.isFinite(aStop) && sg * (b.stop - aStop) > STRUCTURE.buffer * (facts.atr ?? 0)
    const regularOff = Number.isFinite(aStop) && Number.isFinite(Number(facts.close)) && sg * (aStop - Number(facts.close)) >= 0
    if (regularOff) {
        lines.push(`  The regular stop ${aStop} is already ${short ? 'under' : 'over'} today's ${facts.close}: price has gone through it, so the regular scenario is OFF — say so in one line, and draw nothing on that stop. B is ${onOffer}: one bullet with its arming line and its assumed stop — it is the trade now; take it (the risk-based default, § ONE QUESTION) and say so. Once they declined it, leave it.${facts.deep_stop != null && sg * (Number(facts.close) - facts.deep_stop) > 0 ? ` The deep stop (${facts.deep_stop}) is still on the right side of the price: offer it too, with its cost, and do not recommend it over B. If they take it, there is a regular scenario again, and both can stand. It goes on only when they name it: a bare "agreed" is not a choice, so ask which.` : ''}`)
    } else if (changes) {
        lines.push(`  ${Number.isFinite(onSheet) ? "The worksheet's stop" : 'The structure stop'} ${aStop} is ${short ? 'over' : 'under'} B's: the break CHANGES THE STOP, so B is ${onOffer} — one bullet: its arming line, its assumed stop, and that its stop is ${short ? 'lower' : 'higher'} than A's. Take BOTH — the risk-based default (§ ONE QUESTION), no question: the first to fill takes the whole size and the other is cancelled; say so once, and that one word from them drops either. Once they dropped one, leave it.`)
    }
    if (regularOff || changes) {
        lines.push('  On a redraw where they choose again, the turn you ask A, B or both emits <scenario_offer> with the numbers you offer, so their pane shows the choice. A new risk-based build asks nothing: no <scenario_offer>.')
        if (b.floor != null) lines.push(`  When B goes on, it carries \`arm_close\` ${arm} and \`arm_floor\` ${b.floor}.`)
        lines.push(`  B's ENTRY is get_entry_level on B's stop ${b.stop}, B's target and their limits — never an R:R of your own. Level ${short ? 'at or under' : 'at or over'} ${arm}: the break price fits their limits, so the break IS the entry (the level and ${short ? 'above' : 'below'}, armed by the close). Level ${short ? 'over' : 'under'} ${arm}: B waits for a pullback to the level after the break. Both are B — say which, never "does not fit" for a level ${short ? 'over' : 'under'} the line.`)
    } else {
        lines.push(`  ${Number.isFinite(aStop) ? `The stop ${aStop} is` : 'A structure stop would be'} ${short ? 'under' : 'over'} or at B's: the break would not move the stop, so B would be A with one more condition — no B. Say so in one line.${facts.deep_stop != null ? ` If the user takes the deep stop (${facts.deep_stop}), B is on offer in THAT same turn.` : ''}`)
    }
    if (changes && Number.isFinite(aTarget) && sg * (aTarget - arm) <= 0) {
        lines.push(`  A's target ${aTarget} is at or ${short ? 'over' : 'under'} B's arming line: B arms where A takes profit, so B's target is the next sellers ${short ? 'under' : 'above'} ${arm}, from the chart — say so in B's bullet.`)
    }
    return lines.join('\n')
}

/**
 * WHICH MODE THIS TURN IS IN — the server's answer, matching the kit it handed over (docs/design/mentor-modes.md).
 * Said every turn, because the kit changes with it: a model told nothing would go looking for a pattern tool the
 * risk-based kit does not carry. `undefined` = the caller did not say (tests, old callers) → nothing; `null` =
 * undecided (the read failed) → the prompt's rule decides. PURE.
 */
export function _buildModeSection(mode) {
    if (mode === undefined) return ''
    if (mode === MODE_THESIS) {
        return '\n\nMODE: RISK-BASED (the `thesis` lens) — the user brought no setup of their own. The lens is `thesis`; claim it on your worksheet.'
            + ' The pattern and indicator tools are NOT in your kit (§ Two modes). If the user brings a setup of their own — a condition, a level, a pattern —'
            + ' switch: <build>{"switch_lens":"<the lens you recommend>","source":"user"}</build>, name that lens and ask them to agree to it.'
            + ' Do NOT draw the new levels this turn — your kit cannot read their setup yet; the next turn has the whole kit.'
    }
    if (mode === MODE_USER) {
        return '\n\nMODE: THE USER\'S SETUP — they brought their own. Build it in their terms (§ Two modes); the lens is yours to recommend from their words'
            + ' — `discretionary`, `smc` or `institutional` — and theirs to agree. If they ask for your way instead, switch:'
            + ' <build>{"switch_lens":"thesis","source":"user"}</build>, and say in one line that the trades are rebuilt under it, with the rules of the lens if this build has not said them (§ The thesis lens, the opening).'
    }
    return '\n\nMODE: UNDECIDED — the server could not tell whether the user brought a setup of their own. Decide by § Two modes, and claim the lens on your worksheet.'
}

/**
 * WHETHER THE GENERATE BUTTON IS LIT — the panel's own verdict (setupReadiness), stated to the model.
 *
 * The button and the conversation used to answer "is it ready?" from two different records: the
 * button from readiness, Mentor from the ledger. They disagreed at exactly the moment it mattered —
 * Generate lit, Mentor saying "confirm this summary, then it will be ready", the user asking twice to
 * be allowed to generate (Marce, INTC, 2026-10-01). There is one answer now, and it is the button's.
 *
 * What is MISSING is said only once the ledger has nothing left open: before that an unfinished
 * plan is the normal state of a conversation, and reciting the gaps every turn would push the model
 * to fill them by guessing rather than by asking (see _buildProblemsSection).
 *
 * `hasAccount` null means the caller did not say — and then nothing is claimed either way.
 */
export function _buildGenerateSection(chatState, hasAccount = null) {
    const draft = chatState?.draft
    if (!draft || hasAccount == null) return ''
    const plan = normalizeSetup(draft)
    if (!plan) return ''
    const r = setupReadiness(plan, hasAccount)
    if (r.ready) {
        return '\n\nGENERATE: the button is LIT. The plan can be saved by pressing it, now. If the user asks to generate,'
            + ' tell them to press it — never say it is not ready, and never ask them to confirm anything first.'
            + ' A NEW RISK-BASED build: once their three numbers are in, end with <go> instead (§ ONE QUESTION) — the app generates and arms it.'
            + ' Anything you still want to raise is a remark, not a condition.'
    }
    const build = normalizeBuild(chatState?.build ?? draft.build)
    if (stageOf(activeName(build)) !== null) return ''
    return `\n\nGENERATE: still DARK, and every stage is settled — so this is what stands between the user and the button: ${
        [...r.missing, ...r.problems].join(', ')}. Fix what is yours to fix in your next <setup>, and ask for exactly what is theirs.`
}

/**
 * WHAT THE USER JUST PRESSED. Not a reading of their words — the client said so, because they hit a
 * button, and the server has already recorded it. Stated out loud so the model does not re-ask a
 * question that is now answered or re-propose a value that is now settled.
 *
 * A "you pick" press is the user handing the gate back, and the server has ALREADY settled it on
 * Mentor's recommendation — the model is told what it picked, so it can name it, not asked to pick.
 */
export function _buildPressSection(justSettled = [], chatState = null, delegated = []) {
    if (!justSettled.length && !delegated.length) return ''
    const build = normalizeBuild(chatState?.build ?? chatState?.draft?.build)
    const name  = activeName(build)
    const next  = firstUnsettled(name)
    const lines = ['\n\nTHE USER JUST PRESSED A BUTTON. This is not a reading of their words — the client told the server which button, and the ledger ALREADY RECORDS IT.']

    const confirmed = justSettled.filter(f => !delegated.some(stage => STAGES.find(s => s.key === stage)?.fields.includes(f)))
    if (confirmed.length) lines.push(`  ${confirmed.join(', ')} are SETTLED, as they confirmed.`)
    // The pacing answer rides the opening confirm only — said after any other press it was noise.
    if (['direction', 'horizon', 'lens'].some(f => confirmed.includes(f))) {
        lines.push(`  They answered the pacing question by pressing it too: ${build.waiver
            ? 'run all the way to sizing, so do not stop at the two gates.'
            : 'stop at the checkpoints, so show them each gate as you reach it.'}`)
    }
    for (const stage of delegated) {
        const fields = STAGES.find(s => s.key === stage)?.fields ?? []
        const picked = fields.map(f => name?.settled?.[f]).filter(v => v != null)
        lines.push(picked.length
            ? `  They handed you the ${stage} gate ("you pick"), and the server settled YOUR recommendation: ${fields.map(f => `${f}=${JSON.stringify(name.settled[f])}`).join(' · ')}. Name that pick and why in one line, build on it, and go on — they can overturn it.`
            : `  They handed you the ${stage} gate ("you pick"), but there was nothing on the table to pick from. Put your choice in front of them now, mark it recommended, and it settles as your pick.`)
    }
    for (const f of heldAnswers(build, name)) {
        lines.push(`  Their ${f} answer is already recorded and HELD — it settles by itself once its turn comes. Do not ask for it again.`)
    }
    lines.push('  NOTHING about a settled stage is outstanding. Do not say that it is, do not ask for it again, and do not repeat the values back as a question.')
    if (next) lines.push(`  Your job this turn is the NEXT stage — ${next.stage} — and nothing else.`)
    return lines.join('\n')
}

/**
 * THE MONEY, COMPUTED. Handed to the model as figures to read out, never as arithmetic to do.
 *
 * The summary stage is where a user decides with their gut, and it decides on money: "2.4R" is an
 * abstraction, "$740 if it works, $310 if it doesn't, 1.2% of the account" is a decision. Those
 * numbers come from `mentorSummary.util` — the same ones the panel renders, so the screen and the
 * sentence cannot disagree.
 */
export function _buildMoneySection(draft, waitingLine = '') {
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
    if (waitingLine) lines.push(`  ${waitingLine}`)
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

    // A user's answer given ahead of its stage is HELD, not pending a question: shown apart from the
    // claims still to validate, or the model reads "size … (user), not settled" and asks for it again.
    const held = new Set(heldAnswers(build, name))
    const open = Object.entries(name.claimed).filter(([f]) => !(f in name.settled) && !held.has(f))
    if (open.length) {
        lines.push(`  CLAIMED but NOT settled — validate, then ask: ${
            open.map(([f, c]) => `${f}=${_short(c.value)} (${c.source})`).join(' · ')}`)
    }
    if (held.size) {
        lines.push(`  ANSWERED by the user and HELD — settles by itself once the stages before it are settled; never ask for it again: ${
            [...held].map(f => `${f}=${_short(name.claimed[f].value)}`).join(' · ')}`)
    }

    const stage = at && STAGES.find(s => s.key === at.stage)
    // Every gate from here on, in order — what "decide and let me generate" hands back.
    const ahead = STAGES.slice(STAGES.findIndex(s => s.key === at?.stage)).filter(s => s.waivable).map(s => `"${s.key}"`)
    const handBack = stage?.waivable
        ? `    - they handed the choice back to you ("you decide", "you pick", "do what you think is right") → that IS the answer: <build>{"delegate":"${at.stage}"}</build>, with your pick marked "recommended": true. The server settles it on your pick — name the pick in one line and go straight on to the next stage in the same turn.`
            + (ahead.length > 1 ? `\n    - they handed back the REST ("decide and let me generate", "just build it") → <build>{"delegate":[${ahead.join(',')}]}</build>: each gate settles on your pick as you put it up, so put them up in this same turn.` : '')
        : null

    // "Awaiting their yes" belongs to the stages that settle on a yes. Sizing and the summary settle
    // on an answer and on figures; a worksheet's own share count claimed onto sizing is not a
    // proposal waiting on agreement, and telling the model to "settle it now" there would have it
    // settle a size nobody chose.
    if (at?.awaiting && stage.settles === 'confirm' && !isWaived(build, at.stage)) {
        // THE STAGE IS DONE AND WAITING. Reported separately from a blank one because conflating
        // the two cost a whole turn in the first live run: told "still blank", the model re-read
        // the name and re-proposed values it had already put to the user, with their "yes" in
        // front of it. Nothing here is left to work out — the next move is theirs, then yours.
        lines.push(`  YOU ARE AT: ${at.stage} — ALREADY PROPOSED, AWAITING THEIR ANSWER: ${at.fields.join(', ')}.`)
        lines.push('  You put these to the user last turn. Their message IS the answer:')
        lines.push(`    - they agreed → settle it now: <build>{"settle":[${at.fields.map(f => `"${f}"`).join(',')}],"source":"user"}</build>`)
        lines.push('    - they changed one → claim the new value in the same tag, then settle.')
        if (handBack) lines.push(handBack)
        lines.push('    - they asked something else → answer it, and leave this exactly where it is.')
        lines.push('  DO NOT re-derive these, do not re-read the name for them, and do not ask again.')
    } else if (at) {
        lines.push(`  YOU ARE AT: ${at.stage}${at.blank.length ? ` — still blank: ${at.blank.join(', ')}` : ''}.`)
        lines.push(_stageInstruction(build, at, handBack))
    } else {
        lines.push('  YOU ARE AT: done — every stage is settled. The GENERATE line above says whether the button is lit; that is the only readiness there is.')
    }

    // The ids the entries gate is keyed by, said where they are used. The model writes scenario ids
    // (`s1`) on the worksheet and kept writing them here too, which emptied the gate.
    if (at?.stage === 'entries' && Array.isArray(name.settled.spans) && name.settled.spans.length) {
        lines.push(`  Key every trade in <entries> by its SPAN id — ${name.settled.spans.join(', ')} — never a scenario id (s1, s2…).`)
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
 * What to do at an OPEN stage — one line, decided by how that stage settles (STAGES `settles`). The
 * instruction is derived from the same rule the server applies, so the prompt cannot tell the model
 * to ask for an answer the server will record without it. Pure.
 */
function _stageInstruction(build, at, handBack) {
    if (isWaived(build, at.stage)) {
        return '  The user handed this gate to you: make the call, mark your pick "recommended": true on what you put on the table, and the server settles it. Say in one line what you chose and why, so they can overturn it, then keep going.'
    }
    if (at.stage === 'sizing') {
        return `  Risk-based: their POSITION SIZE from the ONE question — call ${SIZE_TOOL} with unit size_cash and that number. The user's setup: ask which unit and number — theirs, never yours. Either way, read out what it returns; it records the answer and settles the stage by itself.`
    }
    if (at.stage === 'summary') {
        return '  The server settles this stage once the money figures exist — there is no "yes" to ask for. Read the trade and the money out; risk-based, your <go> is the answer (§ ONE QUESTION); the user\'s setup, pressing Generate is theirs.'
    }
    return '  This stage ends in something the user says yes to. Settle it with <build>{"settle":["…"]}</build> only once they have.'
        + (handBack ? `\n${handBack}` : '')
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
 * Read off the plan as it stands at the END of this turn — sized, priced — because the stage settles
 * on the figures existing (`settles: 'shown'`), and the turn that sized the trade is the turn they
 * first exist. Nothing to show → no claim, and the stage stays open.
 */
function _summaryClaim(plan) {
    const s = plan?.summary
    if (!s || (s.gainCash == null && s.lossCash == null)) return null
    return { summary: { rr: s.rr ?? null, gain: s.gainCash ?? null, loss: s.lossCash ?? null, estimated: Boolean(s.estimated) } }
}

/**
 * The gates' content as the user last SAW it — what a press was made on. Re-normalised, because it
 * has been to the client. Pure.
 */
export function _gateContent(draft) {
    const spans = normalizeSpans(draft?.spans)
    return { spans, entries: normalizeEntries(draft?.entries, spanIds(spans)) }
}

/**
 * What the sizing tool hands back: the user's size resolved on the plan on the table, per scenario,
 * with the money and the Generate verdict — everything the model needs to finish the sizing turn in
 * that turn. Pure; the plan is not touched.
 *
 * Per SCENARIO, because two rival ways in have different stops and so different sizes for the same
 * risk — and the panel's money line covers only the first, which left Mentor saying "the dollar
 * figures are for the pullback only" in Marce's INTC build.
 */
export function _sizingReport(plan, size, { balance = null, available = balance, hasAccount = false, entries = null, waiting = null } = {}) {
    const said = `${size.value} ${size.unit}${size.multiplier ? ` (multiplier ${size.multiplier})` : ''}`
    const recorded = `Recorded as the USER's size: ${said}. It settles sizing by itself once the stages before sizing are settled — never ask for the size again.`
    if (!plan?.scenarios?.length) {
        return `${recorded}\nThere is no plan with an entry and a stop on the table yet, so there is nothing to size; the quantity is computed the moment there is.`
    }

    const { plan: sized, problems } = sizePlan(plan, size, { balance, entries })
    const money = (cash, pct) => (cash == null ? '—' : `$${cash}${pct != null ? ` (${pct}% of the account)` : ''}`)
    const lines = [recorded]
    for (const sc of sized.scenarios) {
        if (!(sc.quantity > 0)) continue
        const view  = scenarioView(sized, sc)
        const entry = legReference(sc.entry_legs?.[0])
        const stop  = stopEdge(view)
        const pos   = resolveSize({ unit: 'shares', value: sc.quantity, entry, stop, balance, multiplier: size.multiplier ?? 1 })
        const s     = summarizeTrade(view, { quantity: sc.quantity, balance, multiplier: size.multiplier })
        // Priced on both ends, or no distance to state: an estimated entry has no authored level.
        const away = entry != null && stop != null && Number.isFinite(Number(entry)) && Number(entry) !== 0 && Number.isFinite(Number(stop)) ? ` · the stop ${_distance(Number(entry), Number(stop))} from the entry` : ''
        lines.push(`- ${scenarioLabel(sc)}: ${sc.quantity} unit(s)${away} · position ${money(pos.notional, pos.notionalPct)} · pays ${money(s.gainCash, s.gainPct)} · costs ${money(s.lossCash, s.lossPct)}${s.rr != null ? ` · ${s.rr}R` : ''}${s.estimated ? ' · ESTIMATED (no authored entry price — say so)' : ''}`)
        const fit = cashFit(pos, { entry, stop, balance: available, multiplier: size.multiplier ?? 1 })
        if (fit) {
            lines.push(`  DOES NOT FIT: the position is $${fit.notional} and the account has $${fit.available} to deploy.${fit.maxQuantity
                ? ` The most that fits is ${fit.maxQuantity} unit(s), risking $${fit.maxRiskCash}.`
                : ''} On a cash account this order cannot fill — tell the user and let them choose a new size; on margin it may be intended.`)
        }
    }
    for (const p of problems) lines.push(`- PROBLEM: ${p}`)
    if (balance != null && available != null && balance !== available) {
        lines.push(`Every percent here is of the account's value, $${balance}. $${available} of it is free to deploy.`)
    }
    if (waiting) lines.push(_waitingLine(waiting, _setupCommitment(sized, size.multiplier ?? 1), available))

    const readiness = setupReadiness(sized, hasAccount)
    lines.push(readiness.ready
        ? 'GENERATE: the button is now LIT for this plan. A new risk-based build: end with <go> (§ ONE QUESTION). Otherwise tell the user it is ready to press — never ask them to confirm anything else first.'
        : `GENERATE: still dark — it needs ${[...readiness.missing, ...readiness.problems].join(', ')}. Say exactly that.`)
    // The plan read here is the one on the table BEFORE this reply. When the same reply sets the levels (the user gave
    // them and the size in one message), a problem above is about the OLD levels — seen live as a false "entry/stop
    // mismatch" read out over a plan that came out sized right.
    if (problems.length || !readiness.ready) {
        lines.push('THESE FIGURES ARE FOR THE PLAN AS IT STOOD BEFORE THIS REPLY. If your reply sets or changes the entry or the stop, '
            + 'ignore the problems and the Generate line above — they are about the old levels: the size is applied to the <setup> you emit, '
            + 'and the user sees its quantity there. Do not tell the user about a mismatch the new levels resolve.')
    }
    return lines.join('\n')
}

/**
 * The plan under a NEW lens, with everything the OLD mode authored gone unless this turn's worksheet (`emitted`) drew it
 * again:
 *  - the levels — the scenarios AND the flat execution projection, or normalizeSetup would rebuild an implicit scenario
 *    from the projection on the next round trip;
 *  - the pace — the old lens's rungs would keep Talos reading a thesis setup on a discretionary ladder (the NXST defect
 *    THESIS_PACE exists for); emptied, normalizeSetup gives the new lens its own;
 *  - the setup-wide conditions and their read mode — the discarded idea's "holds VWAP on the 15m" must not gate the
 *    new trades;
 *  - the rejects — the old gate's "ways not taken", which would also block the new gate's from being written.
 * What is not the mode's (the asset, the direction, the horizon, the challenge record) is kept. PURE.
 */
export function _forNewLens(plan, lens, emitted = null) {
    const said  = (k) => Boolean(emitted) && Object.prototype.hasOwnProperty.call(emitted, k)
    const reset = { trade_mode: lens }
    if (!said('scenarios')) Object.assign(reset, { scenarios: [], entry_legs: null, stop_legs: null, target_legs: null, validity: null })
    for (const [key, empty] of [['pace_rungs', []], ['conditions', []], ['read_mode', null], ['alternatives', []]]) {
        if (!said(key)) reset[key] = empty
    }
    const fresh = normalizeSetup({ ...plan, ...reset })
    return fresh ? { ...plan, ...fresh, challenges: plan.challenges } : { ...plan, ...reset }
}

/** Ledger values are short by construction; a list is summarised rather than spelled out. */
const _short = (v) => (Array.isArray(v) ? `${v.length} item(s)` : String(v))

/**
 * The account a plan binds to: the MAIN one, or the only one marked.
 *
 * Deliberately narrow. With several accounts marked and no main, a percentage would silently pick
 * one of several different answers, so it picks none and the sizing stage says it cannot see a
 * balance — which is true, and is a sentence the user can act on.
 */
export function _mainAccount(accounts, mainAccountId = null) {
    const valid = Array.isArray(accounts) ? accounts.filter(a => a && a.id != null) : []
    if (!valid.length) return null
    return valid.length === 1
        ? valid[0]
        : valid.find(a => String(a.id) === String(mainAccountId)) ?? null
}

// ZERO IS A NUMBER, and a different fact from "no balance reported". Collapsing both to null made an
// empty account come back as "a percentage of a balance I cannot see", which is not what happened and
// not something the user can act on — seen live: the account had nothing in it and the desk never said so.
const _reported = (...figures) => {
    const v = figures.find(x => x != null && x !== '')
    const n = v == null ? NaN : Number(v)
    return Number.isFinite(n) ? n : null
}

/**
 * The figure every percentage is measured against: what the account is WORTH (Roy, 2026-11-05). "Risk 1%" is 1% of
 * the account, and must not shrink because money is sitting in another position. Whether a position fits is the other
 * question: `_mainAvailable`.
 */
export function _mainBalance(accounts, mainAccountId = null) {
    const main = _mainAccount(accounts, mainAccountId)
    const n = _reported(main?.equity, main?.balance, main?.freeMargin)
    return n != null && n >= 0 ? n : null
}

/** The money free to deploy: balance counts capital already in positions. Overdrawn means nothing is free. */
export function _mainAvailable(accounts, mainAccountId = null) {
    const main = _mainAccount(accounts, mainAccountId)
    const n = _reported(main?.freeMargin, main?.balance)
    return n == null ? null : Math.max(n, 0)
}

/** The contract multiplier a stored build was sized with; shares have none. */
const _sizeMultiplier = (build, asset) => {
    // By the setup's own name: Generate all stores one build, with one of its names active, on every setup (code review).
    const normal = build ? normalizeBuild(build) : null
    const name = normal ? (asset && nameFor(normal, asset)) || activeName(normal) : null
    const size = name?.settled?.size ?? name?.claimed?.size?.value
    return Number(size?.multiplier) || 1
}

/**
 * What one setup takes if it fills: its LARGEST scenario, because scenarios are rivals and the first to fill takes the
 * whole trade. `priced: false` when no scenario has both a size and a price to multiply. Pure.
 */
export function _setupCommitment(setup, multiplier = 1) {
    const plan = normalizeSetup(setup)
    let best = null
    for (const sc of plan?.scenarios ?? []) {
        const stop = stopEdge(scenarioView(plan, sc))
        let notional = 0, risk = stop == null ? null : 0, complete = (sc.entry_legs?.length ?? 0) > 0
        for (const leg of sc.entry_legs ?? []) {
            const price = Number(legReference(leg)), qty = Number(leg?.quantity)
            if (!(price > 0) || !(qty > 0)) { complete = false; break }
            notional += price * qty * multiplier
            if (risk != null) risk += Math.abs(price - Number(stop)) * qty * multiplier
        }
        if (complete && (!best || notional > best.notional)) best = { notional, risk }
    }
    return best ? { priced: true, ...best } : { priced: false, notional: null, risk: null }
}

/**
 * Generated setups on one account that have not filled, and what they take if they all do (Roy, 2026-11-05: a $100k
 * paper account with four setups waiting still read $100k). A filled one is a position, already in the free cash; the
 * one being revised is the plan on the table. Pure.
 */
export function _waitingSetups(docs, { accountId = null, editingId = null } = {}) {
    const rows = (docs ?? []).filter(d => String(d?.mainAccountId ?? d?.accounts?.[0]) === String(accountId) && String(d?.id) !== String(editingId))
    if (!rows.length) return null
    const out = { names: [], unpriced: [], notional: 0, risk: 0 }
    for (const doc of rows) {
        out.names.push(doc.asset)
        const c = _setupCommitment(doc, _sizeMultiplier(doc.chat_state?.draft?.build, doc.asset))
        if (!c.priced) { out.unpriced.push(doc.asset); continue }
        out.notional += c.notional
        out.risk     += c.risk ?? 0
    }
    return out
}

const WAITING_STATUSES = [STATUS.WAITING, STATUS.LOOKING, STATUS.HIT]

/** The read behind `_waitingSetups`. A failure costs the remark, never the sizing. */
export async function _readWaitingSetups(list, { userId, accountId, editingId = null }) {
    if (!userId || accountId == null) return null
    try {
        return _waitingSetups(await list(userId, { status: { $in: WAITING_STATUSES } }), { accountId, editingId })
    } catch (err) {
        logger.warn(LOG, 'waiting setups read failed', err.message)
        return null
    }
}

/**
 * The remark: what the waiting setups would take, beside this one and the free money. The account's figures are left
 * as they are, because nothing is committed until a fill. Pure.
 */
export function _waitingLine(waiting, current = null, available = null) {
    if (!waiting?.names?.length) return ''
    const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`
    const count = waiting.names.length
    const lines = [`WAITING SETUPS on this account: ${count} not filled yet (${waiting.names.join(', ')}). If they all fill they use ${usd(waiting.notional)} and risk ${usd(waiting.risk)}.`]
    if (waiting.unpriced.length) lines.push(`${waiting.unpriced.join(', ')} ${waiting.unpriced.length === 1 ? 'has' : 'have'} no sized entry price yet and ${waiting.unpriced.length === 1 ? 'is' : 'are'} not in those figures.`)
    if (current?.priced) {
        const total = waiting.notional + current.notional
        lines.push(`With this one that is ${usd(total)}${available == null ? '' : total > available ? `, ${usd(total - available)} more than the ${usd(available)} free to deploy` : `, inside the ${usd(available)} free to deploy`}.`)
    }
    lines.push('The account\'s figures are not reduced for them: nothing is committed until a fill. Tell the user this in one sentence when you read out the money. It is a remark: their size stands unless they change it, and Generate is not affected.')
    return lines.join(' ')
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

