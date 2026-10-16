// Pure helpers for the unified chat's session store (docs/design/unified-chat.md, plan phase 3).
// NO DB access — session.service.js and agentContext.service.js compose these, and they are tested
// without a database.
//
// Two things, kept apart on purpose (unified-chat.md §3.2):
//   the SESSION  — the whole chat as the user sees it, every agent's turns in order;
//   a CONTEXT    — one agent's own memory: its segment of that chat, the hand-offs addressed to it,
//                  its summary. `segmentOf` is the line between them.

import { AGENT_KEYS, ENTITY_KINDS } from './desks/registry.js'

/** The scopes a session can belong to: the one chat, and the two admin desks that keep their own panel. */
export const SCOPES = Object.freeze(['main', 'strategy', 'aether'])
export const ADMIN_SCOPES = Object.freeze(['strategy', 'aether'])

/** The agents that speak in a session (agentMeta / AGENTS keys) — the desk registry's. */
export const SESSION_AGENTS = AGENT_KEYS

/** What a timeline message is (unified-chat.md §3.1). */
export const MESSAGE_KINDS = Object.freeze(['msg', 'handoff', 'decision', 'card', 'sealed'])

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
    const { agent, role, kind = 'msg', content, ref = null, to = null } = raw
    if (!isAgent(agent)) return { error: 'invalid agent' }
    if (role !== 'user' && role !== 'assistant') return { error: 'role must be user or assistant' }
    if (!MESSAGE_KINDS.includes(kind)) return { error: 'invalid kind' }
    if (kind === 'handoff' && !isAgent(to)) return { error: 'a hand-off needs a receiving agent' }
    const text = cutContent(content)
    if (!text.trim() && kind === 'msg') return { error: 'content must be a non-empty string' }
    return {
        message: {
            agent, role, kind, content: text,
            ref: ref && typeof ref === 'object' ? ref : null,
            to: kind === 'handoff' ? to : null,
            at: now,
        },
    }
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
    return firstUser ? firstUser.content.trim().slice(0, 80) : 'Untitled'
}
