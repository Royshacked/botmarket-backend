// ── Desk-to-desk routing — the shared mechanism ───────────────────────────────
// Every conversational agent can hand the user to another desk, on the user's ask, in the grammar
// Axl has spoken since reception became one agent: `<route>desk SYMBOL</route>` beside an
// `<open>…</open>`, the desk's first turn — or `<edit>kind id</edit>` to reopen an item the user
// already has. The client lands every one of them on the same doorway (MainPage.handleAxlPick):
// open the desk, send the opening as the user's message. Nothing structured crosses, on purpose —
// a sentence needs no schema, cannot be mistaken for a settled parameter, and the desk reads it
// exactly as it would read the user typing it.
//
// WHAT IS SHARED AND WHAT IS OWNED. This module is the pipe: the grammar, the parsers, the
// validation a controller applies, the capture an agent wires, and the rule text a desk's prompt
// carries. WHEN to route — and what the opening says — is the sender's judgment, formed in its own
// conversation; the rule only says the opening is where what it found travels, because the desk
// cannot see this chat. (Axl's own routing section is richer than the rule here — reception's whole
// job is deciding WHERE — so Axl keeps its spine and shares only the mechanism.)
//
// Before 2026-09-18 every hop had its own tag, its own parser, its own controller field and its own
// button (`argus_pick`, Argus's `coverage_request`, …). The conveyor hops — the ones a pipeline
// performs on its own, carrying fields the receiver's UI needs (a mode chip, a queue) — keep their
// artifact kinds. A hop the USER asks for is a sentence, and goes through here.
//
// A NEW AGENT gets every desk with four lines: `+ buildRouteRule('<its key>')` after its spine (before
// the closing LANGUAGE/VENUE/BREVITY rules, which stay last),
// `...route.captures` in its tag captures, `...route.result()` in its return, and
// `...routeFields(result, req.user.role)` in its controller's done payload.

import { DESKS, PIPELINE_KEYS, ADMIN_PIPELINE_KEYS, RECEPTION } from './desks/registry.js'

// ─── The desks ────────────────────────────────────────────────────────────────

// Every list below DERIVES from the one desk registry (services/desks/registry.js) — five of them
// used to be hand-kept here and in session.util, and a desk added to one and not the others was routed
// to, refused, or sealed nowhere.

// The pipelines a reply may hand the user to. Validated server-side rather than trusted from the
// model: an unknown key would leave the client trying to navigate to a tab that doesn't exist, so
// it becomes null and the user simply stays where they are.
export const VALID_PIPELINES = new Set(PIPELINE_KEYS)

// Admin-only: Pythia (strategy) and Aether. The prompts say so; this is the gate that holds when a
// model forgets, so a trader is never sent to a desk the hub does not show them and the routes 403.
export const ADMIN_DESKS = ADMIN_PIPELINE_KEYS

/**
 * The desks one DESK may send the user to — each is ONE agent, keyed by the pipeline whose entry
 * tab is that agent, so "send it to Mentor" is `assist` and never `trade` (which enters at Argus).
 * The admin desks are not here (registry: not routable) — no desk agent has to know the user's role
 * to write a correct offer. Axl still routes admins to both.
 *
 * `agent` is the AGENTS / activeTab key the client knows the desk's agent by; `does` is the one line
 * the sender's prompt shows.
 */
export const ROUTABLE_DESKS = Object.freeze(Object.fromEntries(
    Object.values(DESKS).filter(d => d.routable).map(d => [d.desk, { agent: d.agent, brand: d.brand, role: d.role, does: d.does, routedFrom: d.routedFrom ?? null }]),
))

// A desk with `routedFrom` takes the user only from the agents it names (registry) — since 2026-11-09 Argus, whom only
// Mentor sends anyone to — and Proteus, whom Axl and Mentor send users to. `from` is the sending agent's key (Axl's is
// 'axl'); a capture with no key may not name a restricted desk.
// Gated in the capture AND left off the sender's prompt, like the self-route.
export function mayRoute(from, desk) {
    // Back to reception: a main-chat DESK hands a question that is not its own to Axl. Never Axl himself (reception
    // sending to reception is a loop), never a capture with no sender, never a desk in its own admin session (Axl does
    // not speak there).
    if (desk === RECEPTION) return backToReception(from)
    const d = ROUTABLE_DESKS[desk]
    if (!d?.routedFrom) return true
    return !!from && d.routedFrom.includes(from)
}

/** Whether `from` may hand a question back to Axl: a main-chat desk agent, not Axl. */
export function backToReception(from) {
    const d = DESKS[from]
    return !!d && from !== 'axl' && d.scope === 'main'
}

// The desk each agent stands at, so its own door is left off its list. Argus is also the trade
// desk's entry and Mentor its build step; neither is listed here because `trade` is Axl's composite
// pipeline, not a place a desk sends anyone.
const AGENT_DESK = Object.freeze(Object.fromEntries(
    Object.values(DESKS).filter(d => d.routable).map(d => [d.agent, d.desk]),
))

// ─── Grammar ──────────────────────────────────────────────────────────────────

/** The emit tags this mechanism owns. Strip them all from a reply that captured any. */
export const ROUTE_TAGS = Object.freeze(['route', 'open', 'edit', 'show'])

// The route tag may carry the name the user is here for: `<route>research NVDA</route>`. Desk and
// symbol travel as ONE capture because they are one decision — a desk that opens on a name the
// router never picked is worse than a desk that opens empty. Split only; the controller validates
// both (an unknown desk or a junk symbol must not reach the client).
export function splitRoute(raw) {
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
// which desk so the pipeline crumb reads the same as any other arrival. An <edit> is a door into
// the desk that OWNS the item.
export const EDIT_KIND_DESKS = Object.freeze(Object.fromEntries(
    Object.values(DESKS).filter(d => d.editable && d.entityKind).map(d => [d.entityKind, d.desk]),
))
export const EDIT_KINDS = new Set(Object.keys(EDIT_KIND_DESKS))

// `<edit>coverage 3f9c…</edit>` → { kind, ref, desk }, or null when there is nothing openable.
// BOTH halves or nothing: a kind with no handle names no item, a handle with no kind names no list
// to find it in. Returning null in either case lets the turn fall through to a plain reply, which
// is strictly better than sending the user to a desk that starts the wrong work.
export function splitEdit(raw) {
    if (typeof raw !== 'string') return null
    const [kind = '', ref = ''] = raw.trim().split(/[\s:,]+/)
    const k = kind.toLowerCase()
    const desk = EDIT_KIND_DESKS[k]
    if (!desk || !ref) return null
    return { kind: k, ref, desk }
}

// The kinds that have a DETAIL SURFACE — the window a card opens when you click it: the chart, the
// plan, the monitor's journal, the positions the entity owns.
//
// `<show>setup 3f9c…</show>` is the third sibling, and it is neither of the other two. A `<route>`
// opens a desk for new work; an `<edit>` reopens the CHAT that authored an item, to change it;
// a show opens the item's own READ surface and changes nothing — "what's going on with this one"
// is a question about the trade, not a request to redraw it. Sending that ask to Mentor would
// reopen the build conversation and start re-planning a setup the user only wanted to look at.
//
// No desk here, deliberately: a detail view belongs to no desk — it is the entity's own page, and
// the client opens it the same way the card click does (the pop-out on a desktop, the full-screen
// page on a phone).
//
// ONE KIND, because a tag is only as good as the handle that reaches it. `idea` was here for a day
// and came out: the kind is alive — it is the execution tier every order rides and a portfolio
// holding IS an idea document — but nothing an agent reads ever names one. `get_watched_items`
// lists setups, books, coverage, scans, queued actions and Aether events; a holding is reached
// through its book, and the positions in `get_trading_context` carry no entity id at all. A kind an
// agent cannot quote is a tag that can only be emitted wrong. The CLIENT still opens ideas — the
// Floor's holdings and the positions rows do it on a click — which is a different list
// (entityDetail.INLINE_KINDS) for a different question: what a page exists for, not what a model
// may name. Give ideas a handle a desk can read and this is one word.
// `ticket` opens the order ticket (plan phase 7) — a code screen, no desk; its ref is an optional symbol.
// `heatmap` and `calendar` (Roy, 2026-10-19) open the house's two read-only VIEWS: the forecast heat map (Pythia's
// industries — its ref an optional symbol to focus on) and the month calendar. Screens, like the ticket: no desk, no item.
// The Floor's LISTS (Roy, 2026-10-22: "I want Axl to be able to present them all" … "the user should be able to see
// all lists through Axl") — each opens its window over the chat, the same one its header in the list column opens.
// Named in the user's words; the client maps them to its desks. `positions` opens the book in a window too (the left
// column is hidden on a narrower screen); `board` is Pythia's Forecast board. An ADMIN's list would go in ADMIN_SHOWS
// (a trader's show of it is dropped, `routeFields`) — none since the research queue stopped being a list (2026-10-31).
// `watchlists` (Argus's scans) left on 2026-11-09 with the list itself (archive/README.md).
export const SHOW_LISTS = new Set(['positions', 'orders', 'trades', 'portfolios', 'hotlist', 'board'])
const ADMIN_SHOWS = new Set()
export const SHOW_KINDS = new Set(['setup', 'ticket', 'heatmap', 'calendar', ...SHOW_LISTS])
// The screens — a show whose ref is optional, because what it opens exists without one.
const SHOW_SCREENS = new Set(['ticket', 'heatmap', 'calendar', ...SHOW_LISTS])

/** `<show>setup 3f9c…</show>` → { kind, ref }, or null. Both halves or nothing, as with an edit — a screen's ref is optional. */
export function splitShow(raw) {
    if (typeof raw !== 'string') return null
    const [kind = '', ref = ''] = raw.trim().split(/[\s:,]+/)
    const k = kind.toLowerCase()
    if (SHOW_SCREENS.has(k)) return { kind: k, ref: ref || null }
    if (!SHOW_KINDS.has(k) || !ref) return null
    return { kind: k, ref }
}

// What the desk OPENS ON — the job, as the first turn of the desk's conversation.
//
// This is the whole hand-off. It replaced an `objectives` record (2026-08-05) that tried to carry
// the job as DATA — target, horizon, risk, scope — and got two things wrong at once. It outlived the
// job it described, so a portfolio goal set in August was still telling the trade desk to assume a
// 3-month horizon and 5% risk; and collecting it turned reception into an interrogation, asking for
// numbers that belong to the desk's own first phase. Everything travels as a sentence and the desk
// takes it from there.
//
// It rides beside `<route>` rather than inside it: prose has spaces and newlines, and splitRoute
// splits on those. No route → no opening, since there is no desk to open.
const MAX_OPENING = 600
export function cleanOpening(raw) {
    if (typeof raw !== 'string') return null
    // Collapse the hard wrapping a model does inside a tag — this becomes a chat message, not a
    // document. Cap it because it is a first turn, not a brief: something longer is a summary the
    // desk did not ask for, and it is better served by the sentences than by an essay.
    // A desk's `<ticker>NVDA</ticker>` markup is for ITS reply's chips; in an opening it would show raw as the user's
    // message (Proteus's hand-back to Axl, 2026-11-13) — the name stays, the tag goes.
    const text = raw.replace(/<ticker>\s*([^<]*?)\s*<\/ticker>/gi, '$1').replace(/\s+/g, ' ').trim().slice(0, MAX_OPENING)
    return text || null
}

// ─── Validation (the controller tier) ─────────────────────────────────────────

/** The desk a reply may hand THIS user to, or null. */
export function routeFor(role, route) {
    if (!VALID_PIPELINES.has(route)) return null
    if (role !== 'admin' && ADMIN_DESKS.includes(route)) return null
    return route
}

// The ticker a reply may hand over with the desk. Sanitized on the same principle as the desk key:
// it becomes the desk's OPENING TURN, so a hallucinated "the" or a company name would put an agent
// to work on nothing. Anything that isn't a plausible symbol is dropped and the desk opens empty.
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,11}$/
export function sanitizeRouteSymbol(raw) {
    if (typeof raw !== 'string') return null
    const symbol = raw.trim().toUpperCase()
    return SYMBOL_RE.test(symbol) ? symbol : null
}

// The handle an agent quotes back for an edit: an item id (a UUID), or — when it has none to hand —
// a bare ticker the client can match on instead. Deliberately permissive about WHICH of the two:
// this is used to look something up in a list the client already holds, so a wrong or invented ref
// finds nothing and opens nothing. It can never reach another user's data. The gate is only here to
// keep junk (a sentence, a quoted phrase) from travelling as if it were a handle.
const EDIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export function sanitizeEditRef(raw) {
    if (typeof raw !== 'string') return null
    const ref = raw.trim()
    return EDIT_REF_RE.test(ref) ? ref : null
}

/** The whole edit hand-off, or null — kind, desk and ref all have to survive for it to mean anything. */
export function validateEdit(edit) {
    if (!edit || !EDIT_KINDS.has(edit.kind) || !VALID_PIPELINES.has(edit.desk)) return null
    const ref = sanitizeEditRef(edit.ref)
    return ref ? { kind: edit.kind, ref, desk: edit.desk } : null
}

/**
 * The whole show hand-off, or null. Same gate as an edit minus the desk — a detail view has none.
 * The ref is read by the client through the owner-scoped get, so a borrowed or invented id opens
 * nothing; this only keeps junk (a sentence, a quoted phrase) from travelling as a handle.
 */
export function validateShow(show) {
    if (!show || !SHOW_KINDS.has(show.kind)) return null
    // A screen's ref is a symbol at most (the ticket's, the heat map's focus); the calendar takes none.
    if (show.kind === 'calendar' || SHOW_LISTS.has(show.kind)) return { kind: show.kind, ref: null }
    if (SHOW_SCREENS.has(show.kind)) return { kind: show.kind, ref: sanitizeRouteSymbol(show.ref) }
    const ref = sanitizeEditRef(show.ref)
    return ref ? { kind: show.kind, ref } : null
}

/** The show THIS user may be given: an admin's list (the research queue) is dropped for anyone else. */
export function showFor(role, show) {
    const v = validateShow(show)
    return v && ADMIN_SHOWS.has(v.kind) && role !== 'admin' ? null : v
}

/**
 * The routing fields of a `done` payload, validated for this user. Spread into the controller's
 * return beside the agent's own fields. Every gate is the same one: a symbol, an opening or an
 * adopt flag with no desk to land at is a message sent to no one.
 */
export function routeFields(result, role) {
    const route = routeFor(role, result?.route)
    return {
        route,
        routeSymbol: route ? sanitizeRouteSymbol(result?.routeSymbol) : null,
        // Reopen an item the user already has, in the desk that owns it. Independent of `route` —
        // it carries its own desk.
        edit:    validateEdit(result?.edit),
        // Open an item's own detail surface. Independent of both — it goes to no desk at all.
        show:    showFor(role, result?.show),
        opening: route ? (result?.opening ?? null) : null,
    }
}

// ─── The capture (the agent tier) ─────────────────────────────────────────────

/**
 * One routing capture for an agent's turn. `captures` spreads into buildTagCaptures; `result()`
 * after the run gives the fields the controller validates. The three tags are read together
 * because they gate each other: an `<open>` on a turn that routes nowhere has no conversation to
 * start, and an EDIT reopens a document that already holds its own history — the desk resumes it
 * rather than beginning again, so an opening turn there would talk over what is already on the page.
 *
 * `agentKey` names the sender so a desk routing to ITSELF is dropped here: the rule says never, and
 * this is the gate that holds when a model forgets — a "Go to Argus" button under Argus's own reply
 * would reopen the desk the user is sitting at on a blank page. Axl passes 'axl' (it stands at no desk, so nothing is
 * dropped as his own) — the key a desk restricted to named senders (registry routedFrom) checks.
 */
export function makeRouteCapture(agentKey = null) {
    let routeText = null, openText = null, editText = null, showText = null
    const own = AGENT_DESK[agentKey] ?? null
    return {
        captures: {
            route: (text) => { routeText = text.trim() },
            open:  (text) => { openText = text },
            edit:  (text) => { editText = text.trim() },
            show:  (text) => { showText = text.trim() },
        },
        result() {
            const split = splitRoute(routeText)
            const desk = ((own && split.desk === own) || !mayRoute(agentKey, split.desk)) ? null : split.desk
            const symbol = desk ? split.symbol : null
            const edit = splitEdit(editText)
            const opening = (desk && !edit) ? cleanOpening(openText) : null
            // ONE destination per turn, and a hand-off outranks a look: the desk (or the document)
            // the user is being taken to IS the turn, and a detail window opening beside it would
            // put a second thing on screen at the moment the first one arrives. Gated here rather
            // than trusted to the prompt, for the reason `opening` and `routeSymbol` are.
            const show = (desk || edit) ? null : splitShow(showText)
            return { route: desk, routeSymbol: symbol, opening, edit, show }
        },
    }
}

// ─── The rule (the prompt tier) ───────────────────────────────────────────────

/**
 * The routing section a DESK's spine carries — appended to its cached block like LANGUAGE_RULE, so
 * it costs no breakpoint (the budget is four per request, and the desks with a mode module already
 * spend two on the system prompt). Constant per agent, so the cache holds. Lists every routable desk
 * but the sender's own.
 */
export function buildRouteRule(agentKey) {
    const own = AGENT_DESK[agentKey] ?? null
    const desks = Object.entries(ROUTABLE_DESKS).filter(([key]) => key !== own && mayRoute(agentKey, key))
    // Listed by ROLE, never by internal name (one-axl.md): the user sees one Axl, and a name in the prompt is a name in a reply.
    const lines = desks.map(([key, d]) => `- **the ${d.role}** (\`${key}\`) — ${d.does}.`).join('\n')
    const [exKey, ex] = desks[0]
    return `

---

## Sending the user to another role

The app has other roles, each with its own work. When the user asks for one, or to send a name there — "send NVDA to the ${ex.role}", "take this to the ${desks[1]?.[1].role ?? ex.role}", "let the ${desks[desks.length - 1][1].role} look at it" — hand them over on that turn:

${lines}

Emit, each on its own line, at the end of your reply:

<route>${exKey} NVDA</route>
<open>Look at NVDA — the user wants to know if it is worth owning, not just trading. Here it has been basing under 250 for six weeks with relative strength leading SMH; earnings on 11/20 is the dated catalyst; dollar volume is deep. They hold no position yet.</open>

- \`<route>\` is the desk key and, when there is one, the ticker. Only the keys above; never your own desk.
- \`<open>\` is the desk's FIRST TURN — it is sent as the user's message on arrival. The desk cannot see this conversation, so the opening is where what you learned travels: the user's ask, plus what you found on the name in this session. Facts and your read, not a summary of the chat and not the desk's conclusion — it forms its own.
- **Always emit it.** Naming the desk is how the user said WHERE; the verb and what it acts on are WHAT they want done, and that is the opening. Route bare and the desk opens on a blank page and asks for what they just told you.
- **Only when the user asked.** Never route to be helpful, and never to close a question you could answer here. One hand-off per turn; several names → ask which one first.
- At most one short line, in your own voice and naming no one ("Let me look at the business side."). Do not describe a queue or a wait, and do not ask them to confirm — the block IS the hand-off; the app shows the role that takes over.${backToReception(agentKey) ? RECEPTION_RULE : ''}`
}

// The hand-back half of the rule (Roy, 2026-11-13: "if I ask an agent a question that doesn't belong to him, he turns it
// to Axl"). Constant, so every desk that carries it keeps one cached prompt. Exported for tests.
export const RECEPTION_RULE = `

## A question that is not yours — back to reception

When the user asks you something that belongs to another role — not a request to go there, just a question outside your own work ("is it a good business?" to the technical analyst, "how does it trade?" to the analyst, a portfolio question while building one trade, the news, their account) — do not answer it, and do not just name the role and stop. Hand it back to reception, which sends it on to the right role at once:

<route>${RECEPTION}</route>
<open>is NVDA a good business at this price?</open>

- \`<open>\` is the user's question as they asked it, with the ticker — reception reads it as their message.
- Write NO words on that turn — only the two tags. To the user it is one assistant changing hats; the app shows the role that answers.
- Only when it is plainly not yours. A question you can answer, even in part, is yours; a follow-up on what you just said is yours.
- When the user asks for a role by its job ("let the trader build it"), route there directly (above), not through reception.`

export const routingUtil = { splitRoute, splitEdit, splitShow, cleanOpening, routeFor, mayRoute, sanitizeRouteSymbol, sanitizeEditRef, validateEdit, validateShow, routeFields, makeRouteCapture, buildRouteRule }
