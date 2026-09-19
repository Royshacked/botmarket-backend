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
// button (`kairos_pick`, Argus's `coverage_request`, …). The conveyor hops — the ones a pipeline
// performs on its own, carrying fields the receiver's UI needs (a mode chip, a queue) — keep their
// artifact kinds. A hop the USER asks for is a sentence, and goes through here.
//
// A NEW AGENT gets every desk with four lines: `+ buildRouteRule('<its key>')` after its spine (before
// the closing LANGUAGE/VENUE/BREVITY rules, which stay last),
// `...route.captures` in its tag captures, `...route.result()` in its return, and
// `...routeFields(result, req.user.role)` in its controller's done payload.

// ─── The desks ────────────────────────────────────────────────────────────────

// The pipelines a reply may hand the user to. Validated server-side rather than trusted from the
// model: an unknown key would leave the client trying to navigate to a tab that doesn't exist, so
// it becomes null and the user simply stays where they are.
export const VALID_PIPELINES = new Set(['trade', 'portfolio', 'scan', 'assist', 'research', 'strategy', 'aether'])

// Admin-only: Pythia (strategy) and Aether. The prompts say so; this is the gate that holds when a
// model forgets, so a trader is never sent to a desk the hub does not show them and the routes 403.
export const ADMIN_DESKS = Object.freeze(['strategy', 'aether'])

/**
 * The desks one DESK may send the user to — each is ONE agent, keyed by the pipeline whose entry
 * tab is that agent, so "send it to Mentor" is `assist` and never `trade` (which enters at Argus).
 * The admin desks are not here: Pythia sets the house view and Aether reads event exposure — neither
 * is somewhere a user asks to be taken with a name, and keeping them out means no desk agent has to
 * know the user's role to write a correct offer. Axl still routes admins to both.
 *
 * `agent` is the AGENTS / activeTab key the client knows the desk's agent by; `does` is the one line
 * the sender's prompt shows.
 */
export const ROUTABLE_DESKS = Object.freeze({
    research:  { agent: 'analyst',   brand: 'Prometheus', does: 'researches a company into house coverage — a thesis and a price target vs the Street' },
    assist:    { agent: 'mentor',    brand: 'Mentor',     does: 'builds ONE trade setup with the user, zone by zone, and arms it for monitoring' },
    portfolio: { agent: 'portfolio', brand: 'Atlas',      does: 'builds and reviews a portfolio book against a mandate' },
    scan:      { agent: 'scanner',   brand: 'Argus',      does: 'scans the market for a ranked watchlist, or validates a single name for a trade' },
})

// The desk each agent stands at, so its own door is left off its list. Argus is also the trade
// desk's entry and Mentor its build step; neither is listed here because `trade` is Axl's composite
// pipeline, not a place a desk sends anyone.
const AGENT_DESK = Object.freeze({ scanner: 'scan', mentor: 'assist', analyst: 'research', portfolio: 'portfolio' })

// ─── Grammar ──────────────────────────────────────────────────────────────────

/** The emit tags this mechanism owns. Strip them all from a reply that captured any. */
export const ROUTE_TAGS = Object.freeze(['route', 'open', 'edit'])

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
// which desk so the pipeline crumb reads the same as any other arrival. `call` left on 2026-08-18
// with Kairos: an <edit> is a door into the desk that OWNS the item, and that desk is archived.
export const EDIT_KIND_DESKS = Object.freeze({ setup: 'assist', coverage: 'research', scan: 'scan', portfolio: 'portfolio' })
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
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_OPENING)
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
 * would reopen the desk the user is sitting at on a blank page. Axl passes none (it stands nowhere).
 */
export function makeRouteCapture(agentKey = null) {
    let routeText = null, openText = null, editText = null
    const own = AGENT_DESK[agentKey] ?? null
    return {
        captures: {
            route: (text) => { routeText = text.trim() },
            open:  (text) => { openText = text },
            edit:  (text) => { editText = text.trim() },
        },
        result() {
            const split = splitRoute(routeText)
            const desk = (own && split.desk === own) ? null : split.desk
            const symbol = desk ? split.symbol : null
            const edit = splitEdit(editText)
            const opening = (desk && !edit) ? cleanOpening(openText) : null
            return { route: desk, routeSymbol: symbol, opening, edit }
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
    const desks = Object.entries(ROUTABLE_DESKS).filter(([key]) => key !== own)
    const lines = desks.map(([key, d]) => `- **${d.brand}** (\`${key}\`) — ${d.does}.`).join('\n')
    const [exKey, ex] = desks[0]
    return `

---

## Sending the user to another desk

The app has other desks, each run by its own agent. When the user asks to go to one, or to send a name there — "send NVDA to ${ex.brand}", "take this to ${desks[1]?.[1].brand ?? ex.brand}", "let ${desks[desks.length - 1][1].brand} look at it" — hand them over on that turn:

${lines}

Emit, each on its own line, at the end of your reply:

<route>${exKey} NVDA</route>
<open>Look at NVDA — the user wants to know if it is worth owning, not just trading. Here it has been basing under 250 for six weeks with relative strength leading SMH; earnings on 11/20 is the dated catalyst; dollar volume is deep. They hold no position yet.</open>

- \`<route>\` is the desk key and, when there is one, the ticker. Only the keys above; never your own desk.
- \`<open>\` is the desk's FIRST TURN — it is sent as the user's message on arrival. The desk cannot see this conversation, so the opening is where what you learned travels: the user's ask, plus what you found on the name in this session. Facts and your read, not a summary of the chat and not the desk's conclusion — it forms its own.
- **Only when the user asked.** Never route to be helpful, and never to close a question you could answer here. One hand-off per turn; several names → ask which one first.
- Say in one line where they are going and why. Do not describe a queue or a wait, and do not ask them to confirm — the block IS the hand-off; the app shows a button carrying it.`
}

export const routingUtil = { splitRoute, splitEdit, cleanOpening, routeFor, sanitizeRouteSymbol, sanitizeEditRef, validateEdit, routeFields, makeRouteCapture, buildRouteRule }
