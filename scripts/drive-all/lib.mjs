// Pure helpers for the whole-app drive (scripts/drive-all.mjs). Node-side AND page-side: the colour
// helpers are also injected into the browser (see BROWSER_HELPERS), so they must stay
// self-contained — no imports, no closures over module state.

/** 'rgb(1, 2, 3)' · 'rgba(1,2,3,0.5)' · '#abc' · '#aabbcc' · '#aabbccdd' → { r, g, b, a } or null. */
export function parseColor(s) {
    if (!s || typeof s !== 'string') return null
    const t = s.trim().toLowerCase()
    if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
    let m = t.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/)
    if (m) {
        let a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
        if (!Number.isFinite(a)) a = 1
        return { r: +m[1], g: +m[2], b: +m[3], a }
    }
    // what a computed `color-mix(in srgb, …)` comes back as: channels 0..1
    m = t.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+%?))?\s*\)$/)
    if (m) {
        let a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
        if (!Number.isFinite(a)) a = 1
        return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a }
    }
    m = t.match(/^#([0-9a-f]{3,8})$/)
    if (m) {
        let h = m[1]
        if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('')
        if (h.length !== 6 && h.length !== 8) return null
        return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
            a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }
    }
    return null
}

/** Paint `top` (with its alpha) over an opaque `bottom`. */
export function blend(top, bottom) {
    const a = top.a ?? 1
    return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 }
}

/** WCAG relative luminance of an opaque colour. */
export function luminance({ r, g, b }) {
    const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

/** WCAG contrast ratio, 1..21. Both colours opaque (blend first). */
export function contrastRatio(fg, bg) {
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
}

/** Plain RGB distance, alpha ignored — "is this the same token at another opacity". */
export function colorDistance(x, y) {
    return Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b)
}

/** The closest palette colour and how far it is; null for an empty palette. */
export function nearestColor(c, palette) {
    let best = null
    for (const p of palette) {
        const d = colorDistance(c, p)
        if (!best || d < best.d) best = { color: p, d }
    }
    return best
}

/** First family of a CSS font-family list, unquoted and lower-cased: `'Space Mono', monospace` → `space mono`. */
export function firstFamily(list) {
    return String(list ?? '').split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase()
}

/** The source of the helpers above, for `page.addInitScript` — installs `window.__driveLib`. */
export const BROWSER_HELPERS = `window.__driveLib = (() => {
    ${parseColor.toString()}
    ${blend.toString()}
    ${luminance.toString()}
    ${contrastRatio.toString()}
    ${colorDistance.toString()}
    ${nearestColor.toString()}
    ${firstFamily.toString()}
    return { parseColor, blend, luminance, contrastRatio, colorDistance, nearestColor, firstFamily }
})();`

// ── the read-only guard ─────────────────────────────────────────────────────────────────────────
// The drive is a LOOK at the app, never a change to it. Every request that could change state is
// aborted unless it is on this list, and every abort is reported — so a screen that needs a write
// shows up as "blocked", not as a silent edit to the QA user's data.

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// The writes a screen may make — all of them the QA user's own view state, none of them trades,
// setups, books or chat turns. Anything else a screen tries is stopped and listed in the report.
export const ALLOW = [
    { method: 'POST', path: '/api/auth/signin' },
    { method: 'PUT',  path: '/api/workspace' },                              // the LIVE · PAPER · MANUAL switch
    { method: 'PUT',  path: '/api/paper/mode' },                             // …which the paper venue mirrors
    { method: 'POST', path: /^\/api\/chat\/conversations\/[^/]+\/read$/ },   // opening a conversation marks it read
]

// With --with-agents, the chat may talk: a new session, a turn, a chain's continue, a desk's commit (Generate) and a
// stop. Still never a broker, an arm (that is the setup window's own route, not on this list) or a delete from the UI.
// NOT covered by this guard (by design): the drive's own `page.request` calls (the cleanup's deletes) and what a desk's
// go does on the server — Mentor's go saves AND arms (the trader step never says "all the way"; a setup a turn saved by
// itself is failed and deleted at once).
export const ALLOW_AGENTS = [
    { method: 'POST', path: '/api/sessions/new' },
    { method: 'POST', path: /^\/api\/sessions\/[^/]+\/(turn|continue|act|edit)$/ },
    { method: 'POST', path: /^\/api\/turns\/[^/]+\/stop$/ },
    { method: 'POST', path: '/api/setups/validate' },                        // the pane checks a draft — reads only
]

/**
 * Should this request be stopped? `allow` is a list of { method, path } (path: exact string or RegExp)
 * that may go through. Only /api/ calls are guarded — page assets and the Vite client are not writes.
 */
export function isBlockedWrite(method, url, allow = []) {
    const m = String(method ?? '').toUpperCase()
    if (!MUTATING.has(m)) return false
    let path
    try { path = new URL(url).pathname } catch { return true }
    if (!path.startsWith('/api/')) return false
    return !allow.some(a => (!a.method || a.method.toUpperCase() === m)
        && (a.path instanceof RegExp ? a.path.test(path) : a.path === path))
}

/** Does the text state this number anywhere? Compared by VALUE: "$22.80" and "22.8" both state 22.8; "122.8" does not. */
export function mentionsNumber(text, n) {
    const want = Number(n)
    if (!Number.isFinite(want)) return false
    for (const m of String(text ?? '').matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
        if (Math.abs(Number(m[0].replace(/,/g, '')) - want) < 0.005) return true
    }
    return false
}

/**
 * A sentence said twice in one chat row — a model's channel leaking (the answer, its reasoning, the answer again; the
 * drive, 2026-11-18). Sentences of 20+ characters, compared trimmed. Returns the repeated sentence, or null. The
 * drive's own check, kept apart from the app's cleaner (services/agentUtils dropDebris) on purpose.
 */
export function echoedSentence(text) {
    const seen = new Set()
    // Brackets out first: the leak's reasoning sits in one, and its "?" would otherwise glue onto the second copy.
    for (const s of String(text ?? '').replace(/\([^()\n]{0,160}\)/g, ' ').match(/[^.!?\n]{20,}[.!?]/g) ?? []) {
        const k = s.trim()
        if (seen.has(k)) return k
        seen.add(k)
    }
    return null
}

// ── which steps run ────────────────────────────────────────────────────────────────────────────

/**
 * The run's steps, in order. Agent steps go after the last DESKTOP screen step — the runner resizes one page and the
 * laptop/phone passes come last. `only` (lower-cased names) filters; picking any agent step brings the agent
 * bookends (`bookend: true` — prepare and clean up) along, because the others need the name and baseline they set.
 */
export function composeSteps(screens, agents, { withAgents = false, agentsOnly = false, only = [] } = {}) {
    let list
    if (agentsOnly) list = [...agents]
    else if (withAgents) {
        const cut = screens.findLastIndex(s => s.viewport === 'desktop') + 1
        list = [...screens.slice(0, cut), ...agents, ...screens.slice(cut)]
    } else list = [...screens]
    if (!only.length) return list
    const picked = list.filter(s => only.includes(s.name.toLowerCase()))
    if (!picked.some(s => agents.includes(s))) return picked
    return list.filter(s => picked.includes(s) || (s.bookend && agents.includes(s)))
}

// ── results ────────────────────────────────────────────────────────────────────────────────────

/** Totals over the step results: steps passed/failed, checks failed, design warnings by kind. */
export function summarize(steps) {
    const out = { steps: steps.length, passed: 0, failed: 0, checksFailed: 0, warnings: 0, byKind: {} }
    for (const s of steps) {
        const bad = (s.checks ?? []).filter(c => !c.ok).length + (s.errors ?? []).length + (s.crashed ? 1 : 0)
        out.checksFailed += bad
        if (bad) out.failed++; else out.passed++
        for (const w of s.warnings ?? []) {
            out.warnings++
            out.byKind[w.kind] = (out.byKind[w.kind] ?? 0) + 1
        }
    }
    return out
}

/**
 * Collapse repeated warnings and count them, so a 40-row list is one line. Grouped by kind + message +
 * COMPONENT (the `tag.class` that opens `where`) — a design fix lands on a component, not on a row.
 */
export function groupWarnings(warnings) {
    const map = new Map()
    for (const w of warnings ?? []) {
        const component = String(w.where ?? '').split(' ')[0]
        const key = `${w.kind}\u0000${w.message}\u0000${component}`
        const g = map.get(key)
        if (g) { g.count++; if (g.samples.length < 3 && w.where) g.samples.push(w.where) }
        else map.set(key, { kind: w.kind, severity: w.severity, message: w.message, count: 1, samples: w.where ? [w.where] : [] })
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
}

/** Which console/network noise is not a failure: the 401 the signed-out boot makes, favicon misses. */
export function isIgnorableError(text) {
    return /\/api\/auth\/me\b.*\b401\b|\b401\b.*\/api\/auth\/me\b|favicon|net::ERR_ABORTED/i.test(String(text ?? ''))
}

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
