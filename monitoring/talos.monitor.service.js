import { getDb } from '../providers/mongodb.provider.js'
import { ENTITIES } from '../services/entity/entityCollection.js'
import { isAssetOpen, getMarketStatus } from '../services/market.service.js'
import { logger } from '../services/logger.service.js'
import { createPollLoop, fetchLastPrice } from './monitorUtils.js'
import { journalEntry, withJournal } from './monitorJournal.js'
import { withTimeout } from '../services/timeout.util.js'
import { buildOrderPlanForIdea } from '../services/orderPlan.service.js'
import { notifyManualEntry, entryLegFromIdea } from '../services/manualNotify.service.js'
import { assessSetup, READINESS_VERDICTS } from './talos.assess.js'
import { notifySetupEntryConfirm } from '../services/tradeNotify.service.js'

// Talos — the guardian of the `setup` kind (docs/setup-entity.md §5).
//
// The bronze automaton circled Crete on a fixed rotation and reacted only when something crossed
// the perimeter; that is exactly this loop. A CHEAP arithmetic gate (is price inside a zone?) runs
// every wake for free; the EXPENSIVE setup-driven assessment fires only on a zone trip or near
// expiry. Each assessment writes back a verdict, a self-chosen next_check_at clamped to the
// setup's cadence, and a running memo carried across wakes.
//
// Shares NO mutable state with Minos (legacy tree-ideas) or Hermes (calls). It polls kind:'setup'
// exclusively, so the three monitors can never contend for the same document.
//
// v1 SCOPE: pre-position readiness only. Post-confirm setups are NOT polled at all — in-position
// management (stop/tp zone trips → exit cards) needs the order layer and lands next, mirroring how
// Hermes was phased. Until then the execution reconciler owns a live position, exactly as it does
// for ideas.

const LOG        = '[talos.monitor]'
const COLLECTION = ENTITIES
const KIND       = 'setup'

const POLL_INTERVAL_MS    = 60_000
const CHECK_TIMEOUT_MS    = 90_000
const CLAIM_LEASE_MS      = CHECK_TIMEOUT_MS
const EXPIRY_THRESHOLD_MS = 15 * 60_000   // run the expiry review within 15m of valid_until
const TIMELINE_MAX        = 50

// The statuses the loop polls — the readiness ladder a setup shares with a call:
//   'waiting'  persisted but NOT monitored (Arm is the user's separate act) — never polled
//   'looking'  armed — polled. Price sitting INSIDE a zone is `armed_zone_id`, not a status:
//              being in a zone is a detail of looking, not a different lifecycle rung.
//   'hit'      fulfilled; the user is being asked to confirm — hands over to the execution path
// Everything from 'hit' onward belongs to execution, not readiness, so it leaves the loop.
const ACTIVE_STATUSES = ['looking']

const _loop = createPollLoop({ intervalMs: POLL_INTERVAL_MS, tick: _tick, eager: true, log: LOG, name: 'talos monitor' })

export const talosService = { start: _loop.start, stop: _loop.stop }

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function _tick() {
    let setups
    try {
        const db  = await getDb()
        const now = new Date().toISOString()
        // Due = active AND (never checked OR next_check_at has passed). Same-format UTC ISO
        // strings compare lexicographically, so $lte on the string is correct.
        setups = await db.collection(COLLECTION).find({
            kind:   KIND,
            status: { $in: ACTIVE_STATUSES },
            // A setup with no trading venue can be detected but never executed, so it is not worth
            // a price fetch — let alone an assessment. Mirrors Minos's broker===null skip, but as a
            // query filter so it costs nothing. `$ne: null` also matches a missing field (legacy).
            broker: { $ne: null },
            $or: [
                { 'monitor_state.next_check_at': null },
                { 'monitor_state.next_check_at': { $lte: now } },
            ],
        }).toArray()
    } catch (err) {
        logger.error(LOG, 'DB read error in tick:', err.message)
        return
    }

    if (!setups.length) return
    logger.info(LOG, `checking ${setups.length} due setup(s)`)

    for (const setup of setups) {
        // Claim before assessing. withTimeout ABANDONS but cannot CANCEL a slow check, so without
        // a lease the next tick would re-select a still-running setup and double-fire its card.
        if (!(await _claim(setup, Date.now()))) {
            logger.info(LOG, `setup ${setup.id} already claimed — skipping`)
            continue
        }
        try { await withTimeout(_checkSetup(setup, Date.now()), CHECK_TIMEOUT_MS) }
        catch (err) { logger.error(LOG, `check failed for ${setup.id}:`, err.message) }
    }
}

// Atomically claim a due setup by pushing next_check_at a lease-horizon forward, conditional on
// it STILL being due (so a fresher schedule is never clobbered). The real cadence overwrites the
// lease when the check persists.
async function _claim(setup, nowMs) {
    const db = await getDb()
    const res = await db.collection(COLLECTION).updateOne(
        {
            id: setup.id,
            status: setup.status,
            $or: [
                { 'monitor_state.next_check_at': null },
                { 'monitor_state.next_check_at': { $lte: new Date(nowMs).toISOString() } },
            ],
        },
        { $set: { 'monitor_state.next_check_at': new Date(nowMs + CLAIM_LEASE_MS).toISOString() } },
    )
    return res.modifiedCount === 1
}

// ─── One setup ────────────────────────────────────────────────────────────────

export async function _checkSetup(setup, nowMs, deps = _deps) {
    // Backstop for the query's broker filter — a setup that lost its venue between the read and
    // the check can be detected but never executed, so there is nothing worth spending on it.
    if (setup.broker == null) {
        logger.info(LOG, `[${setup.id}] no trading venue — skipping`)
        return { reason: 'no_venue' }
    }

    // Not live yet — sleep until it opens. No price fetch, no LLM. Runs before every other gate
    // because a not-yet-active setup cannot be expiring (active_from precedes valid_until).
    if (_isPreActive(setup, nowMs)) {
        const wakeAt = new Date(Date.parse(setup.active_from)).toISOString()
        await _persist(setup.id, {
            status: 'waiting',
            'monitor_state.next_check_at': wakeAt,
            'monitor_state.check_count': (setup.monitor_state?.check_count ?? 0) + 1,
        }, _entry('pre_active', { setup, nowMs, nextAt: wakeAt }))
        return { reason: 'pre_active' }
    }

    const expiring = _isExpiring(setup, nowMs)

    // Market closed → no entry can happen. Sleep until it reopens rather than burning the normal
    // cadence on a shut market. The expiry review is exempt: a setup may need to roll or die at
    // the close.
    if (!expiring && !deps.isAssetOpen(setup.asset, setup.asset_class)) {
        const patch = _reschedule(setup, nowMs, null)
        const openMs = deps.nextOpenMs(setup.asset, setup.asset_class)
        if (Number.isFinite(openMs) && openMs > nowMs) patch['monitor_state.next_check_at'] = new Date(openMs).toISOString()
        await _persist(setup.id, patch, _entry('closed', { setup, nowMs, nextAt: patch['monitor_state.next_check_at'] }))
        return { reason: 'closed' }
    }

    const price = await deps.getPrice(setup)
    const zone  = Number.isFinite(price) ? zoneGate(setup.entry_zones, price) : null

    // Nothing tripped and not expiring → the cheap path. No LLM, just a proximity-aware
    // reschedule that tightens as price approaches the nearest zone.
    if (!zone && !expiring) {
        const patch = _reschedule(setup, nowMs, price)
        await _persist(setup.id, patch, _entry('scheduled', { setup, nowMs, price, nextAt: patch['monitor_state.next_check_at'] }))
        return { reason: 'scheduled' }
    }

    const reason = expiring ? 'expiry_review' : 'zone_trip'
    const raw    = await deps.assess(setup, zone, { reason, price })

    if (!raw || raw._failReason) {
        const patch = _reschedule(setup, nowMs, price)
        await _persist(setup.id, patch, _entry(reason, { setup, nowMs, price, nextAt: patch['monitor_state.next_check_at'], failed: true, failReason: raw?._failReason }))
        return { reason, failed: true }
    }

    const verdict = READINESS_VERDICTS.has(raw.verdict) ? raw.verdict : 'wait'
    if (verdict !== raw.verdict) logger.warn(LOG, `off-menu verdict "${raw.verdict}" for ${setup.id} — treating as wait`)

    return _applyVerdict(setup, zone, { ...raw, verdict }, nowMs, reason, price, deps)
}

/**
 * Act on a verdict.
 *
 * THE ENTRY GATE IS THE SETUP, NOT THE ZONE. A zone trip is only the first of two gates: it says
 * price is WHERE the setup lives, which is what makes an assessment worth paying for. Whether the
 * setup is actually fulfilled is the second gate, and that is what `watch[]` is for — so only an
 * `enter` verdict ("this is the moment") asks the user to confirm an entry.
 *
 * Anything else means the setup has not fulfilled: the card would be asking the user to enter a
 * trade Talos just said isn't there. Those keep looking instead — Talos's own
 * tightened cadence, assessment recorded so the read is visible on the setup without a card.
 *
 * Card spam isn't a risk: firing moves the setup to 'hit', which leaves the polled statuses.
 */
async function _applyVerdict(setup, zone, raw, nowMs, reason, price, deps) {
    const assessment = {
        at:             new Date(nowMs).toISOString(),
        reason,
        zone_id:        zone?.id ?? null,
        verdict:        raw.verdict,
        read:           raw.read ?? null,
        warning:        raw.verdict === 'enter' ? null : (raw.warning ?? raw.read ?? null),
        factors:        Array.isArray(raw.factors) ? raw.factors : [],
        timeframe_used: raw.timeframe_used ?? null,
        price:          Number.isFinite(price) ? price : null,
        ...(raw.edit_proposal ? { edit_proposal: raw.edit_proposal } : {}),
    }

    const base = {
        'monitor_state.check_count':     (setup.monitor_state?.check_count ?? 0) + 1,
        'monitor_state.memo':            raw.memo_update ?? setup.monitor_state?.memo ?? null,
        'monitor_state.last_assessment': assessment,
        'monitor_state.next_check_at':   _nextCheckAt(setup, nowMs, raw.next_check_min),
    }

    // Expiry review: let_expire closes it; anything else keeps it alive on the normal cadence so
    // the user can act. Never a silent auto-close.
    if (reason === 'expiry_review' && raw.verdict === 'let_expire') {
        await _persist(setup.id, { ...base, status: 'closed', closedReason: 'expired', closedAt: nowMs },
            _entry(reason, { setup, nowMs, price, verdict: raw.verdict, read: raw.read }))
        return { reason, verdict: raw.verdict, closed: true }
    }

    // Price is in a zone but the setup did NOT fulfil — the second gate is the point of the
    // assessment, so this is the normal outcome, not an error. Stay 'looking' (still polled)
    // and let Talos's self-chosen cadence decide when to look again. No card: asking the user to
    // confirm an entry Talos just declined is the one thing this gate exists to prevent.
    if (zone && raw.verdict !== 'enter') {
        await _persist(setup.id, { ...base, status: _nextStatus(raw.verdict, reason), armed_zone_id: zone.id },
            _entry(reason, { setup, nowMs, price, zone, verdict: raw.verdict, read: raw.read }))
        return { reason, verdict: raw.verdict, watching: true }
    }

    // Fulfilled. Build the executable order plan in the SAME step that flips to 'hit': a 'hit'
    // setup with no pendingOrder would open the confirm dialog onto nothing and dead-end there
    // (the bug that shipped in the first draft).
    if (zone) {
        const patch = { ...base, status: _nextStatus(raw.verdict, reason), armed_zone_id: zone.id, entryTriggeredAt: nowMs }

        // Manual (broker-less real money): no order plan — the user places it themselves and
        // reports the fill. Its own card, not the confirm dialog.
        if (setup.broker === 'manual') {
            patch.orderState = 'awaiting_manual_fill'
            await _persist(setup.id, patch, _entry(reason, { setup, nowMs, price, zone, verdict: raw.verdict, read: raw.read }))
            try { await deps.onManualCard(setup) }
            catch (err) { logger.warn(LOG, `manual entry card failed for ${setup.id}:`, err.message) }
            return { reason, verdict: raw.verdict, fired: true, manual: true }
        }

        const plan = await deps.buildOrderPlan(setup).catch(err => {
            logger.error(LOG, `order plan failed for ${setup.id}:`, err.message)
            return []
        })
        if (plan.length > 0) {
            // Closed market → park it; the plan is already built and surfaces at the next open.
            patch.pendingOrder = { plan, builtAt: nowMs }
            patch.orderState   = deps.isAssetOpen(setup.asset, setup.asset_class) ? 'awaiting_confirm' : 'awaiting_market'
        } else {
            // No resolvable accounts: still tell the user their level printed — just nothing to place.
            logger.info(LOG, `[${setup.id}] zone tripped with no placeable accounts — alert only`)
        }

        await _persist(setup.id, patch, _entry(reason, { setup, nowMs, price, zone, verdict: raw.verdict, read: raw.read }))

        // Only an order actually awaiting confirmation gets the confirm card. 'awaiting_market'
        // defers silently until the market sweep surfaces it, matching Minos.
        if (patch.orderState !== 'awaiting_market') {
            try { await deps.onCard(setup, assessment) }
            catch (err) { logger.warn(LOG, `entry card failed for ${setup.id}:`, err.message) }
        }

        return { reason, verdict: raw.verdict, fired: true, orderState: patch.orderState ?? null }
    }

    await _persist(setup.id, base, _entry(reason, { setup, nowMs, price, verdict: raw.verdict, read: raw.read }))
    return { reason, verdict: raw.verdict }
}

// ─── Gates (pure) ─────────────────────────────────────────────────────────────

/**
 * The cheap arithmetic gate: is price inside any entry zone? Returns the FIRST zone containing it
 * (zones are armed simultaneously; whichever price reaches first acts). Inclusive on both edges so
 * a zero-width zone — an exact level the user named — can still trip.
 */
export function zoneGate(zones, price) {
    if (!Number.isFinite(price)) return null
    return (zones ?? []).find(z => price >= z.lower && price <= z.upper) ?? null
}

/** Distance from price to the nearest zone edge, as a multiple of that zone's width. */
export function zoneDistance(zones, price) {
    if (!Number.isFinite(price) || !zones?.length) return null
    return Math.min(...zones.map(z => {
        const gap   = price < z.lower ? z.lower - price : price > z.upper ? price - z.upper : 0
        const width = Math.max(z.upper - z.lower, Math.abs(z.upper) * 0.001, 1e-9)
        return gap / width
    }))
}

export function _isPreActive(setup, nowMs) {
    const from = setup?.active_from ? Date.parse(setup.active_from) : null
    return Number.isFinite(from) && from > nowMs
}

export function _isExpiring(setup, nowMs) {
    const until = setup?.valid_until ? Date.parse(setup.valid_until) : null
    return Number.isFinite(until) && (until - nowMs) <= EXPIRY_THRESHOLD_MS
}

/**
 * Proximity-aware cadence: poll at the setup's max gap when price is far from every zone, and
 * tighten toward the min gap as it approaches, so a fast run into a zone isn't missed by a lazy
 * timer. Within ~1 zone-width → the floor; beyond ~8 → the ceiling; linear in between.
 */
/**
 * Status transition from the verdict (+ why we were looking) — the Talos twin of
 * hermes._nextStatus, one tier down in the vocabulary:
 *
  *   hermes (call):  enter → 'hit' · else → 'looking'
 *   talos  (setup): enter → 'hit' · else → 'looking'
 *
 * Identical now, deliberately: a setup and a call are the same shape of thing, so they run the
 * same readiness ladder. What still differs is what `ready` CARRIES — a call's order plan is built
 * later, at confirm, by the Kairos handoff, whereas a setup's is stamped in this same write. That
 * is why a setup's card routes straight to the order dialog and a call's routes to its pop-out.
 *
 * Unlike Hermes there is no `edit`/`let_expire` branch here: a setup's expiry review is handled
 * ahead of this in _applyVerdict (let_expire closes it, anything else stays alive on cadence), so
 * by the time status is derived the only question left is whether the setup fulfilled.
 */
export function _nextStatus(verdict, reason) {
    return verdict === 'enter' ? 'hit' : 'looking'
}

export function proximityGapMin(setup, price) {
    const { min = 5, max = 30 } = setup?.cadence ?? {}
    const d = zoneDistance(setup?.entry_zones, price)
    if (d == null) return max
    if (d <= 1) return min
    if (d >= 8) return max
    return Math.round(min + ((d - 1) / 7) * (max - min))
}

/** Clamp the model's self-chosen next check into the setup's cadence band. */
export function _nextCheckAt(setup, nowMs, nextCheckMin) {
    const { min = 5, max = 30 } = setup?.cadence ?? {}
    const asked = Number(nextCheckMin)
    const gap   = Number.isFinite(asked) ? Math.min(Math.max(asked, min), max) : min
    return new Date(nowMs + gap * 60_000).toISOString()
}

function _reschedule(setup, nowMs, price) {
    const gap = proximityGapMin(setup, price)
    return {
        // No zone tripped (or market closed / assessment failed) → the setup isn't actively being
        'monitor_state.check_count':   (setup.monitor_state?.check_count ?? 0) + 1,
        'monitor_state.next_check_at': new Date(nowMs + gap * 60_000).toISOString(),
    }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

// One journal entry for a wake, through the shared builder (monitorJournal.js). This used to be a
// copy of Hermes's with the SENTENCES REMOVED — it wrote `{at, kind, price, next_at}`, which no
// reader could turn into a line of prose, so a setup's journal could only ever be rendered as JSON.
// Talos's own contribution is the model's `read`; the arithmetic wakes word themselves.
function _entry(reason, { setup, read = null, verdict = null, ...rest }) {
    return journalEntry(reason, { ...rest, entity: setup, note: read, raw: { verdict, read } })
}

async function _persist(id, $set, logEntry) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).updateOne({ id, kind: KIND }, withJournal($set, logEntry, TIMELINE_MAX))
    } catch (err) {
        logger.error(LOG, `persist failed for ${id}:`, err.message)
    }
}

// ─── Injectable IO ────────────────────────────────────────────────────────────

const _deps = {
    isAssetOpen,
    nextOpenMs: (asset, assetClass) => getMarketStatus(asset, assetClass).nextOpenMs,
    // The SAME quote-then-candles chain Hermes's gate uses. A price of null here means the gate
    // can never trip, so this must not diverge (monitorUtils.fetchLastPrice).
    getPrice:   (setup) => fetchLastPrice(setup.asset),
    assess:     assessSetup,
    // The setup doc carries the flat camelCase execution fields ideaToEnvelope reads
    // (accounts / mainAccountId / quantity / userId), so the shared plan builder works unchanged.
    buildOrderPlan: buildOrderPlanForIdea,
    // The entry card — its own copy so a non-"enter" verdict LEADS with the warning. The
    // transport (postBotCard) is the shared piece; the wording is Mentor's.
    onCard:       notifySetupEntryConfirm,
    onManualCard: (setup) => notifyManualEntry(setup.userId, { legs: [entryLegFromIdea(setup)] }),
}

export const _testDeps = _deps
