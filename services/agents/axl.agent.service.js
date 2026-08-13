import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { logger }         from '../logger.service.js'
import { normalizeMessages, makePromptLoader, stripEmitTags, buildAudienceSection, attachTurnContext, LANGUAGE_RULE, VENUE_RULE } from '../agentUtils.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { makeSuggestionCapture } from '../suggestions.service.js'
import { runAgentStream } from '../agentIO.js'
import { toolsFor } from '../agentTools.registry.js'
import { makeTradingContextHandlers, buildVenueSection, TRADING_CONTEXT_TOOL_SPEC } from '../tools/tradingContext.tools.js'
import { makeMarketHoursHandlers, MARKET_HOURS_TOOL_SPEC } from '../tools/marketHours.tools.js'
import { makeUserDataHandlers, USER_DATA_TOOL_SPEC } from '../tools/userData.tools.js'
import { makeConceptHandlers, CONCEPT_TOOL_SPEC } from '../tools/concepts.tools.js'
import { makeExperienceHandlers, EXPERIENCE_TOOL_SPEC } from '../tools/experience.tools.js'
import { makeMarketBriefHandlers, MARKET_BRIEF_TOOL_SPEC } from '../tools/marketBrief.tools.js'
import { makeSectorViewHandlers, SECTOR_VIEW_TOOL_SPEC } from '../tools/sectorView.tools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG = '[axlAgent]'
// Hot-reload the system prompt on file change (mtime-gated) — no restart needed.
const _systemPrompt = makePromptLoader(join(__dirname, '../../prompts/axl_system_prompt.md'), LOG)
const MAX_MESSAGES = 12

// Axl is the non-trading meta-layer: the social-chat assistant, app guide, and
// (later) the account-report / trade-analysis concierge. It is READ-ONLY by
// design — it never emits a <trade_idea>, order, or any authoring artifact. That
// discipline is what keeps it from becoming a superset of the three specialists;
// anything about forming or changing a trade/portfolio/scan routes to that
// specialist's own chat. Roles beyond #1 (social bot) + #5 (app help) need
// account/trade data + tools and are added one by one — the VENUE reads are the
// first, since "which account am I on / what am I holding / can I trade this
// here" is a question ABOUT the app, which is Axl's own job, not a desk's.
// Axl now has NO writes at all. `save_objective` was one — it recorded the user's stated goal so a
// desk wouldn't re-ask — and it is gone with the objective record itself (2026-08-05): a goal
// written down became a goal that outlived its job, and reception was interrogating users for
// numbers (risk, horizon) that are the DESK's Phase 1. What crosses the hop now is a sentence, not
// a record — see `<open>` below.
// The reporting reads are APPENDED, never inserted: the snapshot compares by index and prompt
// caching keys off the array prefix, so a mid-array addition both fails three tests instead of one
// and invalidates Axl's cached tool block on every request until it re-warms.
export const TOOLS = toolsFor({
    get_trading_context: TRADING_CONTEXT_TOOL_SPEC.get_trading_context,
    check_broker_symbol: TRADING_CONTEXT_TOOL_SPEC.check_broker_symbol,
    get_watched_items: USER_DATA_TOOL_SPEC.get_watched_items,
    get_performance: USER_DATA_TOOL_SPEC.get_performance,
    get_upcoming_events: USER_DATA_TOOL_SPEC.get_upcoming_events,
    explain_concept: CONCEPT_TOOL_SPEC.explain_concept,
    set_experience_level: EXPERIENCE_TOOL_SPEC.set_experience_level,
    // Appended last, per the rule above. ONE tool, not the five market reads it is built from:
    // Axl relays a brief written elsewhere, which is what keeps the world-facing broadcast from
    // turning into per-user market commentary. See marketBrief.service.js.
    get_market_brief: MARKET_BRIEF_TOOL_SPEC.get_market_brief,
    // Appended last, per the rule above. Axl fields "is the market open?" more than any desk —
    // it is an app question, not a trade question, which is exactly Axl's half of the line.
    get_market_hours: MARKET_HOURS_TOOL_SPEC.get_market_hours,
    // Appended last, per the rule above. The SHOW half of the strategy desk: Axl reports the
    // published view, Pythia is the one who writes or changes it.
    get_sector_view: SECTOR_VIEW_TOOL_SPEC.get_sector_view,
})

// ONE Axl. This turn both converses and routes, which used to be two agents: a `routeIntent` doorman
// on its own tight prompt (no history, no app knowledge) answered the landing box, while the real
// Axl — this one — lived behind a link. The doorman answered app questions anyway, inventing them,
// and could not resolve a follow-up: "give spy" then "now the 4h" charted a ticker it had never been
// told. Routing is now a section of Axl's own prompt and a `<route>` tag on a normal reply, so the
// user gets one Axl that remembers, explains, charts, and hands them to a desk when they want one.

export const axlAgentService = { chatStream }

// The route tag may carry the name the user is here for: `<route>research NVDA</route>`. Desk and
// symbol travel as ONE capture because they are one decision — a desk that opens on a name the
// router never picked is worse than a desk that opens empty. Split only; the controller validates
// both (an unknown desk or a junk symbol must not reach the client).
export function _splitRoute(raw) {
    if (typeof raw !== 'string') return { desk: null, symbol: null }
    const [desk = null, symbol = null] = raw.trim().split(/[\s:,]+/)
    return { desk: desk ? desk.toLowerCase() : null, symbol: symbol || null }
}

// The kinds a user can be taken back INTO, and the desk that owns each.
//
// Editing is not routing, which is why it is a second tag rather than a third word in the first one.
// `<route>research NVDA</route>` opens Prometheus for NEW work — a fresh thesis even on a name
// already covered, which is exactly what went wrong when the only tag we had was this one.
// `<edit>coverage <id></edit>` reopens the thesis that exists, in the chat that wrote it.
//
// kind → desk lives here beside the parse because it IS part of the grammar: the client is told
// which desk so the pipeline crumb reads the same as any other arrival. Note the trade desk ENTERS
// at Argus but a call EDITS in Kairos — the client resolves that, since the item picks the tab.
export const EDIT_KIND_DESKS = { call: 'trade', setup: 'assist', coverage: 'research', scan: 'scan', portfolio: 'portfolio' }

// `<edit>coverage 3f9c…</edit>` → { kind, ref, desk }, or null when there is nothing openable.
// BOTH halves or nothing: a kind with no handle names no item, a handle with no kind names no list
// to find it in. Returning null in either case lets the turn fall through to a plain reply, which
// is strictly better than sending the user to a desk that starts the wrong work.
export function _splitEdit(raw) {
    if (typeof raw !== 'string') return null
    const [kind = '', ref = ''] = raw.trim().split(/[\s:,]+/)
    const k = kind.toLowerCase()
    const desk = EDIT_KIND_DESKS[k]
    if (!desk || !ref) return null
    return { kind: k, ref, desk }
}

// What the desk OPENS ON — the user's own statement of the job, in their words, as the first turn of
// the desk's conversation.
//
// This is the whole hand-off now. It replaced an `objectives` record (2026-08-05) that tried to carry
// the job as DATA — target, horizon, risk, scope — and got two things wrong at once. It outlived the
// job it described, so a portfolio goal set in August was still telling the trade desk to assume a
// 3-month horizon and 5% risk; and collecting it turned reception into an interrogation, asking for
// numbers that belong to the desk's own first phase. Axl asks only what decides WHERE. Everything
// else the user said travels as a sentence and the desk takes it from there.
//
// A sentence rather than fields is the point: it cannot be mistaken for an established parameter, it
// needs no schema, and the desk reads it exactly as it would read the user typing it — because that
// is what it is.
//
// It rides beside `<route>` rather than inside it: prose has spaces and newlines, and _splitRoute
// splits on those. No route → no opening, since there is no desk to open.
const MAX_OPENING = 600
export function _cleanOpening(raw) {
    if (typeof raw !== 'string') return null
    // Collapse the hard wrapping a model does inside a tag — this becomes a chat message, not a
    // document. Cap it because it is a first turn, not a brief: something longer is a summary Axl
    // was not asked for, and the desk is better served by the sentence than by an essay.
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_OPENING)
    return text || null
}

async function chatStream({ messages = [], audience = null, model: requestedModel, reasoningEffort, userId, onToken, onToolStart, onReasoning, onChart, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
    _tradingContextHandlers = makeTradingContextHandlers,
    _userDataHandlers = makeUserDataHandlers,
    _conceptHandlers = makeConceptHandlers,
    _experienceHandlers = makeExperienceHandlers,
    _marketBriefHandlers = makeMarketBriefHandlers,
    _marketHoursHandlers = makeMarketHoursHandlers,
    _sectorViewHandlers = makeSectorViewHandlers,
    _venueSection = buildVenueSection,
} = {}) {
    // The venue rides the last USER message, not the system prompt: free cash moves whenever
    // anything fills, and a volatile system block sits ahead of the whole conversation in the cache
    // prefix. See buildVenueSection.
    const normalized = attachTurnContext(normalizeMessages(messages, MAX_MESSAGES), await _venueSection(userId))

    // Stable cached base + volatile tail (today's date, so "this week" resolves).
    const today = new Date().toISOString().slice(0, 10)
    const audienceBlock = buildAudienceSection(audience)
    const systemPrompt = [
        { type: 'text', text: _systemPrompt() + LANGUAGE_RULE + VENUE_RULE, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `CURRENT DATE: ${today}. Resolve relative timeframes (today, this week, this month) against this date.${audienceBlock ? `

${audienceBlock}` : ''}` },
    ]

    // The chart tag is captured and emitted by runAgentStream (shared protocol) — Axl only forwards
    // the callback, exactly like every other agent, and that ONE argument is the whole reason a
    // toolless agent can put a chart in its chat at all. <route> is Axl's own: suppressed from the
    // token stream here, and stripped from `raw` below because this return value is a second
    // consumer that would otherwise hand the client "…to the trading desk. <route>trade</route>".
    // <edit> is <route>'s sibling and is handled identically here — suppressed from the stream,
    // stripped from `raw` below, parsed after the turn.
    let chartRow = null
    let routeCapture = null
    let editCapture = null
    let openCapture = null
    // <adopt> is a THIRD sibling of <route>, for the same reason <edit> is a second one: "the user
    // already owns this book" is not a destination, it is what the portfolio desk must do on arrival.
    // Squeezing it into the route tag would collide with the symbol slot (`portfolio adopt` vs
    // `portfolio AAPL`), and a mode that arrives as a symbol is a mode that silently never arrives.
    let adoptCapture = false
    // Follow-up chips. The shared pipe collects and cleans them; WHAT to suggest is this agent's
    // own judgment, authored in axl_system_prompt.md.
    const suggest = makeSuggestionCapture()

    const toolHandlers = {
        ..._tradingContextHandlers(userId),
        ..._userDataHandlers(userId),
        // Unbound: an explanation is the same for everyone, which is why it can be authored once.
        ..._conceptHandlers(),
        // Unbound for the same reason, and a stronger one: the brief is the same for every reader,
        // so a handler with no userId is the structural guarantee it stays that way.
        ..._marketBriefHandlers(),
        // Unbound too — market hours belong to the instrument, not the user.
        ..._marketHoursHandlers(),
        // Unbound for the brief's reason exactly: the house sector view is a BROADCAST, so a handler
        // that cannot see a user cannot leak one into it.
        ..._sectorViewHandlers(),
        ..._experienceHandlers(userId),
    }

    const raw = await _run({
        log: LOG, requestedModel, userId,
        messages: normalized, systemPrompt,
        tools: TOOLS, toolHandlers,
        reasoningEffort, signal, onToken,
        tagCaptures: buildTagCaptures({
            route: (text) => { routeCapture = text.trim() },
            edit:  (text) => { editCapture = text.trim() },
            open:  (text) => { openCapture = text },
            adopt: () => { adoptCapture = true },
            suggest: suggest.onCapture,
        }),
        onToolStart, onReasoning,
        onChart: (row) => { chartRow = row; onChart?.(row) },
    })

    const reply = stripEmitTags(raw ?? '', ['route', 'edit', 'open', 'adopt', 'suggest']).trim()
    const { desk, symbol } = _splitRoute(routeCapture)
    const edit = _splitEdit(editCapture)

    // No desk, no opening. An `<open>` on a turn that routes nowhere has no conversation to start,
    // and an EDIT reopens a document that already holds its own history — the desk resumes it rather
    // than beginning again, so an opening turn there would talk over what is already on the page.
    const opening = (desk && !edit) ? _cleanOpening(openCapture) : null

    // Chips are for a turn that STAYS here. When Axl is handing the user to a desk, the door he
    // just opened is the next step — offering three other questions beside it competes with the
    // one thing he decided. The prompt says the same; this guard is what makes it true, exactly as
    // the `opening` line above guards its own tag rather than trusting the tag to arrive correctly.
    const suggestions = (desk || edit) ? [] : suggest.result()

    // Only ever alongside the PORTFOLIO desk, and never alongside an edit. Gated here for the reason
    // `opening` and `routeSymbol` are: a mode with no desk to arrive at is a flag nothing reads, and
    // an edit reopens a book that already exists — adoption is how a book that exists ELSEWHERE
    // arrives, so the two cannot both be true.
    const adopt = (adoptCapture && desk === 'portfolio' && !edit)

    logger.info(LOG, 'chatStream done', { route: desk, routeSymbol: symbol, adopt, edit: edit ? `${edit.kind}:${edit.ref}` : null, opening: opening ? opening.length : null, suggestions: suggestions.length, replyLength: reply.length })
    // `chart` on the return is the REQUEST, never the image: the row already went out on its own
    // event and doubling it here would double the bytes on the wire.
    return {
        reply,
        route: desk,
        routeSymbol: symbol,
        adopt,
        // { kind, ref, desk } — reopen this exact item. Stands apart from `route` rather than
        // folding into it: a route hands over a desk and a blank page, an edit hands over a document.
        edit,
        // The desk's first turn, in the user's words. The client sends it as their message on
        // arrival, so the desk starts on the job instead of asking what they came for.
        opening,
        // Up to three follow-ups the user can send with one click. Empty on a routing turn.
        suggestions,
        chart: chartRow ? { ticker: chartRow.symbol, timeframe: chartRow.timeframe } : null,
    }
}
