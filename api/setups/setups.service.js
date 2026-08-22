import { randomUUID }        from 'crypto'
import { statusesFor, PAST_ENTRY, LIVE_POSITION } from '../../services/entity/vocabulary.js'
import { logger }            from '../../services/logger.service.js'
import { buildEventRisk }    from '../../services/eventRisk.service.js'
import { makeEntityCrud }    from '../../services/entity/entityCrud.service.js'
import { resolveVenue, resolveMode, isBindableVenue } from '../../services/venue.resolve.service.js'
import { normalizeSetup, setupReadiness, projectScenario } from '../../services/setup.schema.js'
import { resolveMainAccountId } from '../../services/agentUtils.js'

// Persistence for the `setup` kind — Mentor's artifact (docs/desks/mentor-talos.md).
//
// Every function here answers in the shared crud's shape — `{ ok:true, doc }` / `{ ok:false,
// reason }` — including Generate. One shape per service, so a caller never has to remember which
// function re-keyed the document under the kind's own name.
//
// A setup is built in chat as an unsaved draft and only becomes a document when the user presses
// Generate. This module owns that transition: the Generate gate, the server-stamped binding
// (mode / broker / accounts / venue / event_risk), and CRUD.
//
// It writes to the shared `entities` collection as kind:'setup', so execution (orderPlan,
// reconciler, trades ledger) picks it up unchanged — those are already kind-blind.

const LOG  = '[setups]'
const KIND = 'setup'

// Owner-scoped CRUD (the shared mechanism). A LIVE position is delete-locked — close it at the
// broker first. Everything below this line is setup JUDGMENT: the Generate gate, the server-owned
// binding, and which fields an edit may rewrite.
const crud = makeEntityCrud({ kind: KIND, deleteLock: LIVE_POSITION, log: LOG })

// Statuses this kind moves through: unarmed → waiting → watching → ready → long/short → closed.
// A setup runs the ONE shared ladder: waiting (generated, unmonitored) → looking (armed) → hit
// (fulfilled, awaiting confirm) → long/short → closed. Generate and Arm are two separate acts, so
// a setup sits at `waiting` until the user arms it — that is what `waiting` means everywhere.
//
// Price sitting INSIDE a zone is `armed_zone_id` on a `looking` setup, not a status: the zone is
// only the first gate, so a trip does not resolve within the wake, but "being in a zone" is a
// detail of looking rather than a lifecycle rung of its own.
export const SETUP_STATUSES = new Set(statusesFor(KIND))

// Past-entry: the setup is live at the broker, so a plan rewrite must not disarm it.
const POSITION_STATUSES = new Set(PAST_ENTRY)

// Plan fields rewritten by an in-place edit. Identity, monitor_state history and execution
// linkage are never in the $set.
// `scenarios` is the authored plan; `entry_zones`/`stop_zones`/`tp_zones`/`validity`/`quantity`/`rr`
// are its EXECUTION PROJECTION, re-derived by normalizeSetup and re-stamped by Talos when a premise
// arms. Both are written here so a re-draw leaves no stale projection behind.
const PLAN_FIELDS = [
    'asset', 'asset_class', 'direction', 'type', 'trade_mode', 'timeframe', 'ladder', 'cadence',
    'thesis', 'conditions', 'referenced_symbols', 'scenarios',
    'entry_zones', 'stop_zones', 'tp_zones', 'validity', 'quantity',
    'active_from', 'valid_until', 'event_risk', 'rr', 'conviction',
    'mode', 'broker', 'accounts', 'mainAccountId', 'brokerSymbol', 'basisOffset',
]

// In-position edits touch CONTEXT only — never the zones, size or venue a live position depends on.
// `validity` is context: it governs whether the PLAN is still worth watching, not what the live
// position does, so re-drawing it can't disturb an open trade.
//
// `scenarios` is here because targets and conditions now live inside it — but the ARMED scenario's
// entry, stop and size are preserved from the current document (mergeInPositionScenarios), so the
// promise above still holds literally.
const LIGHT_FIELDS = ['thesis', 'conditions', 'validity', 'referenced_symbols', 'scenarios', 'tp_zones', 'valid_until', 'rr', 'conviction', 'cadence']

export const setupService = {
    generateSetup,
    getSetup,
    listSetups,
    patchSetup,
    deleteSetup,
}

// ── Generate gate ─────────────────────────────────────────────────────────────

/**
 * Can this draft be persisted? Reuses the SAME readiness the agent and the button use, so the
 * three can't disagree, then adds the venue check (which only exists at save time, because the
 * broker is bound here rather than authored).
 *
 * Returns { ok } or { ok:false, reason } — single-reason style, matching the idea/call services.
 */
export function validateSetup(setup, broker, accounts) {
    const { missing, problems } = setupReadiness(setup, true)   // account checked separately below
    if (missing.length)  return { ok: false, reason: `missing_${missing[0].replace(/\s+/g, '_')}` }
    // Coherence, not absence: the validity range contradicts the plan it is meant to outlive. Same
    // source as the FE's readiness, so the button and this refusal cannot disagree.
    if (problems.length) return { ok: false, reason: `invalid_${problems[0].replace(/\s+/g, '_')}` }

    // Is there anything at this venue that will ever fill the trade — the app placing it, or the
    // user? Asked of the venue rather than of a list kept here: a second broker registry in this
    // file would answer for a broker it had never heard of, and it would answer no.
    if (!isBindableVenue(broker)) return { ok: false, reason: 'no_venue' }
    // Paper derives its own account (paper-<userId>); live and manual must be marked explicitly.
    if (broker !== 'paper' && !(accounts?.length)) return { ok: false, reason: 'no_venue' }

    // A zone with no width is allowed (an exact level), but lower > upper means the normaliser
    // was bypassed — refuse rather than arm a gate that can never trip. Every scenario's legs, not
    // just the projected one: a malformed rival would arm silently and trip on nonsense.
    const zones = (setup.scenarios ?? []).flatMap(sc => [...(sc.entry_zones ?? []), ...(sc.stop_zones ?? []), ...(sc.tp_zones ?? [])])
    for (const z of zones) {
        if (!Number.isFinite(z.lower) || !Number.isFinite(z.upper) || z.lower > z.upper) {
            return { ok: false, reason: 'invalid_zone' }
        }
    }
    return { ok: true }
}

// ── Generate ──────────────────────────────────────────────────────────────────

/**
 * Persist a drafted setup. Everything server-owned is stamped HERE, never taken from the model:
 * the venue binding from the marked account, the workspace mode it implies, and the frozen
 * event-risk list the monitor always checks.
 *
 * `updateId` re-routes to an in-place edit of an existing setup.
 */
async function generateSetup(rawSetup, { userId, accounts = [], mainAccountId = null, updateId = null, chatState = undefined } = {}) {
    try {
        const setup = normalizeSetup(rawSetup)
        if (!setup) return { ok: false, reason: 'invalid_setup' }

        const list = Array.isArray(accounts) ? accounts.filter(a => a && a.id != null) : []
        // The SAME MAIN-account rule the build chat tags with "← MAIN", so the venue the user was
        // shown while building is the venue the setup actually binds to.
        const mainId = resolveMainAccountId(list, mainAccountId)
        const main   = list.find(a => String(a.id) === mainId) ?? null
        const broker = main?.broker ?? null

        const gate = validateSetup(setup, broker, list)
        if (!gate.ok) return gate

        const [{ broker_symbol, basis_offset }, event_risk] = await Promise.all([
            resolveVenue(broker, userId, main?.id ?? null, setup.asset),
            // Never blocks a Generate: buildEventRisk swallows provider failures and returns [].
            buildEventRisk({ asset: setup.asset, assetClass: setup.asset_class }).catch(() => []),
        ])

        const bound = {
            ...setup,
            mode:     resolveMode({ broker, accounts: list, mainAccountId: main?.id }),
            broker,
            accounts: list.map(a => String(a.id)),
            // camelCase on purpose: the execution path reads these RAW off the doc, with no
            // adapter (ENTITY_MODEL P3b decision 3).
            mainAccountId: main?.id != null ? String(main.id) : null,
            brokerSymbol:  broker_symbol,
            basisOffset:   basis_offset,
            event_risk,
            ...(chatState !== undefined ? { chat_state: chatState } : {}),
        }

        return updateId
            ? _update(updateId, bound, userId)
            : _insert(bound, userId)
    } catch (err) {
        logger.error(LOG, 'generateSetup failed', err)
        return { ok: false, reason: 'generate_failed' }
    }
}

async function _insert(bound, userId) {
    const now = Date.now()

    const doc = {
        id:      `setup_${String(bound.asset || 'x').replace(/[^A-Za-z0-9]/g, '')}_${randomUUID().slice(0, 8)}`,
        kind:    KIND,
        userId,
        parentId: null,
        // 'waiting' = persisted but NOT monitored. Talos polls from 'looking'; arming is the
        // user's separate action. This extra state is the only place a setup's ladder differs
        // from a call's — a call is live the moment it is saved.
        status:  'waiting',
        savedAt: now,
        ...bound,
        // `scenarios` here is the monitor's per-premise invalidation ledger, NOT the authored plan
        // (that rides in `bound`). Declared at birth for the same reason the axis below is.
        // `guards` are the wake conditions Talos arms for itself (docs/desks/talos-guards.md) and
        // `last_read_at` is the clock their time term is measured against. Both are declared at
        // birth for the same reason the axis below is — so every consumer can read them without an
        // existence check. Empty means "never read"; the sweep falls back to the setup's own zones
        // until the first assessment writes a real set.
        monitor_state: {
            next_check_at: null, check_count: 0, memo: null, timeline: [], conditions: {}, scenarios: {},
            guards: [], last_read_at: null, woke_on: null, timeframe: null,
        },
        armed_zone_id:     null,
        armed_scenario_id: null,
        // The invalidation axis, declared at birth so every consumer can read it without an
        // existence check — a setup is not invalidated, it simply hasn't been yet.
        invalidation_status: null,
        invalidation_edge:   null,
        invalidation_reason: null,
    }

    const saved = await crud.insert(doc)
    logger.info(LOG, `saved setup ${doc.id} (${doc.asset} ${doc.direction} ${doc.type}, ${doc.mode})`)
    return { ok: true, doc: saved }
}

/**
 * Which resolved conditions carry across a re-draw: those whose id AND text are byte-identical.
 * Anything reworded starts unresolved, because the finding was about the old sentence.
 *
 * Returns `undefined` when there is nothing to change (no prior findings, or the conditions weren't
 * touched), so an untouched edit doesn't write a redundant key. Pure.
 */
/**
 * Every condition on a document — the setup-wide tier plus each scenario's own. The resolved-ledger
 * is ONE map keyed by id, so carrying findings across an edit has to see both tiers: reading only
 * the root would silently drop the latch on a scenario condition that never changed.
 */
export function allConditions(doc) {
    return [...(doc?.conditions ?? []), ...(doc?.scenarios ?? []).flatMap(sc => sc?.conditions ?? [])]
}

export function carryConditions(resolved, curConditions, nextConditions) {
    if (!resolved || !Object.keys(resolved).length) return undefined
    if (!Array.isArray(nextConditions)) return undefined   // conditions untouched → findings stand

    const textById = new Map((curConditions ?? []).map(c => [c.id, c.text]))
    const kept = {}
    for (const c of nextConditions) {
        if (resolved[c.id] && textById.get(c.id) === c.text) kept[c.id] = resolved[c.id]
    }
    return kept
}

/**
 * An in-position re-draw, with the live trade's own legs held back.
 *
 * The armed scenario IS the open position — its entry is filled, its stop is resting at the broker
 * and its size is the exposure. So an edit may rewrite that scenario's targets, conditions and
 * validity range, and it may rewrite a RIVAL scenario freely (nothing was placed on it), but the
 * armed one's entry, stop and quantity come back from the current document verbatim.
 *
 * Returns `undefined` when there is nothing to write, so an untouched edit adds no key. Pure.
 */
export function mergeInPositionScenarios(cur, next) {
    if (!Array.isArray(next)) return undefined
    const armedId = cur?.armed_scenario_id ?? null
    const armed   = (cur?.scenarios ?? []).find(s => s.id === armedId)
    if (!armed) return next
    return next.map(s => (s.id === armedId
        ? { ...s, entry_zones: armed.entry_zones, stop_zones: armed.stop_zones, quantity: armed.quantity }
        : s))
}

async function _update(id, bound, userId) {
    const found = await crud.getOwned(id, userId)
    if (!found.ok) return found
    const cur = found.doc

    const inPosition = POSITION_STATUSES.has(cur.status)
    const $set = {}
    for (const k of (inPosition ? LIGHT_FIELDS : PLAN_FIELDS)) {
        if (bound[k] !== undefined) $set[k] = bound[k]
    }
    if (inPosition && $set.scenarios !== undefined) {
        $set.scenarios = mergeInPositionScenarios(cur, $set.scenarios)
        // The projection follows the ARMED premise while a position is open — not the first authored
        // one, which is what a bare re-normalise would have written.
        Object.assign($set, projectScenario({ scenarios: $set.scenarios }, cur.armed_scenario_id ?? null))
    }
    if (bound.chat_state !== undefined) $set.chat_state = bound.chat_state

    // Pre-position: a rewritten plan DISARMS — the user must Arm again, because the plan Talos
    // was watching no longer exists. In-position: NEVER — flipping a live setup back would orphan
    // the reconciler's position match.
    if (!inPosition) {
        $set.status = 'waiting'
        $set.armed_zone_id = null
        $set.armed_scenario_id = null
        // THE GUARDS DIE WITH THE PLAN THAT ARMED THEM. They are levels chosen for a specific map —
        // "wake me at 311.5 because the base is building under it" — and the map just changed, so
        // keeping them would watch prices that no longer mean anything while the new plan's own
        // levels went unwatched. Emptying them is safe rather than blind: the sweep falls back to
        // the setup's zones until the next read arms a real set.
        // The stored rung goes with it — the new plan may not even be on the same ladder.
        $set['monitor_state.guards']    = []
        $set['monitor_state.woke_on']   = null
        $set['monitor_state.timeframe'] = null
        $set['monitor_state.next_check_at'] = null
        // Per-premise invalidation latches die with the plan that earned them: a re-drawn scenario
        // keeps its id, so without this a fresh premise would inherit the dead one's verdict and
        // never be watched again.
        $set['monitor_state.scenarios'] = {}
    }

    // Re-drawing is what CLEARS the invalidation latch — the same rule the call path applies
    // (kairos.handoff acceptEdit). The latch is fire-once by design, so without this a setup that
    // was invalidated (or whose map Talos read as stale) stays latched after the user fixes it and
    // can never raise a hand again. Applies in-position too: an in-position edit is the user
    // acknowledging the warning just as much as a full re-map is.
    if (cur.invalidation_status != null) {
        Object.assign($set, { invalidation_status: null, invalidation_edge: null, invalidation_reason: null })
    }

    // A resolved condition survives only while its id AND its text are unchanged. Keyed by id
    // alone, a finding would ride onto a REWORDED condition — "FDA approval landed", already
    // latched true, silently satisfying "FDA approval landed AND the stock held 240".
    // BOTH tiers: an edit that rewrites `scenarios` touches conditions even when the root tier was
    // untouched, and vice versa. `touched` is what says "the plan's conditions were re-emitted" —
    // if neither field came in, every finding stands.
    const touched = bound.conditions !== undefined || bound.scenarios !== undefined
    const kept = carryConditions(cur.monitor_state?.conditions, allConditions(cur),
        touched ? allConditions({ conditions: bound.conditions ?? cur.conditions, scenarios: $set.scenarios ?? cur.scenarios }) : undefined)
    if (kept !== undefined) $set['monitor_state.conditions'] = kept

    const res = await crud.patchOwned(id, userId, $set)
    if (!res.ok) return res
    logger.info(LOG, `updated setup ${id} (${inPosition ? 'light/in-position' : 'full re-arm'})`)
    return res
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
// Thin by design: the shared crud owns the owner guard, the sort and stripId; what stays here is
// the per-kind judgment layered on top (status vocabulary, the arm gate, terminal-closed).

// Crud shape `{ ok, doc }`, not doc-or-null. Collapsing it threw away the one distinction the
// shared crud exists to make — someone else's setup is `forbidden` (403), a missing one is
// `not_found` (404) — and the route could only ever answer 404 for both.
async function getSetup(id, userId) {
    return crud.getOwnedStripped(id, userId)
}

async function listSetups(userId, { status = null, onError } = {}) {
    return crud.list(userId, { filter: status ? { status } : {}, onError })
}

/**
 * Patch a setup. Only status transitions and monitor-owned fields go through here; a plan rewrite
 * belongs in generateSetup(updateId). Arming ('waiting' → 'looking') stamps activatedAt and clears
 * the check timer so Talos picks it up on the next tick.
 */
async function patchSetup(id, patch, userId) {
    const found = await crud.getOwned(id, userId)
    if (!found.ok) return found
    const cur = found.doc

    const $set = {}
    if (patch?.status !== undefined) {
        if (!SETUP_STATUSES.has(patch.status)) return { ok: false, reason: 'invalid_status' }
        // 'closed' is terminal — never let a stale card revert a finished setup into a live one.
        if (cur.status === 'closed' && patch.status !== 'closed') return { ok: false, reason: 'closed_is_terminal' }
        // Arming is the gate, not Generate: only from here does Talos start spending price fetches
        // and assessments on it, so re-run the full check. A setup that lost its venue (a broker
        // disconnected after Generate) would otherwise be polled forever and never be placeable.
        if (patch.status === 'looking') {
            const gate = validateSetup(cur, cur.broker, cur.accounts)
            if (!gate.ok) return { ok: false, reason: `cannot_arm_${gate.reason}` }
            $set.activatedAt = Date.now()
            $set['monitor_state.next_check_at'] = null   // check on the very next tick
            $set.armed_zone_id = null
            $set.armed_scenario_id = null
        }
        $set.status = patch.status
    }
    if (patch?.chat_state !== undefined) $set.chat_state = patch.chat_state

    if (Object.keys($set).length === 0) return { ok: false, reason: 'nothing_to_patch' }

    return crud.patchOwned(id, userId, $set)   // `{ ok, doc }` — see getSetup
}

/** Delete a setup. A live position is delete-locked (deleteLock) — close it at the broker first. */
async function deleteSetup(id, userId) {
    return crud.remove(id, userId)
}
