// ── The desks — ONE registry ──────────────────────────────────────────────────
// Every agent that speaks in a chat, once: its key, the desk (pipeline key) the client still routes by,
// its brand, the entity its work produces, the session scope it talks in, whether it is admin-only, and
// how much of its own history it carries.
//
// Five lists used to say parts of this by hand — routing.util's VALID_PIPELINES / ROUTABLE_DESKS /
// AGENT_DESK / EDIT_KIND_DESKS / ADMIN_DESKS and session.util's agent and kind lists — and a desk added
// to one and not the others was routed to, refused, or sealed nowhere. They all derive from here now
// (unified-chat plan phase 4).
//
// Pure data. Agents, routing and the session store import from it; it imports nothing.

/**
 * @typedef {object} DeskEntry
 * @property {string}      agent        the AGENTS key the client knows the agent by
 * @property {string|null} desk         the pipeline key a <route> names — null for Axl (reception has no desk)
 * @property {string}      brand        the name the user sees
 * @property {string|null} entityKind   what its work produces and an edit reopens — null if nothing
 * @property {boolean}     editable     whether <edit>kind id</edit> may reopen that entity at this desk
 * @property {boolean}     routable     whether ANOTHER desk may send the user here with a name
 * @property {string|null} does         the one line a sender's prompt shows (routable desks only)
 * @property {'main'|'strategy'|'aether'} scope  the session it talks in
 * @property {boolean}     admin        admin-only (the route gate and the prompts both hold it)
 * @property {number}      maxMessages  how much of its own history a turn carries (trimHistory keep)
 */

/** @type {Readonly<Record<string, DeskEntry>>} */
export const DESKS = Object.freeze({
    axl: Object.freeze({
        agent: 'axl', desk: null, brand: 'Axl', entityKind: null, editable: false, routable: false, does: null,
        // Reception remembers deeper than a desk: its trim lands three times less often (see agentUtils.trimHistory).
        scope: 'main', admin: false, maxMessages: 20,
    }),
    // ORDER IS LOAD-BEARING for the routable four: buildRouteRule lists them in this order inside every
    // desk's prompt, and a reorder changes every prompt (and its cache).
    analyst: Object.freeze({
        agent: 'analyst', desk: 'research', brand: 'Prometheus', entityKind: 'coverage', editable: true, routable: true,
        does: 'researches a company into house coverage — a thesis and a price target vs the Street',
        scope: 'main', admin: false, maxMessages: 8,
    }),
    mentor: Object.freeze({
        agent: 'mentor', desk: 'assist', brand: 'Mentor', entityKind: 'setup', editable: true, routable: true,
        does: 'builds ONE trade setup with the user, level by level, and arms it for monitoring',
        scope: 'main', admin: false, maxMessages: 8,
    }),
    portfolio: Object.freeze({
        agent: 'portfolio', desk: 'portfolio', brand: 'Atlas', entityKind: 'portfolio', editable: true, routable: true,
        does: 'builds and reviews a portfolio book against a mandate',
        scope: 'main', admin: false, maxMessages: 10,
    }),
    scanner: Object.freeze({
        agent: 'scanner', desk: 'scan', brand: 'Argus', entityKind: 'scan', editable: true, routable: true,
        does: 'scans the market for a ranked watchlist, or validates a single name for a trade',
        scope: 'main', admin: false, maxMessages: 10,
    }),
    // The admin desks: Pythia sets the house view and Aether reads event exposure. Neither is somewhere a
    // desk sends a user with a name (not routable — no desk agent has to know the user's role to write a
    // correct offer); Axl still routes admins to both. Each keeps its own panel and session (decision 16).
    strategy: Object.freeze({
        agent: 'strategy', desk: 'strategy', brand: 'Pythia', entityKind: 'industry_view', editable: false, routable: false, does: null,
        scope: 'strategy', admin: true, maxMessages: 8,
    }),
    aether: Object.freeze({
        agent: 'aether', desk: 'aether', brand: 'Aether', entityKind: null, editable: false, routable: false, does: null,
        scope: 'aether', admin: true, maxMessages: 12,
    }),
})

// `trade` is Axl's older word for one new trade. A desk never sends anyone there; Axl may. It entered at
// Argus until 2026-10-19 — "I want to talk to the trader" landed on the scanner. Every trade now STARTS at
// Mentor (Roy): Mentor asks whether the user has a name or a setup, and sends them to Argus only when they
// have none (HAND_BACK below brings the name back). Kept as a key so a reply that still says it lands right.
const COMPOSITES = Object.freeze({
    trade: Object.freeze({ agent: 'mentor', state: null }),
})

// The mode a desk's route PRESETS on its landing when the sender wants the result back: Mentor sending the
// user to Argus is "find me ONE name to build on", so Argus starts in single-pick mode and the chain carries
// the pick back to Mentor (unified-chat plan phase 5). sender → landing agent → preset.
const HAND_BACK = Object.freeze({
    mentor: Object.freeze({ scanner: Object.freeze({ handoff: true, handoffTo: 'mentor' }) }),
})
const COMPOSITE_PIPELINES = Object.freeze(Object.keys(COMPOSITES))

const entries = Object.values(DESKS)

/** Every agent key. */
export const AGENT_KEYS = Object.freeze(entries.map(d => d.agent))

/** Every pipeline a <route> may name. */
export const PIPELINE_KEYS = Object.freeze([...COMPOSITE_PIPELINES, ...entries.filter(d => d.desk).map(d => d.desk)])

/** Pipelines only an admin is routed to. */
export const ADMIN_PIPELINE_KEYS = Object.freeze(entries.filter(d => d.admin && d.desk).map(d => d.desk))

/** The kinds an agent's context can be sealed onto — every kind a desk's work produces. */
export const ENTITY_KINDS = Object.freeze(entries.filter(d => d.entityKind).map(d => d.entityKind))

/** The entry for an agent key, or null. */
export const deskOf = (agent) => DESKS[agent] ?? null

/** The agent standing at a pipeline key, or null (a composite pipeline names no one agent). */
export const agentAtDesk = (desk) => entries.find(d => d.desk === desk)?.agent ?? null

/**
 * Where a route LANDS: the agent that takes the floor, and the working state it starts in (a composite's
 * mode) — or null for an unknown pipeline. A single-agent desk lands on its agent with no preset state.
 * @returns {{ agent: string, state: object|null } | null}
 */
export function entryOf(desk) {
    if (COMPOSITES[desk]) return { agent: COMPOSITES[desk].agent, state: COMPOSITES[desk].state ? { ...COMPOSITES[desk].state } : null }
    const agent = agentAtDesk(desk)
    return agent ? { agent, state: null } : null
}

/** The mode a route from `from` presets on `to` so the result comes back (a copy), or null. */
export function handBackOf(from, to) {
    const preset = HAND_BACK[from]?.[to]
    return preset ? { ...preset } : null
}

/** The agent whose work produces an entity kind, or null. */
export const agentForKind = (kind) => entries.find(d => d.entityKind === kind)?.agent ?? null
