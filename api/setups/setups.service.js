import { randomUUID }        from 'crypto'
import { statusesFor, PAST_ENTRY, LIVE_POSITION } from '../../services/entity/vocabulary.js'
import { logger }            from '../../services/logger.service.js'
import { buildEventRisk }    from '../../services/eventRisk.service.js'
import { makeEntityCrud }    from '../../services/entity/entityCrud.service.js'
import { resolveVenue, resolveMode } from '../../services/venue.resolve.service.js'
import { normalizeSetup, setupReadiness } from '../../services/setup.schema.js'
import { resolveMainAccountId } from '../../services/agentUtils.js'

// Persistence for the `setup` kind — Mentor's artifact (docs/setup-entity.md).
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

const BROKERS = new Set(['ctrader', 'paper', 'manual'])

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
const PLAN_FIELDS = [
    'asset', 'asset_class', 'direction', 'type', 'trade_mode', 'timeframe', 'ladder', 'cadence',
    'thesis', 'watch', 'entry_zones', 'stop_zones', 'tp_zones', 'quantity',
    'active_from', 'valid_until', 'event_risk', 'rr', 'conviction',
    'mode', 'broker', 'accounts', 'mainAccountId', 'brokerSymbol', 'basisOffset',
]

// In-position edits touch CONTEXT only — never the zones, size or venue a live position depends on.
const LIGHT_FIELDS = ['thesis', 'watch', 'tp_zones', 'valid_until', 'rr', 'conviction', 'cadence']

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
    const { ready, missing } = setupReadiness(setup, true)   // account checked separately below
    if (!ready) return { ok: false, reason: `missing_${missing[0].replace(/\s+/g, '_')}` }

    if (!BROKERS.has(broker)) return { ok: false, reason: 'no_venue' }
    // Paper derives its own account (paper-<userId>); live and manual must be marked explicitly.
    if (broker !== 'paper' && !(accounts?.length)) return { ok: false, reason: 'no_venue' }

    // A zone with no width is allowed (an exact level), but lower > upper means the normaliser
    // was bypassed — refuse rather than arm a gate that can never trip.
    for (const z of [...setup.entry_zones, ...setup.stop_zones, ...(setup.tp_zones ?? [])]) {
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
        monitor_state: { next_check_at: null, check_count: 0, memo: null, timeline: [] },
        armed_zone_id:   null,
        pulse_anchor_px: null,
    }

    const saved = await crud.insert(doc)
    logger.info(LOG, `saved setup ${doc.id} (${doc.asset} ${doc.direction} ${doc.type}, ${doc.mode})`)
    return { ok: true, doc: saved }
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
    if (bound.chat_state !== undefined) $set.chat_state = bound.chat_state

    // Pre-position: a rewritten plan DISARMS — the user must Arm again, because the plan Talos
    // was watching no longer exists. In-position: NEVER — flipping a live setup back would orphan
    // the reconciler's position match.
    if (!inPosition) {
        $set.status = 'waiting'
        $set.armed_zone_id = null
        $set.pulse_anchor_px = null
        $set['monitor_state.next_check_at'] = null
    }

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
