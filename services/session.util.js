// Pure helpers for the unified chat's session store (docs/design/unified-chat.md, plan phase 3).
// NO DB access — session.service.js and agentContext.service.js compose these, and they are tested
// without a database.
//
// Two things, kept apart on purpose (unified-chat.md §3.2):
//   the SESSION  — the whole chat as the user sees it, every agent's turns in order;
//   a CONTEXT    — one agent's own memory: its segment of that chat, the hand-offs addressed to it,
//                  its summary. `segmentOf` is the line between them.

import { DESKS, AGENT_KEYS, ENTITY_KINDS } from './desks/registry.js'

/** The scopes a session can belong to: the one chat, and the two admin desks that keep their own panel. */
export const SCOPES = Object.freeze(['main', 'strategy', 'aether'])
export const ADMIN_SCOPES = Object.freeze(['strategy', 'aether'])

/** The agents that speak in a session (agentMeta / AGENTS keys) — the desk registry's. */
export const SESSION_AGENTS = AGENT_KEYS

/** What a timeline message is (unified-chat.md §3.1). */
export const MESSAGE_KINDS = Object.freeze(['msg', 'handoff', 'decision', 'sealed'])

/** The entities an agent's context can be sealed onto (unified-chat.md §6.2) — what the desks' work produces. */
export const CONTEXT_KINDS = ENTITY_KINDS

// A message is TEXT (§3.10): tool payloads, scan rows and coverage stay on their entities. A turn longer
// than this is cut with a marker rather than refused — the user's words still land.
export const MAX_CONTENT_CHARS = 32_000
// A sealed context keeps its newest messages plus its summary; older turns live in the summary.
export const MAX_SEALED_MESSAGES = 200

const CUT_MARKER = '\n\n[…cut: message too long to keep in full]'

export function newSessionId() {
    return `ses_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export const isScope = (s) => SCOPES.includes(s)
export const isAgent = (a) => SESSION_AGENTS.includes(a)
export const isContextKind = (k) => CONTEXT_KINDS.includes(k)

/** Cut text to the size a message may keep. Non-strings are no text. */
export function cutContent(text, max = MAX_CONTENT_CHARS) {
    if (typeof text !== 'string') return ''
    return text.length > max ? text.slice(0, max - CUT_MARKER.length) + CUT_MARKER : text
}

/**
 * Validate and normalize one timeline message. Returns `{ message }` or `{ error }`.
 *
 * `agent` is the speaker's desk — for a user turn, the agent it was ADDRESSED to (it belongs to that
 * agent's segment). `to` is the receiving agent of a hand-off; `ref` points at what a message carries
 * (an artifact, a card, a sealed entity) and is stored as given — it is data the store does not read.
 */
export function toTimelineMessage(raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object') return { error: 'message must be an object' }
    const { agent, role, kind = 'msg', content, ref = null, to = null, tools = null } = raw
    if (!isAgent(agent)) return { error: 'invalid agent' }
    if (role !== 'user' && role !== 'assistant') return { error: 'role must be user or assistant' }
    if (!MESSAGE_KINDS.includes(kind)) return { error: 'invalid kind' }
    if (kind === 'handoff' && !isAgent(to)) return { error: 'a hand-off needs a receiving agent' }
    const text = cutContent(content)
    if (!text.trim() && kind === 'msg') return { error: 'content must be a non-empty string' }
    const trace = role === 'assistant' ? toolTrace(tools) : []
    return {
        message: {
            agent, role, kind, content: text,
            ref: ref && typeof ref === 'object' ? ref : null,
            to: kind === 'handoff' ? to : null,
            ...(trace.length ? { tools: trace } : {}),
            at: now,
        },
    }
}

/** At most this many tool entries are kept on a reply — a trace, not a log. */
export const MAX_TOOL_TRACE = 20

/**
 * The tools a reply was written from ("get_behaviour_profile NVDA") — kept on the assistant message so the agent's NEXT
 * turn can see where its own figures came from (Roy, 2026-11-13: Proteus disowned a measured NVDA profile as "made up"
 * because the history held the numbers but not the call). Strings only, trimmed, deduplicated, capped. Pure.
 */
export function toolTrace(tools) {
    if (!Array.isArray(tools)) return []
    const out = []
    for (const t of tools) {
        const s = typeof t === 'string' ? t.trim().slice(0, 80) : ''
        if (s && !out.includes(s)) out.push(s)
        if (out.length >= MAX_TOOL_TRACE) break
    }
    return out
}

/**
 * ONE agent's segment of a session: its own turns (user turns addressed to it and its replies) and the
 * hand-offs addressed TO it, in timeline order. Never another agent's turns — that is the whole of the
 * per-agent context rule (§3.2), and phase 4's `contextFor` builds on exactly this.
 *
 * A hand-off the agent SENT is its own turn too (it is in its segment by `agent`); one it RECEIVED
 * arrives by `to`.
 */
export function segmentOf(messages, agent) {
    if (!Array.isArray(messages)) return []
    return messages.filter(m => m && (
        (m.agent === agent && (m.kind === 'msg' || m.kind === 'handoff' || m.kind === 'decision'))
        || (m.kind === 'handoff' && m.to === agent)
    ))
}

/**
 * The role a segment message plays in ONE agent's conversation: a hand-off addressed TO it reads as the
 * user (someone asking it); everything else keeps its own role. One rule for what the model reads, what
 * is sealed and what is summarized — so the three can never disagree.
 */
export function contextRole(m, agent) {
    return m?.kind === 'handoff' && m.to === agent && m.agent !== agent ? 'user' : m?.role
}

/** The Mongo filter for ONE agent's segment rows — the query form of segmentOf. */
export function segmentQuery(agent) {
    return { $or: [{ agent, kind: { $in: ['msg', 'handoff', 'decision'] } }, { kind: 'handoff', to: agent }] }
}

/**
 * "@Atlas, add this to the growth sleeve" — an agent named at the START of a message, by brand or key,
 * case-insensitive (unified-chat.md §3.3). Returns the agent and the message without the mention, or
 * null when the message names no one (an "@" elsewhere in the text is just text).
 */
export function parseMention(text) {
    if (typeof text !== 'string') return null
    // A ROLE first (one-axl.md, 2026-11-13: the user sees "Axl · Portfolio manager", so "@portfolio manager, …" is what
    // they type) — the full role, longest first, or its last word when that names one role ("@manager" does not, "@trader"
    // does). Then the key or the internal name, as before, so nothing already typed breaks.
    for (const { agent, words } of ROLE_MENTIONS) {
        const m = text.match(new RegExp(`^\\s*@${words}[\\s,:]+([\\s\\S]*)$`, 'i'))
        if (m) return { agent, text: m[1].trim() }
    }
    const m = text.match(/^\s*@([A-Za-z]+)[\s,:]+([\s\S]*)$/)
    if (!m) return null
    const name  = m[1].toLowerCase()
    const agent = Object.values(DESKS).find(d => d.agent === name || d.brand.toLowerCase() === name)?.agent
    return agent ? { agent, text: m[2].trim() } : null
}

// "@portfolio manager" / "@portfolio" / "@stock picker" / "@trader" → the agent. Full roles first, longest first, so
// "@technical analyst" is never read as "@analyst"; a single word only when it names one role.
const ROLE_MENTIONS = (() => {
    const roles = Object.values(DESKS).filter(d => d.role)
    const full = roles.map(d => ({ agent: d.agent, words: d.role.split(' ').join('\\s+') }))
    const firstWords = roles.map(d => ({ agent: d.agent, word: d.role.split(' ')[0] }))
    const unique = firstWords.filter(f => firstWords.filter(g => g.word === f.word).length === 1 && f.word !== f.agent)
        .map(f => ({ agent: f.agent, words: f.word }))
    return [...full, ...unique].sort((a, b) => b.words.length - a.words.length)
})()

/** Normalize the messages being sealed: role-checked text, cut, timestamped. */
export function toContextMessages(messages, now = Date.now()) {
    if (!Array.isArray(messages)) return []
    return messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map(m => ({ role: m.role, content: cutContent(m.content), at: Number.isFinite(m.at) ? m.at : now }))
}

/** Keep the newest MAX_SEALED_MESSAGES — what is older is the summary's job. */
export function capSealed(messages, max = MAX_SEALED_MESSAGES) {
    return messages.length > max ? messages.slice(-max) : messages
}

/**
 * A short display title: the first user message, else a fallback. Trimmed for a list row.
 * (Moved from thread.util.deriveTitle, which goes when the thread store does.)
 */
export function sessionTitle(messages = []) {
    const firstUser = Array.isArray(messages)
        ? messages.find(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim())
        : null
    return firstUser ? firstUser.content.trim().slice(0, 80) : UNTITLED
}

/** The title of a session the user said nothing in — one never kept (session.service startNew). */
export const UNTITLED = 'Untitled'
