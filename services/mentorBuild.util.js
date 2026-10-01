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

import { ENTRY_ARCHETYPES, normalizeTaxon } from './setup.taxonomy.js'
import { VALID_TIMEFRAMES, normalizeTimeframe } from './timeframe.service.js'
import { SIZE_UNITS } from './positionSize.util.js'

// The stages, in the order they settle. `fields` are what a stage owes; a stage is settled when all
// of its fields are. `waivable` is the user's answer to the opening turn's second ask — the two
// gates may be waived, the opening, sizing and the summary never can (intent #14).
//
// `settles` is WHAT COUNTS AS THE USER'S ANSWER at that stage, and it is the server's to apply — a
// stage whose answer has already been given must never wait on a model noticing it:
//
//   confirm — the user agrees to what was put to them (a press, or a `settle` the model reports). A
//             GATE the user handed back (`delegated`, or the build-wide waiver) settles on Mentor's
//             own pick instead, because "you decide" IS the answer.
//   answer  — the user's own number is the answer; there is nothing left to confirm. A size the
//             user gave before the gates were closed is HELD, not refused, and settles the moment
//             they are — Marce's PACB build (2026-10-01) gave $20K, had it refused for an unsettled
//             entry, and was asked for a size again.
//   shown   — settles once the server's figures exist. The summary's answer is pressing Generate
//             (intent #12), which happens outside the conversation; asking for a "yes" to it as well
//             was a second confirmation the spec never had, and Mentor kept asking for it while the
//             button was already lit.
export const STAGES = [
    { key: 'opening', fields: ['direction', 'horizon', 'lens'], waivable: false, settles: 'confirm' },
    { key: 'spans',   fields: ['spans'],                        waivable: true,  settles: 'confirm' },
    { key: 'entries', fields: ['entries'],                      waivable: true,  settles: 'confirm' },
    { key: 'sizing',  fields: ['size'],                         waivable: false, settles: 'answer'  },
    { key: 'summary', fields: ['summary'],                      waivable: false, settles: 'shown'   },
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

/**
 * A build with no names in it yet. `waiver` is build-wide: the user answers it once, not per name.
 * `delegated` is the same answer given at ONE gate, mid-build — "you pick" (intent #3, Gate 2).
 */
export function emptyBuild() {
    return { names: [], active: '', waiver: false, delegated: [], turn: 0, reads: {} }
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

/** Only a gate can be handed back; the opening, sizing and the summary stay the user's (#14). */
const WAIVABLE = new Set(STAGES.filter(s => s.waivable).map(s => s.key))

/** Record that the user handed these gates to Mentor. Idempotent; anything not a gate is ignored. */
export function delegate(build, stageKeys = []) {
    const add = (Array.isArray(stageKeys) ? stageKeys : [stageKeys]).filter(k => WAIVABLE.has(k))
    return { ...build, delegated: [...new Set([...(build?.delegated ?? []), ...add])] }
}

// ─── Claiming ─────────────────────────────────────────────────────────────────

/**
 * Record an assertion. Claims are FREE — anyone may claim anything at any time, in any order,
 * because a claim commits nothing. Only settlement is ordered.
 *
 * `fields` is { direction: 'long', ... }. A claim over an already-SETTLED field is dropped rather
 * than applied: a settled value changes only through `unsettle`, which says out loud what else it
 * just invalidated. Silently overwriting it is how a user ends up with a plan they never agreed to.
 *
 * `overwrite`: true replaces any claim, false replaces none, and `'own'` replaces only a claim from
 * the SAME source. That last one is for the claims that MIRROR content — the candidate trades and the
 * ways in on the table. Mentor narrowing its own menu to a pick is Mentor's claim replacing Mentor's;
 * with no overwrite at all, the narrowed claim was dropped against the old menu and a settle then
 * agreed to every option ever offered. A user's or Argus's claim is still never displaced by one.
 */
export function claim(name, fields, source = 'mentor', { overwrite = true } = {}) {
    const src     = CLAIM_SOURCES.includes(source) ? source : 'mentor'
    const settled = name?.settled ?? {}
    const claimed = { ...(name?.claimed ?? {}) }
    const dropped = []
    for (const [field, value] of Object.entries(fields ?? {})) {
        if (!FIELD_STAGE[field]) { dropped.push(field); continue }
        if (field in settled) { dropped.push(field); continue }
        // A DERIVED claim is a default, and a default must never overwrite something someone
        // actually said. The case that proved it: the user answers "risk 1%", which is recorded as
        // {unit, value} — and the next turn the worksheet's own share count is derived back into a
        // plain number over the top of it, so the sizing intent is gone and the quantity can never
        // be re-derived when the stop moves. The worksheet's quantity is the RESULT of sizing, not
        // a statement of it.
        if (field in claimed) {
            const blocked = overwrite === 'own' ? claimed[field].source !== src : !overwrite
            if (blocked) { dropped.push(field); continue }
        }
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
 * The stage the build is at, which of its fields are still BLANK, and which are already CLAIMED.
 *
 * That last distinction is the one this module was missing, and it cost a whole turn in the first
 * live run: a stage whose fields are all claimed has already been PUT TO THE USER and is waiting on
 * their answer, but it was reported the same way as one nobody had started. The model read "still
 * blank: direction, horizon, lens", re-read the name, re-proposed the same three values and asked
 * the same question again — with the user's "yes" sitting in front of it.
 *
 * `awaiting` is true when every unsettled field already carries a claim: the work is done and the
 * next move belongs to the user, not to another read.
 */
export function firstUnsettled(name) {
    const key = stageOf(name)
    if (!key) return null
    const stage  = STAGES.find(s => s.key === key)
    const open   = stage.fields.filter(f => !isSettled(name, f))
    const blank  = open.filter(f => !claimOf(name, f))
    return { stage: key, fields: open, blank, awaiting: blank.length === 0 }
}

// ─── What has already been read ───────────────────────────────────────────────

const MAX_READS = 40

/** Tools whose answer goes stale within a turn: a level is placed against the price that IS. */
export const ALWAYS_REFETCH = ['get_quote', 'get_candles', 'get_indicators', 'get_chart']

/**
 * Record the tools this turn called, and advance the turn counter.
 *
 * "Fetch once per build" was written into the prompt and into the design doc as a PRINCIPLE, and
 * the first live run re-read the news, the fundamentals and the macro on the very next turn — the
 * prompt cannot enforce a fact it has no record of. This is that record: what was read, and when.
 * A model that is told "you read get_fundamentals on turn 1, it is now turn 3" can decline; one
 * told only "do not fetch twice" cannot know whether it already has.
 *
 * Pure.
 */
export function recordReads(build, tools = []) {
    const turn  = Number(build?.turn ?? 0) + 1
    const reads = { ...(build?.reads ?? {}) }
    for (const t of tools) {
        if (typeof t !== 'string' || ALWAYS_REFETCH.includes(t)) continue
        reads[clampStr(t, 40)] = turn
    }
    const kept = Object.entries(reads).slice(-MAX_READS)
    return { ...build, turn, reads: Object.fromEntries(kept) }
}

/**
 * Is this stage one the user handed to Mentor? Only the two gates can be, and only if they said so:
 * build-wide in the opening turn (#14), or at the gate itself (#3 — "or tells Mentor to choose").
 */
export function isWaived(build, stageKey) {
    if (!WAIVABLE.has(stageKey)) return false
    return Boolean(build?.waiver) || (build?.delegated ?? []).includes(stageKey)
}

/**
 * Does this stage settle WITHOUT anyone reporting it this turn? See `settles` on STAGES — the answer
 * has already been given, so waiting on a `settle` from the model would only re-ask a question the
 * user has answered. Every field must carry a claim; settlement order is still `canSettle`'s.
 */
export function settlesByItself(build, name, stage) {
    const claims = stage.fields.map(f => claimOf(name, f))
    if (claims.some(c => !c)) return false
    if (stage.settles === 'answer') return claims.every(c => c.source === 'user')
    if (stage.settles === 'shown')  return true
    return isWaived(build, stage.key)
}

/**
 * A user's answer recorded ahead of the stages before it — sizing given while a gate is still open.
 * It is not refused: it is HELD, and settles by itself once its turn comes. Pure.
 */
export function heldAnswers(build, name) {
    return STAGES
        .filter(s => s.settles === 'answer' && s.fields.some(f => !isSettled(name, f)))
        .filter(s => settlesByItself(build, name, s))
        .flatMap(s => s.fields)
}

/**
 * Settle, walking the stages IN ORDER. `requested` are the fields someone reported as agreed this
 * turn; a stage that settles by itself (above) joins them. Walking in stage order is what lets one
 * turn close several stages — a gate handed back, then the size the user had already given, then the
 * summary — without the order the model happened to list them in mattering.
 *
 * Only a REQUESTED field is ever reported as refused. A stage that settles by itself and cannot yet
 * is simply not its turn; and a requested answer that is held (see heldAnswers) is not refused
 * either, because telling the model "refused" is what made it ask for the size a second time.
 */
export function settleInOrder(build, name, requested = []) {
    const want     = new Set(Array.isArray(requested) ? requested : [requested])
    const accepted = []
    const refused  = []
    let current    = name

    for (const field of want) {
        if (!FIELD_STAGE[field]) refused.push({ field, reason: `unknown field: ${field}` })
    }
    for (const stage of STAGES) {
        const auto   = settlesByItself(build, current, stage)
        let fields   = stage.fields.filter(f => want.has(f) || auto)
        // AN ANSWER STAGE SETTLES ON THE USER'S ANSWER, and on nothing else. A worksheet's own share
        // count is claimed onto `size` as Mentor's; a `settle` of it would record a size nobody chose
        // — the one thing the sizing stage exists to stop.
        // Checked only where the field could otherwise settle, so an out-of-order attempt still gets
        // the ordering reason, which is the one to act on first.
        if (stage.settles === 'answer') {
            const notTheirs = fields.filter(x => {
                const c = claimOf(current, x)
                return c && c.source !== 'user' && !isSettled(current, x) && canSettle(current, x).ok
            })
            for (const f of notTheirs) {
                refused.push({ field: f, reason: `${f} is the user's answer — record their unit and number (the sizing tool), not a quantity from the worksheet` })
            }
            fields = fields.filter(x => !notTheirs.includes(x))
        }
        if (!fields.length) continue
        const r = settle(current, fields)
        current = r.name
        accepted.push(...r.accepted)
        const held = auto && stage.settles === 'answer'
        refused.push(...r.refused.filter(x => want.has(x.field) && !held))
    }
    return { name: current, accepted, refused }
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
export function claimsFromDraft(draft, { lensStated = true } = {}) {
    const out = {}
    if (draft?.direction)  out.direction = draft.direction
    if (draft?.type)       out.horizon   = draft.type
    // THE LENS IS THE ONE FIELD WITH A NON-NULL DEFAULT. `normalizeSetup` fills `trade_mode` with
    // 'discretionary' when the model emits none, so claiming it unconditionally put a lens nobody
    // proposed into the ledger — and the opening turn then settled a lens the user never heard,
    // which is precisely what claimed-vs-settled exists to prevent. Only a STATED lens is claimed.
    if (draft?.trade_mode && lensStated) out.lens = draft.trade_mode
    // NOT spans/entries. Those stages have their own emits (`<spans>` / `<entries>`) with their own
    // ids, and deriving them from SCENARIO ids claimed `s1` into a ledger whose gates speak `t1` —
    // a claim in the wrong vocabulary, recorded before either gate had run. A plan the user brought
    // skips those stages by being settled through the gates' own path, not by faking their ids.
    // Size is the TRADE's, not a scenario's (step 5), so a draft whose scenarios disagree has not
    // stated one — claiming the first scenario's would hand the user a number they never gave.
    const sizes = (draft?.scenarios ?? []).map(s => Number(s?.quantity)).filter(n => Number.isFinite(n) && n > 0)
    if (sizes.length && sizes.every(n => n === sizes[0])) out.size = sizes[0]
    return out
}

// ─── Coming back from the client ──────────────────────────────────────────────

const MAX_NAMES      = 10
const MAX_LIST       = 12
const MAX_STR        = 64
const MAX_REFUSALS   = 6
// A refusal's REASON is prose the model has to act on, not a ledger value, so it gets room. Clamped
// to the same 64 as a lens name it came back cut mid-sentence, which is worse than not saying it.
const MAX_REASON     = 240

const clampStr = (v, max = MAX_STR) => String(v).slice(0, max)

/**
 * A claim/settlement value, shrunk to something a ledger can hold: a scalar, a short list, or a
 * FLAT object of scalars.
 *
 * That last case is not a nicety. The sizing answer is `{unit, value}`, and while objects were
 * nulled here a settled size did not survive the round trip through the client: the ledger came
 * back saying the stage was settled with nothing in it, so the quantity was never re-derived and
 * the worksheet carried no size at all while the build reported itself sized. Seen in a live run,
 * at the summary stage, with the money line empty.
 *
 * Flat only, and capped: this is a ledger, not a document store.
 */
function clampValue(v) {
    if (Array.isArray(v)) return v.slice(0, MAX_LIST).map(x => (typeof x === 'string' ? clampStr(x) : x))
    if (typeof v === 'string') return clampStr(v)
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v
    if (v && typeof v === 'object') {
        const out = {}
        for (const [k, x] of Object.entries(v).slice(0, MAX_LIST)) {
            if (typeof x === 'string') out[clampStr(k, 32)] = clampStr(x)
            else if (typeof x === 'number' || typeof x === 'boolean') out[clampStr(k, 32)] = x
        }
        return Object.keys(out).length ? out : null
    }
    return null
}

/**
 * The ledger comes back through the CLIENT every turn — it rides on the draft, which is the one
 * thing that already round-trips (the frontend rebuilds `chatState` itself, so a new top-level
 * field would be dropped). Anything that has been to the client is untrusted input: this is the
 * door, and it drops what it does not recognise rather than trusting a shape.
 */
export function normalizeBuild(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyBuild()

    const names = (Array.isArray(raw.names) ? raw.names : [])
        .slice(0, MAX_NAMES)
        .map(n => {
            const name = emptyName(n?.asset)
            for (const [field, entry] of Object.entries(n?.claimed ?? {})) {
                if (!FIELD_STAGE[field] || !entry || typeof entry !== 'object') continue
                name.claimed[field] = {
                    value:  clampValue(entry.value),
                    source: CLAIM_SOURCES.includes(entry.source) ? entry.source : 'mentor',
                }
            }
            for (const [field, value] of Object.entries(n?.settled ?? {})) {
                if (!FIELD_STAGE[field]) continue
                name.settled[field] = clampValue(value)
            }
            return name
        })
        .filter(n => n.asset)

    const reads = {}
    for (const [tool, turn] of Object.entries(raw.reads ?? {}).slice(0, MAX_READS)) {
        const n = Number(turn)
        if (Number.isFinite(n) && n > 0) reads[clampStr(tool, 40)] = n
    }

    const active = String(raw.active ?? '').trim().toUpperCase()
    const turn   = Number(raw.turn)
    return {
        names,
        active: names.some(n => n.asset === active) ? active : (names[0]?.asset ?? ''),
        waiver: Boolean(raw.waiver),
        delegated: delegate(emptyBuild(), Array.isArray(raw.delegated) ? raw.delegated : []).delegated,
        // What has been read, and on which turn — the record that makes "fetch once" enforceable.
        turn:  Number.isFinite(turn) && turn > 0 ? Math.floor(turn) : 0,
        reads,
        // What the server refused LAST turn, carried forward so the next turn's context can tell the
        // model what it tried to do and why it did not happen. Cleared as soon as it is shown.
        refused: (Array.isArray(raw.refused) ? raw.refused : [])
            .slice(0, MAX_REFUSALS)
            .filter(r => r && typeof r === 'object')
            .map(r => ({ field: clampStr(r.field ?? ''), reason: clampStr(r.reason ?? '', MAX_REASON) })),
    }
}

// ─── One turn's worth of ledger moves ─────────────────────────────────────────

/**
 * Apply a turn's `<build>` ops to the ACTIVE name, in the only order that makes sense:
 * **unsettle, then claim, then settle.** A turn where the user flips the direction and confirms the
 * new one is one move, not two turns: the reopen has to land before the claim, or the claim is
 * dropped for colliding with a settled field, and the confirmation then has nothing to settle.
 *
 * Refusals are returned AND stored on the build, because the point of refusing is that the next
 * turn hears about it. A refusal nobody reads is the silent skip this whole design exists to stop.
 */
export function applyBuildOps(build, ops = {}) {
    const asset = String(ops.asset ?? build?.active ?? '').trim().toUpperCase()
    let next = asset ? upsertName(build, asset) : build
    let name = activeName(next)
    if (!name) return { build: { ...next, refused: [] }, refused: [], cleared: [], accepted: [] }

    let cleared = []
    if (ops.unsettle) {
        const r = unsettle(name, ops.unsettle)
        name = r.name
        cleared = r.cleared
        // A REOPENED GATE IS THE USER'S AGAIN. Handing a gate to Mentor answered it once; reopening
        // it is asking to see it, and a delegation left standing would settle it again unseen. The
        // build-wide waiver stays — that was an answer about the whole build, given once (#14).
        const reopened = new Set(STAGES.slice(Math.max(0, stageIndex(ops.unsettle))).map(s => s.key))
        next = { ...next, delegated: (next.delegated ?? []).filter(k => !reopened.has(k)) }
    }

    // The gate handed back BEFORE anything is claimed, because what it settles on is decided below.
    // The waiver lands here too, for the same reason: "go all the way" in the turn that also offers
    // the spans has to reach those spans in the same pass.
    if (ops.delegate) next = delegate(next, ops.delegate)
    if (ops.waiver != null) next = setWaiver(next, ops.waiver)

    // DERIVED claims come off the worksheet the model just emitted, so a turn that forgets the tag
    // still records what it proposed. They are always Mentor's own, and an explicit claim in the tag
    // wins over them — hence two passes rather than one merged object.
    //
    // The fields that MIRROR content — the gates' ids, the figures — follow the content: Mentor's
    // newer menu replaces Mentor's older one. The rest never overwrite (see `claim`): a worksheet's
    // share count is the RESULT of a sizing answer, never a restatement of it.
    if (ops.derived && typeof ops.derived === 'object') {
        const mirrored = Object.fromEntries(Object.entries(ops.derived).filter(([f]) => MIRRORED.has(f)))
        const rest     = Object.fromEntries(Object.entries(ops.derived).filter(([f]) => !MIRRORED.has(f)))
        name = claim(name, rest, 'mentor', { overwrite: false }).name
        name = claim(name, mirrored, 'mentor', { overwrite: 'own' }).name
    }

    if (ops.claim && typeof ops.claim === 'object') {
        name = claim(name, ops.claim, ops.source).name
    }

    // MENTOR'S PICK, on a gate the user handed back. It replaces the MENU claim (which is Mentor's
    // own), never a claim someone made explicitly this turn — a model that wrote its choice out in
    // the tag has already said which.
    for (const [field, value] of Object.entries(ops.picks ?? {})) {
        const stage = FIELD_STAGE[field]
        if (!stage || !isWaived(next, stage) || ops.claim?.[field] !== undefined) continue
        if (!(Array.isArray(value) && value.length)) continue
        name = claim(name, { [field]: value }, 'mentor', { overwrite: 'own' }).name
    }

    // THE SIZING ANSWER IS A CLAIM LIKE ANY OTHER, and it is ALWAYS the user's: "never choose it for
    // them" is the rule of the stage, so whoever carries it here — a press, the tag, the sizing tool
    // — is reporting their number. Recorded as anyone else's it would never settle by itself.
    if (ops.size) {
        name = claim(name, { size: ops.size }, 'user').name
    }

    const r = settleInOrder(next, name, ops.settle ?? [])
    name = r.name

    next = putName(next, name)
    return { build: { ...next, refused: r.refused }, refused: r.refused, cleared, accepted: r.accepted }
}

/** The claims that mirror content on the table, and so follow it as Mentor revises it. */
const MIRRORED = new Set(['spans', 'entries', 'summary'])

// ─── The model's ops, off the wire ────────────────────────────────────────────

/**
 * Sanitize a `<build>` block. Model output, so: a wrong type is DROPPED, never coerced — a `settle`
 * the model wrote as a sentence must not become a settlement of a field called "I think".
 */
export function sanitizeBuildOps(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const ops = {}

    if (raw.claim && typeof raw.claim === 'object' && !Array.isArray(raw.claim)) {
        const kept = Object.entries(raw.claim).filter(([f]) => BUILD_FIELDS.includes(f))
        if (kept.length) ops.claim = Object.fromEntries(kept)
    }

    const asked  = Array.isArray(raw.settle) ? raw.settle : (typeof raw.settle === 'string' ? [raw.settle] : [])
    const fields = asked.filter(f => typeof f === 'string' && BUILD_FIELDS.includes(f))
    if (fields.length) ops.settle = fields

    // The sizing answer: the unit the user thinks in and their number. The QUANTITY is the
    // server's to compute from it (positionSize.util) — a model that sizes a live account by
    // arithmetic is a model that is confidently wrong about how much is at risk.
    if (raw.size && typeof raw.size === 'object' && !Array.isArray(raw.size)) {
        const unit  = SIZE_UNITS.includes(raw.size.unit) ? raw.size.unit : null
        const value = Number(raw.size.value)
        const mult  = Number(raw.size.multiplier)
        if (unit && Number.isFinite(value) && value > 0) {
            ops.size = { unit, value }
            // The CONTRACT or point value, when the instrument has one. On an ES future a $500
            // budget against a 4-point stop is 2 contracts, not 125 — the multiplier IS the
            // position, so it travels with the size rather than being assumed to be 1.
            if (Number.isFinite(mult) && mult > 0) ops.size.multiplier = mult
        }
    }

    if (typeof raw.unsettle === 'string' && STAGE_KEYS.includes(raw.unsettle)) ops.unsettle = raw.unsettle
    if (typeof raw.waiver === 'boolean') ops.waiver = raw.waiver
    // "You pick" at a gate. Only the gates can be handed back; anything else is dropped, not coerced.
    // `picks` are deliberately NOT read off the wire: what a delegation settles on is derived by the
    // server from the content on the table (`delegationPicks`), never asserted by a client or a model.
    const handed = (Array.isArray(raw.delegate) ? raw.delegate : [raw.delegate]).filter(k => WAIVABLE.has(k))
    if (handed.length) ops.delegate = [...new Set(handed)]
    if (CLAIM_SOURCES.includes(raw.source)) ops.source = raw.source
    if (typeof raw.asset === 'string' && raw.asset.trim()) ops.asset = raw.asset

    return Object.keys(ops).length ? ops : null
}

// ─── The spans — the candidate trades, before there are entries ───────────────

const MAX_SPANS     = 4
const MAX_DISCARDED = 6
const MAX_CLAUSE    = 200

const clause = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_CLAUSE) : '')
const priceOrNull = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)

/**
 * The SPANS stage's output: the ways this name travels, before anyone has said how to get in.
 *
 * `from`/`to` are WORDS, in the lens's own vocabulary — "the 238 shelf", "the unfilled FVG", "the
 * weekly VWAP" — because a span is a claim about where price goes, and the lens decides what counts
 * as a place. The optional numeric pair is only what the chart needs to draw a line; a span with no
 * number is legitimate and simply is not drawn.
 *
 * **Four candidates, hard.** Past four the user is choosing from noise, and a cap the server keeps
 * is a cap the model cannot talk itself out of. What was DISCARDED travels too, one clause each, so
 * the user can pull one back — the rejects are half of what makes the gate a choice rather than an
 * announcement.
 */
export function normalizeSpans(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    const seen = new Set()
    const candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
        .map((c, i) => {
            if (!c || typeof c !== 'object') return null
            let id = clampStr(String(c.id ?? `t${i + 1}`).trim().toLowerCase(), 16) || `t${i + 1}`
            while (seen.has(id)) id = `${id}x`
            seen.add(id)
            return {
                id,
                label:        clampStr(c.label ?? '', MAX_STR),
                from:         clause(c.from),
                to:           clause(c.to),
                from_price:   priceOrNull(c.from_price),
                to_price:     priceOrNull(c.to_price),
                why:          clause(c.why),
                invalidation: clause(c.invalidation),
                archetype:    normalizeTaxon(ENTRY_ARCHETYPES, c.archetype),
                // The ones Mentor would build. Several may be — a span gate's answer is a SET — and
                // it is what a "you choose" settles on (delegationPicks).
                recommended:  c.recommended === true,
            }
        })
        .filter(c => c && c.label && c.from && c.to)
        .slice(0, MAX_SPANS)

    const discarded = (Array.isArray(raw.discarded) ? raw.discarded : [])
        .map(d => (d && typeof d === 'object'
            ? {
                label:   clampStr(d.label ?? '', MAX_STR),
                why_not: clause(d.why_not),
                // Optional, and carried because `alternatives[]` on the setup keys on it — the
                // rejects are authored HERE now and derived from there.
                ...(normalizeTaxon(ENTRY_ARCHETYPES, d.archetype) ? { archetype: normalizeTaxon(ENTRY_ARCHETYPES, d.archetype) } : {}),
            }
            : null))
        .filter(d => d && d.label && d.why_not)
        .slice(0, MAX_DISCARDED)

    return candidates.length ? { candidates, discarded } : null
}

/**
 * The rejects, as the SETUP records them — derived from the spans the gate discarded.
 *
 * They were being authored twice, in two sections, under the same `why_not` key: once as the
 * discarded candidates at the gate, and again as `alternatives[]` on the worksheet. The same
 * judgment written twice is the same judgment drifting twice, and it cost the model a paragraph
 * on every re-emit. The gate is where the decision is actually made, so that is where it is
 * written; this turns it into the shape the setup and the cards already read.
 *
 * `archetype` is what `alternatives[]` keys on and a discarded span may not carry one — the
 * fallback keeps the REASON, which is the whole content of a reject, rather than dropping the row
 * for want of a taxonomy word.
 *
 * Pure.
 */
export function alternativesFromSpans(spans) {
    return (spans?.discarded ?? [])
        .map(d => ({
            ...(d.archetype ? { archetype: d.archetype } : {}),
            label:   d.label,
            why_not: d.why_not,
        }))
        .filter(a => a.why_not)
}

/** The ledger value for a settled spans stage: the ids the user agreed to look at. */
export function spanIds(spans) {
    return (spans?.candidates ?? []).map(c => c.id)
}

// ─── The entries — how to get into each trade ─────────────────────────────────

const MAX_OPTIONS = 3

/** ALTERNATIVES unless the author says otherwise, and the default is the one that cannot hurt. */
export const ENTRY_SEMANTICS = ['alternatives', 'scale_in']

/**
 * The ENTRIES stage's output: per surviving trade, the ways in that were tested on THIS ticker.
 *
 * The one field that changes what the broker does is `semantics`. **Alternatives** means the first
 * trigger to fire takes the whole position and the rest are cancelled; **scale_in** means each
 * carries its share and all of them may fire. Read the wrong way round, a three-entry trade either
 * enters at a third of the intended size or at three times it — so it defaults to `alternatives`,
 * which is the reading that cannot put on more risk than the user agreed to.
 *
 * `timeframe` lives HERE and not on the setup: the rung a trigger is READ on is a property of the
 * mechanic, not of the horizon. A swing trade can wait for a 15-minute reclaim.
 */
export function normalizeEntries(raw, allowedTradeIds = null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const allow = allowedTradeIds?.length ? new Set(allowedTradeIds) : null

    const seen = new Set()
    const trades = (Array.isArray(raw.trades) ? raw.trades : [])
        .map((t) => {
            const id = clampStr(String(t?.id ?? '').trim().toLowerCase(), 16)
            // An entry for a trade the user never agreed to look at is not an entry for anything.
            if (!id || (allow && !allow.has(id))) return null

            const options = (Array.isArray(t.options) ? t.options : [])
                .map((o, i) => {
                    if (!o || typeof o !== 'object') return null
                    let oid = clampStr(String(o.id ?? `${id}e${i + 1}`).trim().toLowerCase(), 24)
                    while (seen.has(oid)) oid = `${oid}x`
                    seen.add(oid)
                    const tf = normalizeTimeframe(o.timeframe)
                    const share = Number(o.share)
                    return {
                        id: oid,
                        label:     clampStr(o.label ?? '', MAX_STR),
                        technique: clampStr(o.technique ?? '', MAX_STR),
                        trigger:   clause(o.trigger),
                        timeframe: VALID_TIMEFRAMES.has(tf) ? tf : null,
                        evidence:  clause(o.evidence),
                        share:     Number.isFinite(share) && share > 0 && share <= 100 ? share : null,
                        recommended: o.recommended === true,
                    }
                })
                .filter(o => o && o.label && o.trigger)
                .slice(0, MAX_OPTIONS)

            if (!options.length) return null
            // Mentor's own pick is what the gate expands, so there is EXACTLY one: the first it
            // marked, or the first option when it marked none. Two picks expand two rows and the
            // "which does it actually recommend" question comes straight back to the user.
            const picked = Math.max(0, options.findIndex(o => o.recommended))
            options.forEach((o, i) => { o.recommended = i === picked })

            return {
                id,
                semantics: ENTRY_SEMANTICS.includes(t.semantics) ? t.semantics : 'alternatives',
                options,
            }
        })
        .filter(Boolean)
        .slice(0, MAX_SPANS)

    return trades.length ? { trades } : null
}

/**
 * Key each emitted trade to a span ON THE TABLE, where the model's id says which one unambiguously.
 *
 * The model writes a worksheet in scenario ids (`s1`, `s2`) and the entries gate in span ids (`t1`,
 * `t2`), and it mixes them up: live, it emitted `"id": "s1"` for span `t1`, `normalizeEntries`
 * dropped the trade as belonging to no span, and the whole gate came out EMPTY — no table to press,
 * nothing for a "you decide" to settle on, a stage that could never close. That is the PACB build
 * Marce could not finish (2026-10-01; his ledger: "nothing claimed for entries").
 *
 * Only that slip is repaired — an id in the SCENARIO vocabulary (`s<n>`). Any other stranger (`t7`
 * with only `t1` on the table) may be a different trade altogether, and hanging its triggers under
 * t1's label would show the user a way into the wrong trade; it stays unresolved. Two passes:
 *   1. the same number (`s2` → `t2`), when that span is on the table and not already taken;
 *   2. exactly one `s<n>` trade still unkeyed and exactly one span still free — it can only be that.
 * Anything left is UNRESOLVED and returned by name, so the caller tells the model rather than
 * silently showing an empty gate. Pure; the input is not touched.
 */
export function resolveEntryTrades(raw, allowedTradeIds = []) {
    const allow  = (allowedTradeIds ?? []).map(String)
    const trades = Array.isArray(raw?.trades) ? raw.trades : null
    if (!trades || !allow.length) return { entries: raw, remapped: [], unresolved: [] }

    const idOf       = (t) => String(t?.id ?? '').trim().toLowerCase()
    const numOf      = (id) => id.match(/(\d+)$/)?.[1] ?? null
    const scenarioId = (id) => /^s\d+$/.test(id)
    const taken = new Set(trades.map(idOf).filter(id => allow.includes(id)))
    const to    = new Map()   // index → span id

    trades.forEach((t, i) => { if (allow.includes(idOf(t))) to.set(i, idOf(t)) })
    trades.forEach((t, i) => {
        if (to.has(i) || !scenarioId(idOf(t))) return
        const n    = numOf(idOf(t))
        const span = allow.find(a => numOf(a) === n && !taken.has(a))
        if (span) { to.set(i, span); taken.add(span) }
    })
    const loose = trades.map((_, i) => i).filter(i => !to.has(i))
    const free  = allow.filter(a => !taken.has(a))
    if (loose.length === 1 && free.length === 1 && scenarioId(idOf(trades[loose[0]]))) to.set(loose[0], free[0])

    const remapped   = []
    const unresolved = []
    const out = trades.map((t, i) => {
        if (!to.has(i)) { unresolved.push(idOf(t) || `#${i + 1}`); return t }
        if (to.get(i) !== idOf(t)) remapped.push({ from: idOf(t), to: to.get(i) })
        return { ...t, id: to.get(i) }
    })
    return { entries: { ...raw, trades: out }, remapped, unresolved }
}

/**
 * Which fields a reopen of this stage would clear — the cascade, answered WITHOUT applying it.
 *
 * The caller needs this before it can apply anything: a reopened stage drops its CONTENT too (the
 * candidate trades, the ways in), and that content is also what the claims are derived from. So
 * the question "what is being reopened" has to be answerable from the ops alone.
 */
export function fieldsClearedBy(stageKey) {
    const from = stageIndex(stageKey)
    return from < 0 ? [] : STAGES.slice(from).flatMap(s => s.fields)
}

/** Every chosen way in, as the ledger records it: `tradeId:optionId`. */
export function entryIds(entries) {
    return (entries?.trades ?? []).flatMap(t => t.options.map(o => `${t.id}:${o.id}`))
}

/**
 * WHAT "YOU PICK" SETTLES ON — Mentor's own recommendation, read off the content on the table.
 *
 * Structural, not inferred: the entries gate marks exactly ONE recommended way in per trade
 * (normalizeEntries guarantees it), and the span gate marks the trades Mentor would build. A span
 * table with nothing marked is taken whole — every candidate on it is one Mentor judged worth
 * building, since the rest went to `discarded`.
 *
 * The same rule holds whether the content was shown last turn (the user pressed "you pick" on it) or
 * emitted this turn under a waiver — one definition of "Mentor's pick", so the press path and the
 * prose path can never settle on different things.
 *
 * Pure. Absent content → no pick, and the stage simply stays open.
 */
export function delegationPicks({ spans = null, entries = null } = {}) {
    const out = {}
    const cands = spans?.candidates ?? []
    if (cands.length) {
        const marked = cands.filter(c => c.recommended)
        out.spans = (marked.length ? marked : cands).map(c => c.id)
    }
    const trades = entries?.trades ?? []
    if (trades.length) {
        out.entries = trades.flatMap(t => {
            const pick = t.options.find(o => o.recommended) ?? t.options[0]
            return pick ? [`${t.id}:${pick.id}`] : []
        })
    }
    return out
}

/**
 * What is WRONG with the entries as authored — fed back to the model, never silently corrected.
 *
 * Scaling in is the only place a shape error costs money rather than clarity: shares that do not
 * add up to the whole position mean the user is filled for something other than the size they
 * agreed to, and neither the card nor the broker would ever say so.
 */
export function entryProblems(entries) {
    const out = []
    for (const t of (entries?.trades ?? [])) {
        if (t.semantics !== 'scale_in') continue
        const shares = t.options.map(o => o.share)
        if (shares.some(s => s == null)) {
            out.push(`${t.id}: scaling in, but ${shares.filter(s => s == null).length} of ${shares.length} entries carry no share of the size`)
            continue
        }
        const total = shares.reduce((a, b) => a + b, 0)
        if (Math.abs(total - 100) > 0.01) out.push(`${t.id}: scaling in, but the shares add up to ${total}%, not 100%`)
    }
    return out
}

// ─── The user's own moves, authored by the client ─────────────────────────────

const MAX_USER_OPS = 4

/**
 * Ops the CLIENT authored, because the user pressed something.
 *
 * The difference from `sanitizeBuildOps` is provenance, and it is the whole point. A `<build>` tag
 * is the model's REPORT that the user agreed — an inference from prose, and the first live run
 * showed it is not dependable: five builds, five failures to settle the opening turn on the turn
 * the user said yes. A press is not an inference. The client knows exactly which button was hit,
 * so it says so, and the server settles without asking a model to notice anything.
 *
 * They are still validated like any other op — ordering still applies, and a press cannot settle a
 * stage whose predecessors are open.
 */
export function sanitizeUserOps(raw) {
    return (Array.isArray(raw) ? raw : [])
        .slice(0, MAX_USER_OPS)
        .map(op => sanitizeBuildOps(op))
        .filter(Boolean)
        .map(op => ({ ...op, source: 'user' }))
}

/**
 * Apply the presses, in order, before the model sees anything. Returns the build, what settled and
 * which gates were handed back.
 *
 * `picks` is Mentor's recommendation on the content the user was looking at when they pressed
 * (delegationPicks over last turn's draft). A "you pick" press settles on it right here, so the
 * model reads the gate as CLOSED and goes on to the next stage — rather than being asked to notice
 * a hand-back and remember to settle it, which is the step that kept being missed.
 */
export function applyUserOps(build, ops = [], picks = {}) {
    let next = build
    const settled   = []
    const delegated = []
    const refused   = []
    for (const op of ops) {
        const r = applyBuildOps(next, op.delegate ? { ...op, picks } : op)
        next = r.build
        settled.push(...r.accepted)
        delegated.push(...(op.delegate ?? []))
        // A refused PRESS is a bug in the client, not a model slip: it offered a button for
        // something the ledger will not accept. Returned so the caller can log it.
        refused.push(...r.refused)
    }
    return { build: next, settled, delegated, refused }
}

/**
 * What the UI needs to draw a confirm card: the stage, whether it is waiting on the user, and the
 * values that were put to them. Derived here so the client never has to know what a stage is.
 */
export function gateView(build) {
    const name = activeName(build)
    const at   = firstUnsettled(name)
    if (!name || !at) return null
    return {
        asset:    name.asset,
        stage:    at.stage,
        awaiting: at.awaiting,
        fields:   at.fields,
        values:   Object.fromEntries(at.fields.map(f => [f, claimOf(name, f)?.value ?? null])),
    }
}

// ─── The ledger owns the flow, the draft owns the content ─────────────────────

/** The three fields the ledger and the worksheet both hold, and what each of them calls it. */
const DRAFT_FIELDS = [
    { field: 'direction', key: 'direction'  },
    { field: 'horizon',   key: 'type'       },
    { field: 'lens',      key: 'trade_mode' },
]

/**
 * The draft and the ledger can disagree, because the model writes the draft while the ledger records
 * what the USER agreed to. When they do, the SETTLED value wins and the draft is put back — and the
 * override is reported, never silent. A worksheet quietly showing a direction the user never
 * confirmed is the exact failure the ledger exists to prevent.
 *
 * Returns the conflicts and mutates nothing: the caller applies them to its own normalized draft.
 */
export function settledConflicts(draft, name) {
    if (!draft || !name) return []
    return DRAFT_FIELDS
        .filter(({ field, key }) => isSettled(name, field)
            && draft[key] != null
            && draft[key] !== name.settled[field])
        .map(({ field, key }) => ({
            field,
            key,
            emitted: draft[key],
            settled: name.settled[field],
            reason: `${field} is settled as ${name.settled[field]}, but your worksheet said ${draft[key]} — restored. Unsettle the stage if the user changed their mind.`,
        }))
}
