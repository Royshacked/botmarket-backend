// Pure helpers for the conversation-thread lifecycle. NO DB access here — the DB
// service (thread.service.js) composes these. Keeping the tier / TTL / cap / floor
// logic pure is what lets it be unit-tested without a running Mongo (the codebase
// convention: DB-touching modules aren't unit-tested; their pure helpers are).
//
// Three tiers a conversation moves through:
//   trivial  — below the agent's substantive floor → never persisted (discard on clear)
//   draft    — crossed the floor, no artifact yet   → saved with a TTL, LRU-capped
//   linked   — generated an idea/portfolio/scan      → TTL cleared, lives with the artifact

// Draft threads self-expire; linked threads never do.
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000   // 14 days untouched → auto-pruned
export const DRAFT_CAP    = 20                          // keep at most N drafts per user

export function newThreadId() {
    return `thr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// A conversation is worth persisting only once the agent has emitted something
// substantive. The floor keys on the agent's OWN emitted signals (phase / a captured
// block), never on message content — so it stays aligned with "agent decides, no
// hardcoded rules": infrastructure reacting to an agent signal, not a content sniffer.
//   - hasArtifact  → an idea/portfolio/scan already exists (always substantive)
//   - mandateReady → portfolio agent emitted a mandate meeting its minimum
//   - phase        → the agent's own phase; ≥ 2 means past the nucleus/gathering step
export function isSubstantive({ agent, phase, hasArtifact = false, mandateReady = false } = {}) {
    if (hasArtifact) return true
    if (agent === 'portfolio' && mandateReady === true) return true
    const p = Number(phase)
    return Number.isFinite(p) && p >= 2
}

// expiresAt for a tier: a future Date for drafts (Mongo TTL auto-prunes past it),
// null for linked/pinned threads (a TTL index skips docs whose field isn't a Date).
export function computeExpiry(tier, now = Date.now(), ttlMs = DRAFT_TTL_MS) {
    return tier === 'draft' ? new Date(now + ttlMs) : null
}

// Given a user's existing draft threads and a cap, return the ids of the oldest drafts
// to evict so at most `cap` remain once `keepId` (the thread being saved) is counted.
// `keepId` is never evicted. Newest-by-updatedAt are kept.
export function draftsToEvict(drafts = [], cap = DRAFT_CAP, keepId = null) {
    const others = drafts
        .filter(d => d && d.threadId && d.threadId !== keepId)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))   // newest first
    const room = Math.max(0, cap - 1)                             // keepId occupies one slot
    return others.slice(room).map(d => d.threadId)
}

// A short display title: the artifact's own name once linked, else the first user
// message, else a fallback. Trimmed to a sane length for a list row.
export function deriveTitle({ artifactName = null, messages = [] } = {}) {
    if (artifactName && String(artifactName).trim()) return String(artifactName).trim().slice(0, 80)
    const firstUser = Array.isArray(messages)
        ? messages.find(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim())
        : null
    if (firstUser) return firstUser.content.trim().slice(0, 80)
    return 'Untitled'
}
