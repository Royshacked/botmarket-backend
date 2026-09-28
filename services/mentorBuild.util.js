/**
 * THE BUILD LEDGER — what a Mentor build has settled, and what it may settle next.
 *
 * Mentor's flow used to live entirely in the prompt: an eight-rung ladder the model climbed by
 * reading its own last worksheet and finding the first blank field. That worked while the flow was
 * a straight line. It stops working once the flow has waivable gates, two loops and more than one
 * name in play — a skipped gate is then invisible, because the only record of the flow is prose the
 * model may or may not have followed. So the flow moves here (docs/design/mentor-flow-intent.md, D1).
 *
 * TWO IDEAS CARRY THE WHOLE MODULE.
 *
 * **Claimed is not settled.** A value someone ASSERTED — the user opening with "long, swing", Argus
 * handing over a direction, Mentor proposing a lens — is a CLAIM. It becomes SETTLED only when it is
 * confirmed. That distinction is what lets one intake machine serve all three arrivals: whatever
 * arrived is claimed, the opening turn validates the claims and proposes the blanks, and the user's
 * one reply settles them together.
 *
 * **Enforce settlement, not speech** (D4). Nothing here knows or cares what the conversation is
 * about. The user may ask about earnings in the middle of sizing and the ledger does not move; the
 * ledger only ever refuses to RECORD something out of order. That is the resolution of the tension
 * between free conversation and not forgetting steps: the ledger stops things being forgotten, and
 * never stops things being said.
 *
 * PURE. No clock, no I/O, no mutation of its inputs — the caller owns the state and passes it in,
 * exactly as `chatState` already works at this desk (nothing persists until Generate).
 */

// The stages, in the order they settle. `fields` are what a stage owes; a stage is settled when all
// of its fields are. `waivable` is the user's answer to the opening turn's second ask — the two
// gates may be waived, the opening, sizing and the summary never can (intent #14).
export const STAGES = [
    { key: 'opening', fields: ['direction', 'horizon', 'lens'], waivable: false },
    { key: 'spans',   fields: ['spans'],                        waivable: true  },
    { key: 'entries', fields: ['entries'],                      waivable: true  },
    { key: 'sizing',  fields: ['size'],                         waivable: false },
    { key: 'summary', fields: ['generate'],                     waivable: false },
]

export const STAGE_KEYS = STAGES.map(s => s.key)

/** field → the stage that owns it. Built once; the fields are disjoint by construction. */
const FIELD_STAGE = Object.fromEntries(STAGES.flatMap(s => s.fields.map(f => [f, s.key])))

export const BUILD_FIELDS = Object.keys(FIELD_STAGE)

/** Who asserted a claim. Provenance matters: a user's claim is validated, Mentor's is proposed. */
export const CLAIM_SOURCES = ['user', 'argus', 'mentor']

const stageIndex = (key) => STAGE_KEYS.indexOf(key)

const sameValue = (a, b) => (a === b) || (JSON.stringify(a ?? null) === JSON.stringify(b ?? null))

// ─── State ────────────────────────────────────────────────────────────────────

/** A build with no names in it yet. `waiver` is build-wide: the user answers it once, not per name. */
export function emptyBuild() {
    return { names: [], active: '', waiver: false }
}

/** One name's ledger. `claimed` holds { value, source }; `settled` holds the confirmed value. */
export function emptyName(asset) {
    return { asset: String(asset ?? '').trim().toUpperCase(), claimed: {}, settled: {} }
}

export function nameFor(build, asset) {
    const want = String(asset ?? '').trim().toUpperCase()
    return (build?.names ?? []).find(n => n.asset === want) ?? null
}

/** Add a name if it isn't there, and make it the active one. Idempotent. */
export function upsertName(build, asset) {
    const want = String(asset ?? '').trim().toUpperCase()
    if (!want) return build
    const names = nameFor(build, want) ? build.names : [...(build?.names ?? []), emptyName(want)]
    return { ...build, names, active: want }
}

export function activeName(build) {
    return nameFor(build, build?.active) ?? null
}

/**
 * Put a mutated name back into the build. The ledger is immutable, so callers thread it through —
 * and a name the build has never heard of is a threading BUG, not a no-op: mapping over the list
 * would match nothing and drop a whole turn's settlements without a word. It is appended instead,
 * so the work survives and `names` still tells the truth about what is being built.
 */
export function putName(build, name) {
    const names = build?.names ?? []
    return names.some(n => n.asset === name?.asset)
        ? { ...build, names: names.map(n => (n.asset === name.asset ? name : n)) }
        : { ...build, names: [...names, name] }
}

export function setWaiver(build, on) {
    return { ...build, waiver: Boolean(on) }
}

// ─── Claiming ─────────────────────────────────────────────────────────────────

/**
 * Record an assertion. Claims are FREE — anyone may claim anything at any time, in any order,
 * because a claim commits nothing. Only settlement is ordered.
 *
 * `fields` is { direction: 'long', ... }. A claim over an already-SETTLED field is dropped rather
 * than applied: a settled value changes only through `unsettle`, which says out loud what else it
 * just invalidated. Silently overwriting it is how a user ends up with a plan they never agreed to.
 */
export function claim(name, fields, source = 'mentor') {
    const src     = CLAIM_SOURCES.includes(source) ? source : 'mentor'
    const settled = name?.settled ?? {}
    const claimed = { ...(name?.claimed ?? {}) }
    const dropped = []
    for (const [field, value] of Object.entries(fields ?? {})) {
        if (!FIELD_STAGE[field]) { dropped.push(field); continue }
        if (field in settled) { dropped.push(field); continue }
        claimed[field] = { value, source: src }
    }
    return { name: { ...name, claimed }, dropped }
}

export function claimOf(name, field) {
    return name?.claimed?.[field] ?? null
}

// ─── Settling ─────────────────────────────────────────────────────────────────

/**
 * May this field be settled right now? The two teeth of the whole module:
 *
 *  - **nothing settles out of order.** Every field of every EARLIER stage must be settled first.
 *    Sizing cannot be recorded before there is a direction to size.
 *  - **a settled field does not quietly change.** Re-settling the same value is a no-op (the model
 *    re-emits its worksheet every turn, so this happens constantly and is not an error); settling a
 *    DIFFERENT value is refused and the caller must `unsettle` first, which cascades.
 */
export function canSettle(name, field) {
    const stage = FIELD_STAGE[field]
    if (!stage) return { ok: false, reason: `unknown field: ${field}` }

    const claimed = claimOf(name, field)
    if (!claimed) return { ok: false, reason: `nothing claimed for ${field}` }

    if (field in name.settled) {
        return sameValue(name.settled[field], claimed.value)
            ? { ok: true, noop: true }
            : { ok: false, reason: `${field} is settled — unsettle ${stage} to change it` }
    }

    const blocker = STAGES
        .slice(0, stageIndex(stage))
        .find(s => s.fields.some(f => !(f in name.settled)))
    if (blocker) return { ok: false, reason: `${blocker.key} must be settled before ${field}` }

    return { ok: true }
}

/**
 * Confirm claims. `fields` is a list of field names — the VALUE always comes from the claim, never
 * from the settler, so an overrule has to be claimed first and is therefore visible. Refusals are
 * returned, not thrown: an illegal settlement is a model mistake to report back into the next turn,
 * not a crash.
 */
export function settle(name, fields) {
    const settled  = { ...name.settled }
    const refused  = []
    const accepted = []
    for (const field of (Array.isArray(fields) ? fields : [fields])) {
        const verdict = canSettle(name, field)
        if (!verdict.ok) { refused.push({ field, reason: verdict.reason }); continue }
        if (verdict.noop) continue
        settled[field] = claimOf(name, field).value
        accepted.push(field)
    }
    return { name: { ...name, settled }, accepted, refused }
}

/**
 * Reopen a stage — and everything below it. The cascade is the point: if the direction flips while
 * the entries are being placed, those entries were built on a premise that no longer holds, so they
 * are not "still settled, pending review". They are unsettled, and the caller says so in one line.
 *
 * Claims go too, for the same reason: a span Mentor proposed for a long is not a candidate for the
 * short. What survives is the ledger above the reopened stage.
 */
export function unsettle(name, stageKey) {
    const from = stageIndex(stageKey)
    if (from < 0) return { name, cleared: [] }

    const doomed  = new Set(STAGES.slice(from).flatMap(s => s.fields))
    const settled = {}
    const claimed = {}
    const cleared = []
    for (const [field, value] of Object.entries(name.settled)) {
        if (doomed.has(field)) cleared.push(field)
        else settled[field] = value
    }
    for (const [field, value] of Object.entries(name.claimed)) {
        if (!doomed.has(field)) claimed[field] = value
    }
    return { name: { ...name, settled, claimed }, cleared }
}

// ─── Where are we? ────────────────────────────────────────────────────────────

export function isSettled(name, field) {
    return Boolean(name) && field in name.settled
}

/** The stage the build is AT: the first one not fully settled. null when the name is finished. */
export function stageOf(name) {
    return STAGES.find(s => s.fields.some(f => !isSettled(name, f)))?.key ?? null
}

/**
 * The stage the build is at, and exactly which of its fields are still blank. This is what the turn
 * context hands the model, and it is why the model never has to remember where the conversation was:
 * a detour costs nothing, because the answer is recomputed from the ledger every turn (D4.4).
 */
export function firstUnsettled(name) {
    const key = stageOf(name)
    if (!key) return null
    const stage = STAGES.find(s => s.key === key)
    return { stage: key, fields: stage.fields.filter(f => !isSettled(name, f)) }
}

/** Is this stage one the user waived? Only the two gates can be, and only if they said so (#14). */
export function isWaived(build, stageKey) {
    return Boolean(build?.waiver) && Boolean(STAGES.find(s => s.key === stageKey)?.waivable)
}

/** Every name finished — i.e. Generate all has something to generate and nothing to wait for. */
export function buildComplete(build) {
    const names = build?.names ?? []
    return names.length > 0 && names.every(n => stageOf(n) === null)
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

/**
 * A draft the user BROUGHT (arrival 1), or one carried by a client that predates the ledger, read
 * back into claims. Everything a brought plan carries is the user's own, so it is claimed as theirs
 * — but it is still only CLAIMED. Mentor validates it softly before anything is settled, which is
 * the whole difference between "taken down" and "taken as read".
 */
export function claimsFromDraft(draft) {
    const out = {}
    if (draft?.direction)  out.direction = draft.direction
    if (draft?.type)       out.horizon   = draft.type
    if (draft?.trade_mode) out.lens      = draft.trade_mode
    if (Array.isArray(draft?.scenarios) && draft.scenarios.length) {
        out.spans   = draft.scenarios.map((s, i) => s.id ?? s.name ?? `s${i + 1}`)
        out.entries = draft.scenarios.flatMap((s, i) =>
            (s.entry_legs ?? []).map((_, j) => `${s.id ?? s.name ?? `s${i + 1}`}:${j}`))
    }
    // Size is the TRADE's, not a scenario's (step 5), so a draft whose scenarios disagree has not
    // stated one — claiming the first scenario's would hand the user a number they never gave.
    const sizes = (draft?.scenarios ?? []).map(s => Number(s?.quantity)).filter(n => Number.isFinite(n) && n > 0)
    if (sizes.length && sizes.every(n => n === sizes[0])) out.size = sizes[0]
    return out
}
