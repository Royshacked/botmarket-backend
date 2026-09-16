import { ENTITIES } from '../services/entity/entityCollection.js'
import { INVALIDATION, isInvalidated, PAST_ENTRY } from '../services/entity/vocabulary.js'
import { isAssetOpen, getMarketStatus } from '../services/market.service.js'
import { logger } from '../services/logger.service.js'
import { toNum } from '../services/format.util.js'
import { fetchCandles } from './monitorUtils.js'
import { fetchLastPrice } from '../services/lastPrice.service.js'
import { createDueLoop, makePersist } from './dueLoop.js'
import { journalEntry, failNote } from './monitorJournal.js'
import {
    isPreActive, isExpiring, isPastExpiry, effectiveVerdict, nextStatus, clampGap,
    hasEditProposal,
} from './readinessGates.js'
import { buildOrderPlanForIdea } from '../services/orderPlan.service.js'
import { notifyManualEntry, entryLegFromIdea } from '../services/manualNotify.service.js'
import { assessSetup, assessPosition, READINESS_VERDICTS, MANAGEMENT_VERDICTS } from './talos.assess.js'
import { scenarioView, scenarioLabel, declaredConditions, projectScenario, pickScenario, stopEdge, targetLevels, addEntryLeg, legQuantity, pendingLegs, mayScaleIn, clampRung, clampGuards, usableLadder, rungMinutes, disarmedSetupPatch } from '../services/setup.schema.js'
import { cancelRestingEntryOrders } from '../services/restingOrders.service.js'
import { notifySetupEntryConfirm, notifySetupInvalidation, notifySetupManage, notifySetupLimitDisarm } from '../services/tradeNotify.service.js'
import { isSelfExecuted } from '../services/venue.resolve.service.js'
import { brokerService } from '../api/broker/broker.service.js'
import { zoneGate, scenarioGate, liveScenarios, _hitFromGuard, wakeReason, computeMetrics, metricsSet, positionGate, reviewDue, _minGapMs, validityBreach, breachPatch, rollUpBreaches, normalizeConditionResults, latchPatch, costPatch } from './talos.gates.js'

// Talos — the guardian of the `setup` kind (docs/desks/mentor-talos.md).
//
// The bronze automaton circled Crete on a fixed rotation and reacted only when something crossed
// the perimeter; that is exactly this loop. A CHEAP arithmetic gate (is price inside a zone?) runs
// every wake for free; the EXPENSIVE setup-driven assessment fires only on a zone trip or near
// expiry. Each assessment writes back a verdict, a self-chosen next_check_at clamped to the
// setup's cadence, and a running memo carried across wakes.
//
// It polls kind:'setup' exclusively and shares no mutable state with any other loop, so two
// monitors can never contend for the same document. That kind filter is the whole guarantee —
// status is SHARED vocabulary ('looking' is a setup's, a call's and an idea's alike), so a loop
// that selects on status without a kind wakes on work that is not its own.
//
// SCOPE. Two brains, one loop. Pre-entry it is readiness (is this the moment). Past entry it is
// management (_managePosition — does the reason for this trade still hold), on the same shape: a
// free arithmetic gate decides whether a model call is worth paying for, and the read only runs when
// it is. The position is protected either way by the stop/tp orders RESTING AT THE BROKER, built
// from the setup's zones by protectionPlan.routeSetupZones — management proposes, it never protects.
// Talos still never executes: every verdict is a card the user confirms.
//
// WHAT IS IN THIS FILE: the loop, the wake handlers, the scheduling and the writes. The free
// arithmetic itself — the zone gates, the in-position metrics, the validity gate, the condition
// ledger — is talos.gates.js, which is pure and has no idea a loop exists. See its header.

const LOG        = '[talos.monitor]'
const COLLECTION = ENTITIES
const KIND       = 'setup'

const POLL_INTERVAL_MS    = 60_000
const CHECK_TIMEOUT_MS    = 90_000
const EXPIRY_THRESHOLD_MS = 15 * 60_000   // run the expiry review within 15m of valid_until
const TIMELINE_MAX        = 50

// The statuses the loop polls — the readiness ladder a setup shares with a call:
//   'waiting'  persisted but NOT monitored (Arm is the user's separate act) — never polled
//   'looking'  armed — polled. Price sitting INSIDE a zone is `armed_zone_id`, not a status:
//              being in a zone is a detail of looking, not a different lifecycle rung.
const ACTIVE_STATUSES = ['looking']

// PAST ENTRY — 'hit' (awaiting the user's confirm / a fill) and 'long'/'short' (live at the broker).
//
// These used to be excluded, which is why a setup's journal STOPPED DEAD at the entry card: the
// moment it mattered most, the record went quiet. Hermes has always polled its past-entry statuses
// for the same reason. What Talos does with them here is deliberately small — see _checkPosition.
const POSITION_STATUSES = [...PAST_ENTRY]

// The wake-up chore lives in dueLoop.js — find what's due, claim it against a lease, check it
// under a timeout. What stays here is only what makes this Talos's loop: the kind, the statuses,
// and the venue filter.
const _loop = createDueLoop({
    collection: COLLECTION,
    kind:       KIND,
    statuses:   [...ACTIVE_STATUSES, ...POSITION_STATUSES],
    // A setup with no trading venue can be detected but never executed, so it is not worth a price
    // fetch — let alone an assessment. A query filter, so skipping it costs nothing.
    // NOTE: `$ne: null` does NOT match a missing field — Mongo treats absent as null, so a doc with
    // no `broker` key is excluded too. That is what we want (generate always stamps one), but it
    // fails SILENTLY: such a setup is never selected, never journals, and logs nothing. If a
    // `looking` setup looks inert, check `broker` first.
    filter:     { broker: { $ne: null } },
    check:      (setup, nowMs) => _checkSetup(setup, nowMs),
    intervalMs: POLL_INTERVAL_MS,
    checkTimeoutMs: CHECK_TIMEOUT_MS,
    log: LOG, name: 'talos monitor',
})

export const talosService = { start: _loop.start, stop: _loop.stop }

// ─── One setup ────────────────────────────────────────────────────────────────

export async function _checkSetup(setup, nowMs, deps = _deps) {
    // Backstop for the query's broker filter — a setup that lost its venue between the read and
    // the check can be detected but never executed, so there is nothing worth spending on it.
    if (setup.broker == null) {
        logger.info(LOG, `[${setup.id}] no trading venue — skipping`)
        return { reason: 'no_venue' }
    }

    // Past entry → the position path, never the readiness gate. A live setup has no use for a zone
    // trip: the zones already did their job.
    if (POSITION_STATUSES.includes(setup.status)) return _checkPosition(setup, nowMs, deps)

    // Not live yet — sleep until it opens. No price fetch, no LLM. Runs before every other gate
    // because a not-yet-active setup cannot be expiring (active_from precedes valid_until).
    //
    // ONLY the schedule is written. This used to also set `status:'waiting'`, which ORPHANED the
    // setup permanently: 'waiting' is not in ACTIVE_STATUSES, so the wake-up time it had just
    // stamped was on a document the poll query could never select again. One "not live yet" line,
    // then silence forever. Hermes's twin branch (_checkCall) writes the schedule and leaves the
    // status alone for exactly this reason — being pre-active is a fact about the CLOCK, not a
    // lifecycle rung, and the UI derives it from `active_from` rather than from a status.
    if (_isPreActive(setup, nowMs)) {
        const wakeAt = new Date(Date.parse(setup.active_from)).toISOString()
        await deps.persist(setup.id, {
            'monitor_state.next_check_at': wakeAt,
            'monitor_state.check_count': (setup.monitor_state?.check_count ?? 0) + 1,
        }, _entry('pre_active', { setup, nowMs, nextAt: wakeAt }))
        return { reason: 'pre_active' }
    }

    // Pure price-touch — no conditions to assess. The confirm card fires on the first open-market
    // wake; Talos's value is in judging conditions, and when there are none the limit order IS the plan.
    // Past-expiry setups fall through: the normal path runs an expiry_review so the model decides,
    // rather than auto-firing an enter on a setup whose window may have closed.
    if (setup.entry_mode === 'limit' && !_isPastExpiry(setup, nowMs)) {
        const sc   = liveScenarios(setup)[0] ?? null
        const zone = sc?.entry_zones?.[0] ?? null
        if (sc && !zone) logger.warn(LOG, `[${setup.id}] limit setup has scenario but no entry_zones — falling through to normal path`)
        if (sc && zone) {
            if (!deps.isAssetOpen(setup.asset, setup.asset_class)) {
                const patch  = _reschedule(setup, nowMs)
                const openMs = deps.nextOpenMs(setup.asset, setup.asset_class)
                if (Number.isFinite(openMs) && openMs > nowMs) patch['monitor_state.next_check_at'] = new Date(openMs).toISOString()
                await deps.persist(setup.id, patch, _entry('market_closed', { setup, nowMs, nextAt: patch['monitor_state.next_check_at'] }))
                return { reason: 'market_closed' }
            }
            // If validity is set, verify the premise hasn't been breached before firing.
            if (liveScenarios(setup).some(s => s.validity)) {
                const price    = await deps.getPrice(setup)
                const breached = await _checkValidity(setup, price, nowMs, deps)
                if (breached) return breached
            }
            return _applyVerdict(setup, { scenario: sc, zone },
                { verdict: 'enter', read: 'Limit order — no conditions to assess.', guards: [], conditions: [], next_timeframe: null, memo_update: null },
                nowMs, 'limit_order', null, deps)
        }
    }

    const expiring = _isExpiring(setup, nowMs)

    // Market closed → no entry can happen. Sleep until it reopens rather than burning the normal
    // cadence on a shut market. The expiry review is exempt: a setup may need to roll or die at
    // the close.
    if (!expiring && !deps.isAssetOpen(setup.asset, setup.asset_class)) {
        const patch = _reschedule(setup, nowMs)
        const openMs = deps.nextOpenMs(setup.asset, setup.asset_class)
        if (Number.isFinite(openMs) && openMs > nowMs) patch['monitor_state.next_check_at'] = new Date(openMs).toISOString()
        await deps.persist(setup.id, patch, _entry('market_closed', { setup, nowMs, nextAt: patch['monitor_state.next_check_at'] }))
        return { reason: 'market_closed' }
    }

    const price = await deps.getPrice(setup)
    // WHY THIS WAKE HAPPENED, as recorded by the sweep that caused it (guardSweep.service.js).
    // One-shot: cleared by every write below, so it describes this wake and no later one.
    const woke  = setup.monitor_state?.woke_on ?? null
    // Which PREMISE price reached, not merely which zone: the scenario decides what gets judged,
    // what size is taken and which stop rests behind it.
    //
    // TWO WAYS TO ARRIVE, and the second is why guards work at all. `scenarioGate` asks where price
    // is RIGHT NOW; the sweep already established where it has BEEN, up to a minute earlier. A
    // level touched and left in that minute would make the spot check say "nothing here" and throw
    // away the very crossing that paid for the wake. So a fired price guard resolves to its own
    // zone, whatever price is doing by the time we look.
    const hit   = scenarioGate(setup, price) ?? _hitFromGuard(setup, woke)
    const zone  = hit?.zone ?? null

    // TWO REASONS TO RUN AN ASSESSMENT WITHOUT A ZONE HIT.
    //
    // 1. NEVER READ. A setup's first wake has no guards yet — the model hasn't had a chance to arm
    //    any. Running the assessment lets it read the chart and arm its own guards. Without this, a
    //    setup with no entry zones (entry triggered by a pattern, not a level) is never assessed
    //    and never receives guards, so it monitors nothing.
    //
    // 2. PRICE GUARD FIRED. The model set a guard at a level that is NOT an entry zone — an
    //    invalidation line, a momentum level, a structure point it wanted to re-check. The sweep
    //    fired it, which is the model's explicit request to be woken here. Ignoring it because the
    //    level isn't inside a zone defeats the purpose of guards entirely.
    //
    // In both cases there is no entry card (no zone = no position), but the assessment still runs
    // and the journal records it. The backstop (unconditional heartbeat, no price term) is NOT a
    // reason — it is a fallback "come back eventually", and running a full assessment on every
    // heartbeat when nothing is happening would drain budget on silence.
    // Validity is a hard safety check — always run it first, regardless of whether an assessment
    // follows. A breached premise that would normally skip assessment must still fire its card.
    const breached = await _checkValidity(setup, price, nowMs, deps)
    if (breached) return breached

    const neverRead        = !setup.monitor_state?.last_read_at
    const guardFiredPrice  = woke != null && Number.isFinite(toNum(woke?.price))
    const needsAssessment  = zone || expiring || neverRead || guardFiredPrice

    if (!needsAssessment) {
        const patch = _reschedule(setup, nowMs)
        const quiet = wakeReason(woke)
        await deps.persist(setup.id, patch, _entry(quiet, { setup, nowMs, price, woke, nextAt: patch['monitor_state.next_check_at'] }))
        return { reason: quiet }
    }

    const reason = expiring ? 'expiry_review' : wakeReason(woke)
    const raw    = await deps.assess(setup, hit, { reason, price })

    if (!raw || raw._failReason) {
        const patch = _reschedule(setup, nowMs)
        await deps.persist(setup.id, patch, _entry(reason, { setup, nowMs, price, nextAt: patch['monitor_state.next_check_at'], failed: true, failReason: raw?._failReason }))
        return { reason, failed: true }
    }

    const onMenu = READINESS_VERDICTS.has(raw.verdict) ? raw.verdict : 'wait'
    if (onMenu !== raw.verdict) logger.warn(LOG, `off-menu verdict "${raw.verdict}" for ${setup.id} — treating as wait`)

    const verdict = _effectiveVerdict(onMenu, reason, _isPastExpiry(setup, nowMs))
    if (verdict !== onMenu) logger.info(LOG, `[${setup.id}] verdict "${onMenu}" → "${verdict}" (${reason}${_isPastExpiry(setup, nowMs) ? ', past expiry' : ''})`)

    return _applyVerdict(setup, hit, { ...raw, verdict }, nowMs, reason, price, deps)
}

/**
 * Cancel the pending broker order and return the setup to 'waiting'.
 *
 * A limit order exists only while its setup is armed. When expiry, a validity breach or a manual
 * request fires, the order is canceled at the broker and the setup goes dormant — the user's
 * explicit re-arm is the gate back in. Only `orderState: 'placed'` has a live broker order to
 * cancel; earlier states (awaiting_confirm, awaiting_market) have no order at the broker yet.
 */
async function _disarmLimit(setup, disarmReason, nowMs, deps) {
    // WHEN there is an order at the broker is this caller's judgment; the cancel itself is the
    // shared one (restingOrders.service), and the field reset is the shared one
    // (setup.schema.disarmedSetupPatch) — three disarm paths used to carry their own copy of that
    // eight-field literal, which is how one of them came to leave `armed_scenario_id` behind.
    if (setup.orderState === 'placed') {
        await cancelRestingEntryOrders(setup, setup.userId, { log: LOG, cancelOrder: deps.cancelOrder })
    }
    const patch = {
        ...disarmedSetupPatch(),
        'monitor_state.check_count': (setup.monitor_state?.check_count ?? 0) + 1,
    }
    await deps.persist(setup.id, patch, _entry('limit_disarmed', { setup, nowMs, read: disarmReason }))
    try { await deps.onDisarmCard(setup, disarmReason) }
    catch (err) { logger.warn(LOG, `[${setup.id}] disarm card failed: ${err.message}`) }
    return { reason: 'limit_disarmed', disarmReason }
}

/**
 * A setup that is past entry.
 *
 * DELIBERATELY SMALL. The exits now rest at the broker (protectionPlan.routeSetupZones → placeExits),
 * so the position is PROTECTED without anyone watching it — which is exactly why this doesn't need
 * to be a management brain to be worth running. What it does is close the hole that started all of
 * this: the journal used to stop dead at the entry card, so the record went silent at the moment it
 * mattered most.
 *
 *   'hit'         awaiting the user's confirm, or a fill. Nothing to say that the card didn't
 *                 already say — reschedule quietly rather than writing "still waiting" every wake.
 *   long/short    the first wake after the fill writes the fill line and stamps position_state, so
 *                 the timeline reads through the entry. After that it parks on the lazy cadence.
 *
 * The CLOSE line is not written here either, and cannot be: the reconciler flips a closed setup to
 * 'closed', which drops it out of the polled statuses before this ever sees it. It rides the same
 * guarded write as the status flip instead (entityRepo.finalizeClose).
 */
async function _checkPosition(setup, nowMs, deps) {
    const ps     = setup.position_state ?? {}
    const inPos  = setup.status === 'long' || setup.status === 'short'
    // Park on the lazy end of the cadence: nothing here is time-critical, and the broker is holding
    // the protective orders.
    const gap    = Number(setup.cadence?.max) || 30
    const nextAt = new Date(nowMs + gap * 60_000).toISOString()
    const base   = {
        'monitor_state.next_check_at': nextAt,
        'monitor_state.check_count':   (setup.monitor_state?.check_count ?? 0) + 1,
    }

    // Awaiting confirm/fill → check disarm triggers for limit orders, then keep the schedule moving.
    if (!inPos) {
        // A limit order lives only while the setup is armed. Expiry or a validity breach cancel it
        // at the broker and return the setup to 'waiting' for re-arming.
        //
        // A MANUAL disarm is NOT one of these. It used to be read off a `disarm_requested` flag that
        // nothing in the app ever wrote — the user's own path is synchronous and immediate
        // (talos.handoff.disarmSetup, and the plain status patch), which is what somebody asking to
        // pull their order actually wants. A flag would have added a second mechanism whose only
        // difference was a poll's delay.
        if (setup.entry_mode === 'limit') {
            if (_isPastExpiry(setup, nowMs)) return _disarmLimit(setup, 'expired', nowMs, deps)
            if (liveScenarios(setup).some(s => s.validity)) {
                const price    = await deps.getPrice(setup)
                const breached = await _checkValidity(setup, price, nowMs, deps)
                if (breached)               return _disarmLimit(setup, 'validity_breach', nowMs, deps)
            }
        }
        // No journal entry: an idle wake that writes a line turns the monologue into noise, and the
        // entry card already said everything there is.
        await deps.persist(setup.id, base, null)
        return { reason: 'awaiting_fill' }
    }

    // Already stamped → the management path. This used to return here, which is what made the
    // journal go quiet for the whole life of a position.
    if (ps.entry?.fill_at != null) {
        // NO MONITORING OFF-HOURS, IN OR OUT OF POSITION. The pre-entry path has slept through a
        // shut market since day one; this one did not, because past-entry statuses are routed here
        // BEFORE that gate. The consequence was not merely wasted wakes:
        //
        //   • `fetchLastPrice` answers 200 with the last CLOSE at 2am, so the arithmetic gate reads
        //     a frozen price as live. A position that closed pressing its stop is `adverse` on every
        //     wake until the open — a full LLM read every `cadence.min`, all night, each one
        //     re-reading the identical number.
        //   • worse, it can post an `exit_now` card at 3am about a trade nobody can exit, on a price
        //     that has not been real for hours.
        //
        // The position is not unwatched while we sleep: the stop and the targets are RESTING AT THE
        // BROKER, which is what protects a position nobody is looking at. Waking at the open is when
        // there is genuinely something new to read.
        //
        // No journal line. Pre-entry writes one, and can afford to — but a swing held three weeks
        // would collect one "market closed" line per night, and the in-position journal is about the
        // TRADE. The market shutting on schedule is not news about the trade.
        if (!deps.isAssetOpen(setup.asset, setup.asset_class)) {
            const openMs = deps.nextOpenMs(setup.asset, setup.asset_class)
            const wakeAt = (Number.isFinite(openMs) && openMs > nowMs) ? new Date(openMs).toISOString() : nextAt
            await deps.persist(setup.id, { ...base, 'monitor_state.next_check_at': wakeAt }, null)
            return { reason: 'market_closed' }
        }
        return _managePosition(setup, ps, nowMs, deps)
    }

    // First wake after the fill. `entryTriggeredAt` is when the zone tripped; the broker's own fill
    // price isn't on the setup, so the intended entry stands in until the ledger has it.
    //
    // DELIBERATELY AHEAD OF THE OFF-HOURS GATE ABOVE. This is bookkeeping, not monitoring: it fetches
    // no price, calls no model and posts no card — it writes down a fill that has already happened.
    // A setup filled minutes before the close would otherwise have no `position_state` until the next
    // open, which means no frozen `stop.initial` and a journal that skips its own entry line.
    const fillPrice = toNum(ps.entry?.intended) ?? toNum(setup.armed_zone_id ? _zoneById(setup, setup.armed_zone_id)?.upper : null)
    const fillAtMs  = setup.ordersPlacedAt ?? setup.entryTriggeredAt ?? nowMs
    // The WORKING stop, chosen by price rather than by array position (setup.schema stopEdge). The
    // old read here took `stop_zones[0].lower ?? .upper`, which picks the wrong edge on a short and
    // the wrong zone whenever the model emitted them out of order.
    const stop = stopEdge(setup)

    // Recorded as a LEG rather than as a single fact. A position built by scaling in has several
    // fills at different prices, and `fill_price` must be their size-weighted average because every
    // R in the system is measured from it. One leg is the average of one, so this is a no-op until
    // per-leg execution lands — which is exactly why it lands first.
    const entry = addEntryLeg(ps.entry, {
        zone_id:  setup.armed_zone_id ?? null,
        price:    fillPrice,
        // The LEG's size, matching what execution actually placed. `setup.quantity` is the armed
        // premise's total and stands in only for a zone that carries no size of its own.
        quantity: toNum(_zoneById(setup, setup.armed_zone_id)?.quantity) ?? setup.quantity ?? null,
        at:       new Date(fillAtMs).toISOString(),
    })

    const patch = {
        ...base,
        'position_state.entry.legs':       entry.legs,
        'position_state.entry.fill_price': entry.fill_price,
        'position_state.entry.fill_at':    new Date(fillAtMs).toISOString(),
        'position_state.entry.size':       entry.size,
        'position_state.entry.direction':  setup.direction ?? (setup.status === 'short' ? 'short' : 'long'),
        'position_state.phase':            'running',
        // FROZEN AT FILL, and deliberately not read live off the scenario afterwards. What protects
        // the position is the order resting at the broker, not whatever the plan says later — an
        // edited scenario must not silently move the level the gate measures against. `current`
        // starts equal to `initial` and is what a `move_stop` verdict advances; `initial` stays put
        // because every R multiple is measured from the risk originally taken.
        'position_state.stop.initial':     stop,
        'position_state.stop.current':     stop,
        // Nearest-first — the order price reaches them, which is the order partials fire in.
        //
        // `resting` is the target the user named. `price` is where the gate wakes Talos to TALK
        // about it, and it exists only when there is something to talk about:
        //
        //   no conditions  → `price: null`. A plain limit rests at the broker and wakes nothing.
        //                    An unconditional target is just an order.
        //   conditions     → `price: target`. Nothing rests (routeSetupZones holds a conditional
        //                    target back, or the limit would fill and make the condition dead
        //                    letter), so the gate has to wake the model AT the level to judge it.
        //
        // Waking exactly at the target is the interim: under docs/desks/talos-guards.md the model
        // arms its own guard and can ask to be woken beneath it. The gate already skips a non-finite
        // `price`.
        //
        // KNOWN, ACCEPTED REGRESSION UNTIL GUARDS LAND. A LEGACY banded target used to wake the
        // `scale_out` gate at its near edge, so Talos could offer "bank half here?" on the way up.
        // Bands carry no conditions, so those positions now get `price: null` and no offer. The
        // money outcome is unchanged — the limit still rests at the same level it always did, which
        // is the guarantee that mattered — and what is lost is an optional conversation that guards
        // restore, at a level the model chooses rather than one Mentor happened to draw.
        'position_state.targets':          targetLevels(setup).map(t => ({
            price:   t.conditions.length ? t.target : null,
            resting: t.target,
            hit_at:  null,
        })),
    }
    const note = `In on ${setup.asset}${fillPrice != null ? ` around ${fillPrice}` : ''}${stop != null ? `, stop resting at ${stop}` : ''}. The broker is holding the exits from here.`
    await deps.persist(setup.id, patch, { at: new Date(nowMs).toISOString(), reason: 'entry', price: fillPrice, verdict: null, note, next_check_at: nextAt })

    logger.info(LOG, `[${setup.id}] position opened (${setup.status}) — journal continues`)
    return { reason: 'entry', promoted: true }
}

// ─── In-position management ────────────────────────────────────────────────────
//
// Verdict urgency. A pending card is NOT re-fired by a same-or-lower verdict — the user already has
// that decision in front of them, and re-posting it every wake is how a monitor teaches people to
// ignore it. A MORE urgent verdict does fire over it: a broken thesis has to be able to interrupt a
// pending "bank a third".
// add_leg sits below every protective verdict on purpose: adding size must never out-rank a
// pending decision about protecting what is already on.
const VERDICT_SEVERITY = { hold: 0, let_run: 1, add_leg: 2, take_partial: 3, move_stop: 4, exit_now: 5 }

/**
 * One in-position wake: metrics (always) → cheap gate → assess only if it tripped or a review is
 * due → persist, and post a card when the verdict wants the user to do something.
 *
 * The shape is Hermes's, deliberately (see the duplication note above positionGate). What differs
 * is the read itself: this one re-checks the setup's DECLARED conditions, where Hermes grades four
 * fixed axes.
 */
async function _managePosition(setup, psIn, nowMs, deps) {
    const price = await deps.getPrice(setup)

    // Re-arm before anything reads the ladder. A target price has walked back out of is a target we
    // may need to ask about again — see rearmTargets for why that is now true and did not use to be.
    const rearmed = rearmTargets(setup, psIn, price)
    const ps      = rearmed ? { ...psIn, targets: rearmed } : psIn

    const metrics = computeMetrics(ps, price, nowMs)
    const gate    = positionGate(ps, price)

    // A planned SECOND LEG printing is its own reason to look, independent of the management gate:
    // the position is fine, and the plan says there is more to add here. Pending legs are keyed on
    // zone id rather than counted, because legs fill in whatever order price reaches them.
    //
    // NEVER while the gate says `adverse`. Adding to a position already pressing its stop is the
    // averaging-down reflex with a scheduler attached — it turns one planned loss into a larger
    // unplanned one. The plan said "add at this level", not "add while the thesis is failing".
    // `scale_out` and `breakeven` do not block it: those are a position doing well, which is when a
    // planned leg is legitimate.
    const armed     = (setup.scenarios ?? []).find(sc => sc?.id === setup.armed_scenario_id) ?? null
    const openLegs  = pendingLegs(armed, ps.entry)
    const scaleZone = (openLegs.length && mayScaleIn(gate.flag)) ? zoneGate(openLegs, price) : null

    const assessNow = !!gate.flag || !!scaleZone || reviewDue(ps, nowMs, setup.cadence)

    const bump = (nextAt) => ({
        ...metricsSet(metrics),
        // Rides EVERY exit, the free hold included: price leaving a window is exactly the wake that
        // has nothing else to say, so folding it into the expensive paths alone would never fire.
        ...(rearmed ? { 'position_state.targets': rearmed } : {}),
        'monitor_state.next_check_at': nextAt,
        'monitor_state.check_count':   (setup.monitor_state?.check_count ?? 0) + 1,
    })

    // The cheap hold — the overwhelmingly common wake. Metrics stay fresh so the eventual read has
    // history to reason about, but nothing is spent and nothing is written to the journal.
    if (!assessNow) {
        await deps.persist(setup.id, bump(new Date(nowMs + _minGapMs(setup.cadence)).toISOString()), null)
        return { reason: 'in_position_idle' }
    }

    const reason = gate.flag ?? (scaleZone ? 'scale_in' : 'review')
    const raw    = await deps.assessPosition(setup, ps, { price, reason, gate, metrics, scaleZone })

    if (!raw || raw._failReason) {
        const nextAt = new Date(nowMs + _minGapMs(setup.cadence)).toISOString()
        await deps.persist(setup.id, bump(nextAt), {
            at: new Date(nowMs).toISOString(), reason: 'in_position', price: toNum(price), verdict: null,
            note: failNote('reassess', setup.asset, raw?._failReason), next_check_at: nextAt,
        })
        return { reason, failed: true }
    }

    let verdict = MANAGEMENT_VERDICTS.has(raw.verdict) ? raw.verdict : 'hold'
    if (verdict !== raw.verdict) logger.warn(LOG, `off-menu management verdict "${raw.verdict}" for ${setup.id} — treating as hold`)
    // `add_leg` is only meaningful with a planned zone actually printing. A model that returns it
    // on a quiet wake is proposing size the plan never authorised, so it is refused here rather
    // than trusted — the prompt says the same thing, and this is the half that cannot be talked out
    // of it.
    if (verdict === 'add_leg' && !scaleZone) {
        logger.warn(LOG, `add_leg with no planned zone printing for ${setup.id} — treating as hold`)
        verdict = 'hold'
    }

    // Self-chosen cadence, clamped to the setup's own bounds: a model that asks to be woken in one
    // minute on a swing burns the budget, and one that asks for three days goes blind. The pace now
    // rides on the RUNG the read asked to open on next — see _nextCheckAt.
    const nextAt  = _nextCheckAt(setup, nowMs, raw.next_timeframe)
    const pending = ps?.pending_action ?? null
    const fires   = verdict !== 'hold'
        && (VERDICT_SEVERITY[verdict] ?? 0) > (pending ? (VERDICT_SEVERITY[pending.verdict] ?? 0) : -1)

    const nextRung = clampRung(raw.next_timeframe, usableLadder(setup))
    const set = {
        ...bump(nextAt),
        // Same rung memory the readiness read keeps — a position being watched on the 5-minute
        // because its stop is being pressed should not silently reopen on the ladder's default.
        ...(nextRung ? { 'monitor_state.timeframe': nextRung } : {}),
        // The wake conditions this read armed (docs/desks/talos-guards.md). Written WHOLE on every
        // read, never merged: a guard set is a snapshot of one judgment about where price would have
        // to go to change the answer, and half of yesterday's judgment beside half of today's is a
        // set neither read would have written. What the model does not re-arm is forgotten, and the
        // prompt says so in those words.
        'monitor_state.guards': clampGuards(raw.guards, setup, price),
        // Stamped WITH the guards, because it is the clock their time term is measured
        // against: `after_min` means 'this long since a MODEL last looked at me', not since
        // the sweep last ran. Two clocks, and conflating them would let a fast sweep cadence
        // quietly reset the model's own patience. Only a real read writes it.
        'monitor_state.last_read_at': new Date(nowMs).toISOString(),
        'monitor_state.woke_on':      null,
        'position_state.last_management': { at: new Date(nowMs).toISOString(), verdict },
        ...(raw.memo_update ? { 'monitor_state.memo': String(raw.memo_update) } : {}),
        ...(fires ? { 'position_state.pending_action': { verdict, proposal: raw.proposal ?? null, at: new Date(nowMs).toISOString(), read: raw.read ?? null } } : {}),
        // A target that earned this wake is stamped so it cannot re-trip forever — the ladder moves
        // on whether or not the user takes the partial, because the ARITHMETIC fact (price reached
        // it) does not become untrue if they decline.
        ...(gate.flag === 'scale_out' && gate.target ? { 'position_state.targets': _markTargetHit(ps, gate.target, nowMs) } : {}),
    }

    // The execution half of a scale-in. Deliberately NOT routed back through the entry flow: that
    // path drives `_nextStatus`, `armed_zone_id` and `orderState` on the assumption nothing is open
    // yet, and re-running it on a live position would flip a status that is already correct. What is
    // actually needed is narrower — an order plan for ONE leg, at that leg's size.
    //
    // `status` is untouched. The position is already long/short and adding to it does not change
    // what it is. `armed_zone_id` moves to the new leg so the fill stamps against the right zone.
    if (verdict === 'add_leg' && scaleZone) {
        const projection = projectScenario(setup, setup.armed_scenario_id ?? null)
        const executable = { ...setup, ...projection, quantity: legQuantity(armed, scaleZone.id) ?? null }
        if (Number.isFinite(executable.quantity) && executable.quantity > 0) {
            const plan = await deps.buildOrderPlan(executable).catch(err => {
                logger.error(LOG, `scale-in order plan failed for ${setup.id}:`, err.message)
                return []
            })
            if (plan.length > 0) {
                set.armed_zone_id = scaleZone.id
                set.pendingOrder  = { plan, builtAt: nowMs }
                // A shut venue parks it rather than dropping it — same rule the first leg follows.
                set.orderState    = deps.isAssetOpen(setup.asset, setup.asset_class) ? 'awaiting_confirm' : 'awaiting_market'
            } else {
                logger.info(LOG, `[${setup.id}] planned leg printed with no placeable accounts — alert only`)
            }
        } else {
            logger.warn(LOG, `[${setup.id}] planned leg ${scaleZone.id} carries no size — nothing to place`)
        }
    }

    const note = (raw.read && String(raw.read).trim()) ? String(raw.read).trim() : _manageFallbackNote(verdict)
    await deps.persist(setup.id, set, {
        at: new Date(nowMs).toISOString(), reason: 'in_position', price: toNum(price), verdict,
        note, next_check_at: nextAt,
    })

    if (fires) await deps.onManageCard(setup, { verdict, proposal: raw.proposal ?? null, read: raw.read ?? null }).catch(() => {})

    logger.info(LOG, `[${setup.id}] ${reason} → ${verdict}${fires ? ' (card)' : ''}`)
    return { reason, verdict, card: fires }
}

/**
 * Stamp the tripped target as asked, leaving the rest of the ladder alone. Pure.
 *
 * `hit_at` USED TO MEAN "the limit filled", because the resting limit sat on the same edge that
 * tripped this gate. Under the TP window it means "we have already asked about this one on this
 * visit" — the limit is further out, at `resting`. What un-asks it is rearmTargets.
 */
function _markTargetHit(ps, target, nowMs) {
    return (ps?.targets ?? []).map(t =>
        (t.price === target.price && t.hit_at == null) ? { ...t, hit_at: new Date(nowMs).toISOString() } : t)
}

/** Two order prices are the same level. Prices round-trip through Mongo as doubles. Pure. */
function _sameLevel(a, b) {
    const x = Number(a), y = Number(b)
    return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= Math.max(Math.abs(y), 1) * 1e-9
}

/**
 * Is the limit for this rung STILL RESTING at the broker? Pure.
 *
 * The question separates the two ways a target stops being pending, which look identical from the
 * ladder alone: price reached the window and we asked (the order is still out there), or price ran
 * on to the TP and the limit FILLED. Re-arming the second kind would have Talos propose banking
 * against an exit that already happened — only possible on a staged ladder, where leg 1 can fill
 * while the position lives on.
 *
 * No tp orders at ALL means nothing rests: the ladder is Talos's alone (an alert-only setup, or no
 * placeable account), so every rung re-arms. That is the opposite of the empty-array default, and
 * getting it backwards would silently disarm exactly the setups with no broker safety net.
 */
function _tpStillResting(setup, level) {
    const tps = (setup?.exitOrders ?? []).filter(o => o?.leg === 'tp')
    if (!tps.length) return true
    return tps.some(o => o?.status === 'working' && _sameLevel(o.price, level))
}

/**
 * Un-ask the targets price has walked back out of. Returns the new ladder, or null when nothing
 * changed — so a wake that re-arms nothing writes nothing. Pure apart from reading the setup.
 *
 * THE TRAP THIS CLOSES. `hit_at` exists to stop a target re-tripping on every wake, and stamping it
 * forever was right while the limit rested on the trip level: reaching it meant the money was taken.
 * With the limit moved out to `resting`, reaching the wake level means only that Talos ASKED. A
 * target touched once, declined (or simply never answered), and then abandoned by price would stay
 * disarmed for the life of the trade — one wick, and the rest of the plan's upside is silently
 * unwatched. So a rung re-arms when price leaves its window, and only while its limit is still out
 * there unfilled.
 */
export function rearmTargets(setup, ps, price) {
    const list = ps?.targets ?? []
    if (!Number.isFinite(price) || !list.length) return null
    const isLong = (ps?.entry?.direction ?? 'long') !== 'short'

    let changed = false
    const next = list.map(t => {
        if (t?.hit_at == null || !Number.isFinite(t?.price)) return t
        // A LEGACY RUNG KEEPS LEGACY RULES. Seeded before the TP window, it has no `resting` and its
        // limit rested on the very edge `price` names — so its `hit_at` still carries the old
        // meaning, "the money was taken". Re-arming that would have Talos propose banking a partial
        // that has already happened. Only a rung that knows where its limit is can be un-asked.
        if (!Number.isFinite(Number(t?.resting))) return t
        const outside = isLong ? price < t.price : price > t.price
        if (!outside || !_tpStillResting(setup, t.resting)) return t
        changed = true
        return { ...t, hit_at: null }
    })
    return changed ? next : null
}

/** A verdict with no sentence still has to read as a decision someone made. Pure. */
function _manageFallbackNote(verdict) {
    switch (verdict) {
        case 'move_stop':    return 'Tightening the protection — proposing a new stop.'
        case 'take_partial': return 'Banking part of this into strength — proposing a partial.'
        case 'exit_now':     return 'The reason for this trade has gone — proposing we get flat.'
        case 'let_run':      return 'This is working — letting it run rather than trimming.'
        default:             return 'Read the trade; it is doing what it was meant to do. Holding.'
    }
}

// Across every scenario, not just the projected one — a position's armed zone belongs to whichever
// premise won, and by now the projection agrees, but the lookup must not depend on that ordering.
function _zoneById(setup, id) {
    return (setup?.scenarios ?? []).flatMap(sc => sc.entry_zones ?? []).find(z => z.id === id) ?? null
}

/**
 * The validity gate for one wake. Returns a result when the setup's fate changed, else null so the
 * caller falls through to its normal reschedule.
 *
 * TWO STEPS, and the order is the whole reason this is affordable. The live tick is a FILTER, not
 * the verdict: it costs nothing (already fetched for the zone gate) and it is wrong often enough
 * that acting on it would kill setups on wicks. Only when the tick says "possibly breached" do we
 * pay for candles and ask the real question — did a bar CLOSE out there?
 *
 * A candle fetch that fails returns null: unknown is not "broken". Silence beats killing a live
 * plan on a provider hiccup.
 */
async function _checkValidity(setup, price, nowMs, deps) {
    const watched = liveScenarios(setup).filter(sc => sc.validity)
    if (!watched.length) return null

    const closes = new Map()   // timeframe → close. Rival premises usually share a rung; pay once.
    const set    = {}
    const events = []
    const next   = {}
    let last     = null

    for (const sc of watched) {
        const view      = scenarioView(setup, sc)
        const suspected = validityBreach(view, price)
        if (!suspected) continue

        const tf = sc.validity.timeframe || setup.ladder?.[0] || setup.timeframe
        if (!closes.has(tf)) closes.set(tf, await deps.getClose(setup, tf))
        const close = closes.get(tf)
        if (!Number.isFinite(close)) {
            logger.info(LOG, `[${setup.id}] tick ${price} looks past ${scenarioLabel(sc)}'s ${suspected} edge but no ${tf} close available — leaving it alone`)
            continue
        }

        // The close is the verdict, and it may disagree with the tick: that IS the wick guard working.
        const side = validityBreach(view, close)
        if (!side) continue

        const res = breachPatch(setup, sc, side, close, nowMs)
        if (!res.card) continue   // already latched — stay quiet, don't re-announce every wake

        Object.assign(set, res.set)
        next[sc.id] = res.status
        last = { scenario: sc, edge: res.edge, reason: res.reason }
        events.push({ scenario: sc, card: res.card, side, price: close, edge: res.edge, reason: res.reason })
    }

    if (!events.length) return null

    // The document's own axis, decided by what is LEFT standing rather than by what just fell.
    const rolled = rollUpBreaches(setup, next, last, nowMs)
    Object.assign(set, rolled)

    const survivors = liveScenarios(setup).filter(sc => next[sc.id] !== INVALIDATION.FIRED)
    const remaining = survivors.length

    // If the premise the document was PROJECTING just died while another still stands, the flat
    // fields would keep advertising a dead plan — the levels the confirm dialog, the watch row and
    // the FE all read. Re-project onto the first survivor.
    const projected = setup.armed_scenario_id ?? pickScenario(setup)?.id ?? null
    if (remaining && next[projected] === INVALIDATION.FIRED) {
        Object.assign(set, projectScenario(setup, survivors[0].id))
        logger.info(LOG, `[${setup.id}] projection moves to ${scenarioLabel(survivors[0])} — the one it was showing is gone`)
    }
    const patch = { ..._reschedule(setup, nowMs), ...set }
    await deps.persist(setup.id, patch, _entry('invalidation', {
        setup, nowMs, price: events[0].price, nextAt: patch['monitor_state.next_check_at'],
        read: events.map(e => e.reason).join(' · '),
    }))

    for (const ev of events) {
        try { await deps.onInvalidation(setup, { ...ev, scenario: scenarioLabel(ev.scenario), remaining }) }
        catch (err) { logger.warn(LOG, `invalidation card failed for ${setup.id}:`, err.message) }
    }

    logger.info(LOG, `[${setup.id}] ${events.map(e => `${scenarioLabel(e.scenario)} ${e.side}`).join(', ')} at ${events[0].price} — ${remaining} scenario(s) still live${rolled.status === 'closed' ? ' (closed)' : ''}`)
    return {
        reason: 'invalidation',
        side:   events[0].side,
        status: rolled.invalidation_status ?? next[events[0].scenario.id],
        closed: rolled.status === 'closed',
        remaining,
    }
}

/**
 * Act on a verdict.
 *
 * THE ENTRY GATE IS THE SETUP, NOT THE ZONE. A zone trip is only the first of two gates: it says
 * price is WHERE the setup lives, which is what makes an assessment worth paying for. Whether the
 * setup is actually fulfilled is the second gate, and that is what `conditions[]` is for — so only an
 * `enter` verdict ("this is the moment") asks the user to confirm an entry.
 *
 * Anything else means the setup has not fulfilled: the card would be asking the user to enter a
 * trade Talos just said isn't there. Those keep looking instead — Talos's own
 * tightened cadence, assessment recorded so the read is visible on the setup without a card.
 *
 * Card spam isn't a risk: firing moves the setup to 'hit', which leaves the polled statuses.
 */
async function _applyVerdict(setup, hit, raw, nowMs, reason, price, deps, stamp = null) {
    const zone     = hit?.zone ?? null
    // No zone means an EXPIRY REVIEW, and the assessment still had to show the model a plan — it
    // falls back to the projected premise (pickScenario). The recorder must agree with what was
    // asked, or every answer keyed to that scenario's conditions is dropped as hallucinated.
    const scenario = hit?.scenario ?? pickScenario(setup)
    // The mandate for this wake: the setup-wide tier plus the armed premise's own trigger. A rival
    // scenario's conditions are NOT judged here — grading the breakout's trigger while price sits in
    // the false break's zone is how a setup ends up reading as unfulfilled forever.
    const declared = declaredConditions(setup, scenario)

    const conditions = normalizeConditionResults(raw.conditions, declared)
    // The wake conditions this read is ARMING. Computed once and used for both the write and
    // the journal line: an entry has to report what is watched from here on, and `setup` still
    // holds the set this read is replacing.
    const armedNow   = clampGuards(raw.guards, setup, price)
    // The rung the NEXT read opens on. Off-ladder resolves to null, and null leaves the stored rung
    // alone rather than silently reverting a deliberate climb to the ladder's default.
    const nextRung   = clampRung(raw.next_timeframe, usableLadder(setup))
    const assessment = {
        at:             new Date(nowMs).toISOString(),
        reason,
        zone_id:        zone?.id ?? null,
        scenario_id:    scenario?.id ?? null,
        verdict:        raw.verdict,
        read:           raw.read ?? null,
        warning:        raw.verdict === 'enter' ? null : (raw.warning ?? raw.read ?? null),
        conditions,
        timeframe_used: raw.timeframe_used ?? null,
        price:          Number.isFinite(price) ? price : null,
        ...(raw.edit_proposal ? { edit_proposal: raw.edit_proposal } : {}),
    }

    const base = {
        'monitor_state.check_count':     (setup.monitor_state?.check_count ?? 0) + 1,
        'monitor_state.memo':            raw.memo_update ?? setup.monitor_state?.memo ?? null,
        'monitor_state.last_assessment': assessment,
        'monitor_state.next_check_at':   _nextCheckAt(setup, nowMs, raw.next_timeframe),
        // Only an assessment writes the rung, and no cheap wake touches it, so the choice stands
        // until the model revisits it.
        ...(nextRung ? { 'monitor_state.timeframe': nextRung } : {}),
        // …and the same is true of the guards: only a real read arms them, so the set standing at
        // any moment is the one the last judgment wrote. See the management path for why it is
        // replaced whole rather than merged.
        'monitor_state.guards': armedNow,
        // Stamped WITH the guards, because it is the clock their time term is measured
        // against: `after_min` means 'this long since a MODEL last looked at me', not since
        // the sweep last ran. Two clocks, and conflating them would let a fast sweep cadence
        // quietly reset the model's own patience. Only a real read writes it.
        'monitor_state.last_read_at': new Date(nowMs).toISOString(),
        // ONE-SHOT, cleared here as on every other write: `woke_on` describes the wake being handled
        // right now. Left set, every later wake would claim the same cause and `_hitFromGuard` would
        // keep resolving a stale zone long after price left it.
        'monitor_state.woke_on':      null,
        ...latchPatch(setup, conditions, nowMs, declared),
        ...costPatch(setup, raw._calls),
        // Caller-supplied $set that must ride EVERY branch below (the pulse's re-anchor + throttle).
        // Merged into `base` rather than into one branch because a verdict can leave through five
        // different exits, and a throttle that only lands on some of them is not a throttle.
        ...(stamp ?? {}),
    }

    // Expiry review: let_expire closes it; anything else keeps it alive on the normal cadence so
    // the user can act. Never a silent auto-close.
    if (reason === 'expiry_review' && raw.verdict === 'let_expire') {
        await deps.persist(setup.id, { ...base, status: 'closed', closedReason: 'expired', closedAt: nowMs },
            _entry(reason, { setup, nowMs, price, armed: armedNow, verdict: raw.verdict, read: raw.read }))
        return { reason, verdict: raw.verdict, closed: true }
    }

    // `edit` — the map itself is stale, whether or not price is in a zone. This used to be
    // PERSISTED AND SWALLOWED: the verdict was on the menu, `edit_proposal` was written to the
    // document, and absolutely nothing told the user. Now it fires the re-map card, and it LATCHES
    // the invalidation axis to fire once — the same fire-once rule Hermes uses, and the reason the
    // card can't repeat on every wake while the map stays stale.
    //
    // Lifecycle is untouched: a stale map is the INVALIDATION axis, not a lifecycle rung, so the
    // setup stays exactly where it was and the user re-maps it (which clears the latch) or lets it
    // go. Only an edit carrying a usable proposal counts — a blank re-map card is worse than none.
    if (raw.verdict === 'edit' && !isInvalidated(setup.invalidation_status) && _hasEditProposal(raw)) {
        const patch = {
            ...base,
            ...(zone ? { armed_zone_id: zone.id, armed_scenario_id: scenario?.id ?? null } : {}),
            invalidation_status: INVALIDATION.FIRED,
            invalidation_edge:   'time',
            invalidation_reason: raw.edit_proposal?.why ?? raw.read ?? null,
        }
        await deps.persist(setup.id, patch, _entry(reason, { setup, nowMs, price, armed: armedNow, zone, verdict: raw.verdict, read: raw.read }))
        try { await deps.onEditCard(setup, assessment) }
        catch (err) { logger.warn(LOG, `edit card failed for ${setup.id}:`, err.message) }
        return { reason, verdict: raw.verdict, edited: true }
    }

    // Price is in a zone but the setup did NOT fulfil — the second gate is the point of the
    // assessment, so this is the normal outcome, not an error. Stay 'looking' (still polled)
    // and let Talos's self-chosen cadence decide when to look again. No card: asking the user to
    // confirm an entry Talos just declined is the one thing this gate exists to prevent.
    if (zone && raw.verdict !== 'enter') {
        await deps.persist(setup.id, { ...base, status: _nextStatus(raw.verdict, reason), armed_zone_id: zone.id, armed_scenario_id: scenario?.id ?? null },
            _entry(reason, { setup, nowMs, price, armed: armedNow, zone, verdict: raw.verdict, read: raw.read }))
        return { reason, verdict: raw.verdict, watching: true }
    }

    // Fulfilled. Build the executable order plan in the SAME step that flips to 'hit': a 'hit'
    // setup with no pendingOrder would open the confirm dialog onto nothing and dead-end there
    // (the bug that shipped in the first draft).
    if (zone) {
        // THE PROJECTION (docs/desks/mentor-talos.md). The winning premise's legs and its
        // whole size are stamped onto the flat fields every kind-blind consumer reads — the order
        // plan, protectionPlan's exit legs, the reconciler, the trades ledger — so execution never
        // learns that scenarios exist. The rivals are simply no longer projected: nothing sums.
        const projection = projectScenario(setup, scenario?.id ?? null)
        // PER LEG, not per premise. The projection carries the scenario's WHOLE size; what prints
        // here is one zone. With a single entry zone the two are the same number, which is why this
        // is inert today — but the moment a premise has two legs, projecting the sum would put the
        // position fully on with only half the plan confirmed, and size the protective orders to
        // match. The scenario total remains the fallback for a zone that carries no size of its own.
        const executable = {
            ...setup, ...projection,
            quantity: legQuantity(scenario, zone.id) ?? projection.quantity,
        }
        const patch = {
            ...base, ...projection,
            status: _nextStatus(raw.verdict, reason),
            armed_zone_id: zone.id,
            armed_scenario_id: scenario?.id ?? null,
            entryTriggeredAt: nowMs,
        }

        // SELF-EXECUTED venue (broker-less real money): no order plan — the user places it
        // themselves and reports the fill. Its own card, not the confirm dialog.
        if (isSelfExecuted(setup.broker)) {
            patch.orderState = 'awaiting_manual_fill'
            await deps.persist(setup.id, patch, _entry(reason, { setup, nowMs, price, armed: armedNow, zone, verdict: raw.verdict, read: raw.read }))
            // The PROJECTED setup, not the document as it was read: the leg the user is told to place
            // must be the armed premise's, at the armed premise's size.
            try { await deps.onManualCard(executable) }
            catch (err) { logger.warn(LOG, `manual entry card failed for ${setup.id}:`, err.message) }
            return { reason, verdict: raw.verdict, fired: true, manual: true }
        }

        const plan = await deps.buildOrderPlan(executable).catch(err => {
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

        await deps.persist(setup.id, patch, _entry(reason, { setup, nowMs, price, armed: armedNow, zone, verdict: raw.verdict, read: raw.read }))

        // Only an order actually awaiting confirmation gets the confirm card. 'awaiting_market'
        // defers silently until the market sweep surfaces it (marketOpen.monitor).
        if (patch.orderState !== 'awaiting_market') {
            try { await deps.onCard(executable, assessment) }
            catch (err) { logger.warn(LOG, `entry card failed for ${setup.id}:`, err.message) }
        }

        return { reason, verdict: raw.verdict, fired: true, orderState: patch.orderState ?? null }
    }

    await deps.persist(setup.id, base, _entry(reason, { setup, nowMs, price, armed: armedNow, verdict: raw.verdict, read: raw.read }))
    return { reason, verdict: raw.verdict }
}


/** Shared with Hermes — see readinessGates.hasEditProposal. Re-exported under the historical name. */
export const _hasEditProposal = hasEditProposal


// The shared clock chores (readinessGates.js), bound to this monitor's own constants. Named
// re-exports rather than direct imports so the call sites and tests keep reading as Talos's.
export const _isPreActive  = isPreActive
export const _isPastExpiry = isPastExpiry
export const _isExpiring   = (setup, nowMs) => isExpiring(setup, nowMs, EXPIRY_THRESHOLD_MS)

/**
 * A setup does NOT spare `edit` from the past-expiry cutoff, and Hermes does. Hermes can afford to:
 * its edit latches the invalidation axis and so cannot re-fire. Talos latches too now (Phase 3), but
 * only on the branch that fires the card — a latched setup whose model keeps answering `edit` falls
 * through to the normal path, so sparing it here would reopen the exact forever-loop the cutoff
 * exists to close. The `edit_proposal` still rides on the closed document's last_assessment, so
 * nothing the model proposed is lost.
 */
const SPARE_PAST_EXPIRY = ['enter']
export const _effectiveVerdict = (verdict, reason, pastExpiry) =>
    effectiveVerdict(verdict, reason, pastExpiry, SPARE_PAST_EXPIRY)
/**
 * Status transition from the verdict: `enter` → 'hit', anything else → 'looking'. The shared one
 * (readinessGates.nextStatus), because a setup and a call are the same shape of thing and run the
 * same readiness ladder.
 *
 * What differs is what 'hit' CARRIES — a setup's order plan is stamped in the same write, where a
 * call's was built later at confirm — which is why a setup's card routes straight to the order
 * dialog. No `edit`/`let_expire` branch here: a setup's expiry review is handled
 * ahead of this in _applyVerdict (let_expire closes it, anything else stays alive on cadence), so
 * by the time status is derived the only question left is whether the setup fulfilled.
 */
export const _nextStatus = nextStatus

/**
 * When to look again, DERIVED from the rung the model asked to open on next.
 *
 * There used to be a second field for this — `next_check_min`, a self-chosen gap in minutes — and
 * the two could contradict each other: a model asking for the 15-minute chart every 2 minutes is
 * re-reading the same unfinished candle and calling it a new look. They are one decision ("how close
 * am I to the moment"), so they are now one field. The rung IS the pace.
 *
 * Still clamped into the setup's own cadence band, which resolves the two mismatches sensibly:
 * a rung coarser than the band (a `day` rung on a swing setup) is checked a few times per candle
 * rather than once, and a rung finer than the band is the signal the model reached for a view this
 * setup should not be traded on. `fallback: min` is the EAGER end, unchanged — a setup's band is
 * horizon-scaled, so its floor is already cheap. A call falls back the other way; see clampGap.
 */
export function _nextCheckAt(setup, nowMs, nextTimeframe) {
    const { min = 5, max = 30 } = setup?.cadence ?? {}
    const rung = clampRung(nextTimeframe, usableLadder(setup))
    const gap  = clampGap(rung ? rungMinutes(rung) : null, { min, max, fallback: min })
    return new Date(nowMs + gap * 60_000).toISOString()
}

/**
 * When to look again after a wake that had nothing to say.
 *
 * THE LAZY END, ALWAYS. This used to grade the gap by distance-to-zone (`proximityGapMin`: floor
 * within one band width, ceiling beyond eight, linear between) because a scheduled glance was the
 * only thing that could catch price arriving. It is not any more — the guard sweep watches every
 * armed level continuously and makes a setup due the moment one is crossed, so tightening this
 * timer buys nothing and pays for it in reads.
 *
 * What is left for this to do is the heartbeat: come back eventually even if price does nothing.
 * That is the backstop's job too, and `cadence.max` is where the model's own backstop is clamped,
 * so the two agree by construction.
 */
function _reschedule(setup, nowMs) {
    const { max = 30 } = setup?.cadence ?? {}
    const gap = max
    return {
        // No zone tripped (or market closed / assessment failed) → the setup isn't actively being
        'monitor_state.check_count':   (setup.monitor_state?.check_count ?? 0) + 1,
        'monitor_state.next_check_at': new Date(nowMs + gap * 60_000).toISOString(),
        // ONE-SHOT.  describes the wake being handled right now; leaving it set would make
        // every later wake claim the same cause, and would keep resolving a stale zone through
        // _hitFromGuard long after price left it.
        'monitor_state.woke_on':       null,
    }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

// One journal entry for a wake, through the shared builder (monitorJournal.js). This used to be a
// copy of Hermes's with the SENTENCES REMOVED — it wrote `{at, kind, price, next_at}`, which no
// reader could turn into a line of prose, so a setup's journal could only ever be rendered as JSON.
// Talos's own contribution is the model's `read`; the arithmetic wakes word themselves.
function _entry(reason, { setup, read = null, verdict = null, ...rest }) {
    return journalEntry(reason, {
        ...rest,
        entity: setup,
        note:   read,
        raw:    { verdict, read },
        // Read off the document rather than threaded through six call sites: the sweep put it there
        // and every branch that writes a line wants it. An explicit `woke` still wins, for a caller
        // that knows better than the stored value.
        woke: rest.woke ?? setup?.monitor_state?.woke_on ?? null,
    })
}

// The wake's write, from the shared writer (dueLoop.makePersist) — the monitor's $set plus the
// journal line, appended and capped, and it RETHROWS on failure.
//
// Reached through `deps.persist` rather than called directly so tests can observe what a wake
// WRITES. They could not before: the old local copy closed over the real getDb(), and its swallowed
// error is the only reason 31 DB-less tests passed. That is how the pre-active status bug stayed
// invisible in a file with full coverage.
const _persist = makePersist({ collection: COLLECTION, kind: KIND, timelineMax: TIMELINE_MAX, log: LOG })

// ─── Injectable IO ────────────────────────────────────────────────────────────

const _deps = {
    isAssetOpen,
    nextOpenMs: (asset, assetClass) => getMarketStatus(asset, assetClass).nextOpenMs,
    // The SAME quote-then-candles chain Hermes's gate uses. A price of null here means the gate
    // can never trip, so this must not diverge (monitorUtils.fetchLastPrice).
    getPrice:   (setup) => fetchLastPrice(setup.asset),
    assess:     assessSetup,
    // The in-position read. Separate from `assess` because it asks a different question of a
    // different document state — "does the reason for this trade still hold" rather than "is this
    // the moment" — and injecting them separately keeps either one testable alone.
    assessPosition,
    persist:    _persist,
    // The CLOSE of the last completed candle on a timeframe — the validity gate's verdict, as
    // opposed to `getPrice`'s live tick which is only its trigger. Deliberately the SECOND-TO-LAST
    // row: the last one is the bar still forming, and using it would reintroduce exactly the
    // intrabar wick sensitivity that "close, not touch" exists to avoid. Null on any failure, and
    // the caller reads null as "don't know" rather than "not breached".
    getClose: async (setup, tf) => {
        const rows = await fetchCandles(setup.id, setup.asset, tf, 3)
        const closed = rows?.at(-2)
        return Number.isFinite(closed?.c) ? closed.c : null
    },
    // The setup doc carries the flat camelCase execution fields ideaToEnvelope reads
    // (accounts / mainAccountId / quantity / userId), so the shared plan builder works unchanged.
    buildOrderPlan: buildOrderPlanForIdea,
    // The entry card — its own copy so a non-"enter" verdict LEADS with the warning. The
    // transport (postBotCard) is the shared piece; the wording is Mentor's.
    onCard:       notifySetupEntryConfirm,
    // Price left the range Mentor drew. Its own copy per event (ran away vs broke vs FYI) — the
    // transport is the one shared card pipe.
    onInvalidation: notifySetupInvalidation,
    // Talos's own read that the MAP is stale, carrying the re-map proposal. Same card family, so
    // the user sees one consistent "this plan needs a look" shape however it was reached.
    onEditCard: (setup, assessment) => notifySetupInvalidation(setup, {
        card: 'stale_map',
        reason: assessment?.edit_proposal?.why ?? assessment?.read ?? null,
        edit_proposal: assessment?.edit_proposal ?? null,
    }),
    // `kind` is the SENDER, not the payload: a setup's fill card is Mentor's, like every other
    // card this desk posts. Left unsaid it fell back to the shared default.
    onManualCard: (setup) => notifyManualEntry(setup.userId, { legs: [entryLegFromIdea(setup)], kind: 'setup' }),
    // The management proposal — its own copy rather than the call's, which is branded Kairos and
    // keyed on a callId. Shares the one card transport, nothing else.
    onManageCard: notifySetupManage,
    // Cancel a resting limit entry at the broker when the setup is disarmed. Follows the same
    // signature as positionManage._deps.cancelOrder so the two are swappable in tests.
    cancelOrder: (broker, userId, acct, orderId) => brokerService.cancelOrder(broker, userId, acct, orderId),
    // The disarm notification — informs the user their limit order was removed and offers Re-arm.
    onDisarmCard: notifySetupLimitDisarm,
}

export const _testDeps = _deps
