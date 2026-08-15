import { ENTITIES } from '../services/entity/entityCollection.js'
import { INVALIDATION, isInvalidated, PAST_ENTRY } from '../services/entity/vocabulary.js'
import { isAssetOpen, getMarketStatus } from '../services/market.service.js'
import { logger } from '../services/logger.service.js'
import { toNum } from '../services/format.util.js'
import { fetchLastPrice, fetchCandles } from './monitorUtils.js'
import { createDueLoop, makePersist } from './dueLoop.js'
import { journalEntry, failNote } from './monitorJournal.js'
import {
    isPreActive, isExpiring, isPastExpiry, effectiveVerdict, nextStatus, clampGap, gradedGap,
    hasEditProposal,
} from './readinessGates.js'
import { buildOrderPlanForIdea } from '../services/orderPlan.service.js'
import { notifyManualEntry, entryLegFromIdea } from '../services/manualNotify.service.js'
import { assessSetup, assessPosition, READINESS_VERDICTS, MANAGEMENT_VERDICTS } from './talos.assess.js'
import { scenarioView, scenarioLabel, declaredConditions, projectScenario, pickScenario, stopEdge, targetWindows, addEntryLeg, legQuantity, pendingLegs, mayScaleIn, clampRung, usableLadder, rungMinutes } from '../services/setup.schema.js'
import { notifySetupEntryConfirm, notifySetupInvalidation, notifySetupManage } from '../services/tradeNotify.service.js'

// Talos — the guardian of the `setup` kind (docs/desks/mentor-talos.md).
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
// SCOPE. Two brains, one loop. Pre-entry it is readiness (is this the moment). Past entry it is
// management (_managePosition — does the reason for this trade still hold), on the same shape: a
// free arithmetic gate decides whether a model call is worth paying for, and the read only runs when
// it is. The position is protected either way by the stop/tp orders RESTING AT THE BROKER, built
// from the setup's zones by protectionPlan.routeSetupZones — management proposes, it never protects.
// Talos still never executes: every verdict is a card the user confirms.

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

    const expiring = _isExpiring(setup, nowMs)

    // Market closed → no entry can happen. Sleep until it reopens rather than burning the normal
    // cadence on a shut market. The expiry review is exempt: a setup may need to roll or die at
    // the close.
    if (!expiring && !deps.isAssetOpen(setup.asset, setup.asset_class)) {
        const patch = _reschedule(setup, nowMs, null)
        const openMs = deps.nextOpenMs(setup.asset, setup.asset_class)
        if (Number.isFinite(openMs) && openMs > nowMs) patch['monitor_state.next_check_at'] = new Date(openMs).toISOString()
        await deps.persist(setup.id, patch, _entry('market_closed', { setup, nowMs, nextAt: patch['monitor_state.next_check_at'] }))
        return { reason: 'market_closed' }
    }

    const price = await deps.getPrice(setup)
    // Which PREMISE price reached, not merely which zone: the scenario decides what gets judged,
    // what size is taken and which stop rests behind it.
    const hit   = scenarioGate(setup, price)
    const zone  = hit?.zone ?? null

    // Nothing tripped and not expiring → the cheap path. No LLM, just a proximity-aware
    // reschedule that tightens as price approaches the nearest zone.
    if (!zone && !expiring) {
        // The second arithmetic gate. Only reached when price is OUTSIDE every zone — a setup
        // sitting in its own zone is doing exactly what it was built to do, whatever the range
        // says, so a trip can never be overridden by an invalidation.
        const breached = await _checkValidity(setup, price, nowMs, deps)
        if (breached) return breached

        // TIER 2. Price has left the map far enough to be a different situation than the one that
        // was authored — one read, throttled, that can re-map the setup. Asked after the validity
        // gate on purpose: a premise that just BROKE is dead, and paying to look at it is waste.
        if (shouldPulse(setup, price, nowMs)) return _pulse(setup, price, nowMs, deps)

        const patch = _reschedule(setup, nowMs, price)
        // Seed the pulse anchor on first sight — the "eyes-on" price the next material move is
        // measured from. Costs nothing and needs no LLM, but until it exists nothing can ever pulse.
        if (Number.isFinite(price) && !Number.isFinite(Number(setup.monitor_state?.pulse_anchor_px))) {
            patch['monitor_state.pulse_anchor_px'] = price
        }
        await deps.persist(setup.id, patch, _entry('scheduled', { setup, nowMs, price, nextAt: patch['monitor_state.next_check_at'] }))
        return { reason: 'scheduled' }
    }

    const reason = expiring ? 'expiry_review' : 'zone_trip'
    const raw    = await deps.assess(setup, hit, { reason, price })

    if (!raw || raw._failReason) {
        const patch = _reschedule(setup, nowMs, price)
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
 * ONE momentum pulse — the Tier 2 escalation (see shouldPulse). Same full read a zone trip buys,
 * woken for a different reason and allowed to do less with the answer.
 *
 * WHAT A PULSE MAY NOT DO IS ENTER. It fires with price OUTSIDE every zone, so nothing is armed:
 * there is no `armed_zone_id`, no leg to take size from (`legQuantity`) and no fill anchor for the
 * position's entry price. An 'enter' here would fire a confirm card with no leg behind it. What the
 * pulse is FOR is `edit` — re-map the zones onto what price is actually doing, after which the
 * ordinary zone trip takes the entry through the intact path on a later wake. Everything else is
 * recorded as a `wait`, which is still worth the money: the read lands on the setup's own record.
 *
 * The anchor and the time floor are stamped on EVERY outcome, failures included. That is the whole
 * throttle: without it a failed read would re-fire on the next wake, and a trending name would buy
 * a pulse on every bar.
 */
async function _pulse(setup, price, nowMs, deps) {
    const reason = 'momentum_pulse'
    const stamp  = {
        'monitor_state.pulse_anchor_px': price,
        'monitor_state.last_pulse_at':   new Date(nowMs).toISOString(),
    }

    // No `hit`: nothing is armed. The assessment falls back to the PROJECTED premise (pickScenario),
    // which is the same thing an expiry review judges.
    const raw = await deps.assess(setup, null, { reason, price })

    if (!raw || raw._failReason) {
        const patch = { ..._reschedule(setup, nowMs, price), ...stamp }
        await deps.persist(setup.id, patch, _entry(reason, { setup, nowMs, price, nextAt: patch['monitor_state.next_check_at'], failed: true, failReason: raw?._failReason }))
        return { reason, failed: true }
    }

    const onMenu = READINESS_VERDICTS.has(raw.verdict) ? raw.verdict : 'wait'
    if (onMenu !== raw.verdict) logger.warn(LOG, `off-menu pulse verdict "${raw.verdict}" for ${setup.id} — treating as wait`)

    const verdict = (onMenu === 'edit' && _hasEditProposal(raw)) ? 'edit' : 'wait'
    if (verdict !== onMenu) logger.info(LOG, `[${setup.id}] pulse verdict "${onMenu}" → "wait" — a pulse may only re-map`)

    logger.info(LOG, `[${setup.id}] momentum pulse at ${price} — ${verdict}`)
    return _applyVerdict(setup, null, { ...raw, verdict }, nowMs, reason, price, deps, stamp)
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

    // Awaiting confirm/fill → keep the schedule moving. No journal entry: an idle wake that writes a
    // line turns the monologue into noise, and the entry card already said everything there is.
    if (!inPos) {
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
        // Each rung is a WINDOW, not a point (setup.schema.targetWindows): `resting` is the TP the
        // user named and where the limit sits at the broker, `price` is where Talos is allowed to
        // start proposing. A ZERO-WIDTH zone gets `price: null` — an exact level has no window to
        // talk in, so it simply rests and never wakes anything, which is what makes an unconditional
        // target just an order. The gate already skips a non-finite `price`.
        'position_state.targets':          targetWindows(setup).map(w => ({
            price:   w.wake !== w.target ? w.wake : null,
            resting: w.target,
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
    if (!Number.isFinite(Number(level))) return true
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
    const patch = { ..._reschedule(setup, nowMs, price), ...set }
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
        // RE-ANCHOR THE PULSE ON EVERY REAL LOOK. The anchor means "where price was when I last had
        // eyes on this plan", and this IS that moment, whatever woke it. Without this a zone trip
        // would leave the anchor wherever it was seeded, so price leaving the zone could buy a
        // second full read minutes after the first one — the pulse firing at exactly the moment we
        // are least ignorant. (Hermes re-anchors on its zone trips for the same reason.)
        ...(Number.isFinite(price) ? { 'monitor_state.pulse_anchor_px': price } : {}),
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
            _entry(reason, { setup, nowMs, price, verdict: raw.verdict, read: raw.read }))
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
        await deps.persist(setup.id, patch, _entry(reason, { setup, nowMs, price, zone, verdict: raw.verdict, read: raw.read }))
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
            _entry(reason, { setup, nowMs, price, zone, verdict: raw.verdict, read: raw.read }))
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

        // Manual (broker-less real money): no order plan — the user places it themselves and
        // reports the fill. Its own card, not the confirm dialog.
        if (setup.broker === 'manual') {
            patch.orderState = 'awaiting_manual_fill'
            await deps.persist(setup.id, patch, _entry(reason, { setup, nowMs, price, zone, verdict: raw.verdict, read: raw.read }))
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

        await deps.persist(setup.id, patch, _entry(reason, { setup, nowMs, price, zone, verdict: raw.verdict, read: raw.read }))

        // Only an order actually awaiting confirmation gets the confirm card. 'awaiting_market'
        // defers silently until the market sweep surfaces it, matching Minos.
        if (patch.orderState !== 'awaiting_market') {
            try { await deps.onCard(executable, assessment) }
            catch (err) { logger.warn(LOG, `entry card failed for ${setup.id}:`, err.message) }
        }

        return { reason, verdict: raw.verdict, fired: true, orderState: patch.orderState ?? null }
    }

    await deps.persist(setup.id, base, _entry(reason, { setup, nowMs, price, verdict: raw.verdict, read: raw.read }))
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

/** What a scenario's own invalidation axis says, or null while it is untouched. */
export function scenarioState(setup, id) {
    return setup?.monitor_state?.scenarios?.[id] ?? null
}

/**
 * The scenarios still worth watching. A scenario whose premise BROKE is out — price returning to a
 * dead level is not an entry, it is the market walking back over a corpse. `drifting` (it ran away)
 * stays live: price can come back, and "you missed it" was never "you were wrong".
 */
export function liveScenarios(setup) {
    return (setup?.scenarios ?? []).filter(sc => scenarioState(setup, sc.id)?.invalidation_status !== INVALIDATION.FIRED)
}

/**
 * The gate across a setup's rival premises: the first LIVE scenario whose entry zone contains price.
 * Returns `{ scenario, zone }`, because everything downstream needs both — the zone to report, and
 * the scenario to know which conditions to judge, which stop to place and which size to take.
 *
 * Scenarios are ordered as authored, so a primary declared first wins a tie against a rival whose
 * zone overlaps it. Overlapping rivals are a build-time smell, not a runtime decision to agonise
 * over: whichever premise the user wrote first is the one they meant.
 */
export function scenarioGate(setup, price) {
    if (!Number.isFinite(price)) return null
    for (const scenario of liveScenarios(setup)) {
        const zone = zoneGate(scenario.entry_zones, price)
        if (zone) return { scenario, zone }
    }
    return null
}

/** Every entry zone still armed, across live scenarios — what proximity cadence measures against. */
export function liveEntryZones(setup) {
    return liveScenarios(setup).flatMap(sc => sc.entry_zones ?? [])
}

/** Distance from price to the nearest zone edge, as a multiple of that zone's width. */
export function zoneDistance(zones, price) {
    if (!Number.isFinite(price) || !zones?.length) return null
    return Math.min(...zones.map(z => {
        const gap   = price < z.lower ? z.lower - price : price > z.upper ? price - z.upper : 0
        const width = zoneWidth(z)
        return gap / width
    }))
}

/**
 * A zone's width as a YARDSTICK — never zero. A Mentor zone is ATR-sized, so its width is a free
 * volatility measure; but Talos deliberately supports a ZERO-WIDTH zone (an exact level the user
 * named), and that would divide to Infinity here and reject the zone entirely there. So a degenerate
 * band falls back to 0.1% of price, which keeps an exact level measurable instead of invisible.
 *
 * Extracted from zoneDistance so the pulse gate below measures with the SAME ruler. Two rulers is
 * how "4 widths away" and "1 width away" end up disagreeing about the same zone.
 */
export function zoneWidth(z) {
    return Math.max(Number(z?.upper) - Number(z?.lower), Math.abs(Number(z?.upper)) * 0.001, 1e-9)
}

// ─── Out-of-zone momentum pulse (Tier 2) ──────────────────────────────────────
//
// Tier 1 (the zone gate) can only fire where Mentor drew a zone, and the out-of-zone validity gate
// can only KILL — `broke` / `drifting`, never a way IN. So a setup that develops at a level nobody
// mapped is invisible: price runs, the premise changes, and the next assessment is whenever price
// happens to wander back into a band that no longer means anything.
//
// This is the middle gate. On a scheduled (out-of-zone) wake, a MATERIAL, THROTTLED move away from
// every live zone earns ONE full read that can re-map the setup.
//
// ┌ MODELLED ON hermes.monitor.service.js's pulse (_shouldPulse), NOT SHARED WITH IT ──────────────┐
// │ Hermes's version is pure but shaped around a CALL: it hardcodes status 'waiting', reads a flat │
// │ call.entry_zones, and rejects a zero-width band. None of the three survives a setup, whose     │
// │ zones live inside rival scenarios and whose exact levels are legitimate. What is genuinely     │
// │ common is the SHAPE — anchor, material move in band-widths, time floor — and that is cheap to  │
// │ state twice while Hermes is being retired. DELETE HERMES'S COPY WHEN HERMES SLEEPS; this is    │
// │ the one that survives.                                                                         │
// └────────────────────────────────────────────────────────────────────────────────────────────────┘
//
// Material = >= PULSE_MOVE_BANDS x the nearest live zone's width from the last "eyes-on" anchor.
// Throttled twice over: each pulse RE-ANCHORS (so it needs a fresh full move to fire again) and each
// pulse stamps a time floor, so a name trending away doesn't buy a read on every bar.
const PULSE_MOVE_BANDS = 4

/**
 * The time floor between pulses. Talos takes the LAZY END OF ITS OWN CADENCE BAND rather than
 * Hermes's flat 20 minutes, because a setup's band is horizon-scaled and a call's is not: 15m for an
 * intraday setup, 24h for a long-term one. A fixed floor would either spam the slow book or throttle
 * the fast one. Falls back to the swing default when a document carries no cadence.
 */
export function pulseGapMin(setup) {
    return setup?.cadence?.max ?? 30
}

/**
 * Band width of the live zone whose band price is NEAREST to — the volatility yardstick a material
 * move is measured in. Null when there is no usable zone. Pure.
 *
 * Measured over `liveEntryZones`, not every authored zone: a scenario whose premise BROKE is not a
 * yardstick, and letting a dead band size the gate would silently change the threshold the moment a
 * rival scenario died.
 */
export function nearestZoneWidth(setup, price) {
    if (!Number.isFinite(price)) return null
    let width = null, bestDist = Infinity
    for (const z of liveEntryZones(setup)) {
        const lo = Number(z?.lower), hi = Number(z?.upper)
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
        const dist = price < lo ? lo - price : price > hi ? price - hi : 0
        if (dist < bestDist) { bestDist = dist; width = zoneWidth(z) }
    }
    return width
}

/**
 * Should this scheduled (out-of-zone) wake escalate to a full read? Pure — every input comes from
 * the setup, the live price and the clock.
 *
 * Guards cheapest-first: a finite price; still PRE-ENTRY (a live position is _managePosition's
 * problem, and its zones already did their job); NOT in a zone (that is Tier 1, and a trip must
 * never be pre-empted by this); the anchor seeded; a usable yardstick; a material move; the floor.
 */
export function shouldPulse(setup, price, nowMs) {
    if (!Number.isFinite(price)) return false
    if (!ACTIVE_STATUSES.includes(setup?.status)) return false
    if (scenarioGate(setup, price)) return false

    const ms     = setup?.monitor_state ?? {}
    const anchor = Number(ms.pulse_anchor_px)
    if (!Number.isFinite(anchor)) return false

    const w = nearestZoneWidth(setup, price)
    if (!Number.isFinite(w) || w <= 0) return false
    if (Math.abs(price - anchor) < PULSE_MOVE_BANDS * w) return false

    const lastAt = Date.parse(ms.last_pulse_at ?? '')
    if (Number.isFinite(lastAt) && (nowMs - lastAt) < pulseGapMin(setup) * 60_000) return false
    return true
}

// ─── In-position arithmetic ────────────────────────────────────────────────────
//
// The cheap tier for a LIVE position, mirroring what the zone gate does pre-entry: decide for free
// whether this wake is worth a model call, so a quiet position costs nothing to hold.
//
// ┌ DELIBERATE DUPLICATION — copied from hermes.monitor.service.js, DELETE WHEN HERMES SLEEPS ─────┐
// │ Hermes owns the original (`_positionGate`, `_computeMetrics`, `_rMultiple`). It is silent but  │
// │ still managing live calls, so extracting a shared module would refactor code holding real      │
// │ positions for the benefit of a caller scheduled for retirement. The copy is time-boxed: when   │
// │ Hermes's last position closes and it is retired, this becomes the only implementation and the  │
// │ note goes with it.                                                                             │
// │                                                                                                │
// │ NOT A VERBATIM COPY, and the differences are the reason a blind copy would have been wrong:    │
// │   • cadence is `{min,max}` here, `{min_gap_min,max_gap_min}` on a call                         │
// │   • targets are ZONES, reduced to their NEAR edge by setup.schema.targetEdges — so `scale_out` │
// │     fires at-or-beyond, and a gap straight through a target still trips it                     │
// │   • the stop is the widest edge across `stop_zones`, chosen by price, never `stop_zones[0]`    │
// │                                                                                                │
// │ THE RISK THIS NOTE EXISTS FOR: Talos already grew one copy of a Hermes mechanism — the journal │
// │ — and it drifted, dropping every sentence, which is why monitorJournal.js had to be extracted. │
// │ If this block and Hermes's diverge, extract rather than patch both.                            │
// └────────────────────────────────────────────────────────────────────────────────────────────────┘

/** The fill price, falling back to the intended entry until the ledger has the real one. Pure. */
function _entryPx(ps) { return toNum(ps?.entry?.fill_price) ?? toNum(ps?.entry?.intended) ?? null }

/**
 * Where price sits in multiples of the risk originally taken. Measured from `stop.initial`, never
 * from `stop.current`: moving a stop banks risk, it does not rewrite how much was risked. Pure.
 */
export function rMultiple(entry, exit, initialStop, dir) {
    if (![entry, exit, initialStop].every(Number.isFinite)) return null
    const risk = Math.abs(entry - initialStop)
    if (!(risk > 0)) return null
    const move = dir === 'short' ? (entry - exit) : (exit - entry)
    return Math.round((move / risk) * 100) / 100
}

/**
 * Running trade metrics, recomputed every wake and never authored. `mae`/`mfe` are the R extremes
 * carried ACROSS wakes (adverse ≤ 0, favourable ≥ 0) — a position that spiked to +2R and came back
 * has to still know it did, because that is the difference between "let it run" and "you gave it
 * back". An unpriceable wake preserves the previous extremes rather than resetting them. Pure.
 */
export function computeMetrics(ps, price, nowMs) {
    const r       = rMultiple(_entryPx(ps), price, toNum(ps?.stop?.initial), ps?.entry?.direction ?? 'long')
    const prevMae = Number.isFinite(ps?.metrics?.mae) ? ps.metrics.mae : null
    const prevMfe = Number.isFinite(ps?.metrics?.mfe) ? ps.metrics.mfe : null
    return {
        r_multiple_now: r,
        mae: r == null ? prevMae : (prevMae == null ? Math.min(0, r) : Math.min(prevMae, r)),
        mfe: r == null ? prevMfe : (prevMfe == null ? Math.max(0, r) : Math.max(prevMfe, r)),
        updated_at: new Date(nowMs).toISOString(),
    }
}

/** Flatten metrics into a `$set`. One place owns the paths. Pure. */
export function metricsSet(m) {
    return {
        'position_state.metrics.r_multiple_now': m.r_multiple_now,
        'position_state.metrics.mae':            m.mae,
        'position_state.metrics.mfe':            m.mfe,
        'position_state.metrics.updated_at':     m.updated_at,
    }
}

/**
 * The cheap in-position gate: an arithmetic flag that makes a model call worth paying for.
 * `{flag:null}` is an obvious hold — the overwhelmingly common case, and the whole reason this runs
 * before anything expensive. Pure.
 *
 * Priority is most-urgent-first and the order is load-bearing: a position pressing its stop while a
 * target is also in reach is an `adverse` wake, not a victory lap.
 *
 *   adverse     price within a quarter of the original risk of the WORKING stop. Not "the stop was
 *               hit" — the broker owns that. This is the look BEFORE it, while there is still a
 *               decision to make.
 *   scale_out   an un-hit target reached. `targets[].price` is the NEAR edge of its zone, so this
 *               is at-or-beyond: a gap clean through the target still trips.
 *   breakeven   ≥ +1R with the stop not yet protected past entry — the one free improvement in
 *               trading, and the trigger a `move_stop` verdict acts on.
 */
export function positionGate(ps, price) {
    if (!Number.isFinite(price)) return { flag: null }
    const entry       = _entryPx(ps)
    const initialStop = toNum(ps?.stop?.initial)
    const stopCur     = toNum(ps?.stop?.current) ?? initialStop
    const isLong      = (ps?.entry?.direction ?? 'long') !== 'short'
    const risk        = (Number.isFinite(entry) && Number.isFinite(initialStop)) ? Math.abs(entry - initialStop) : null
    const band        = risk != null ? 0.25 * risk : null

    if (band != null && Number.isFinite(stopCur)) {
        if (isLong  && price <= stopCur + band) return { flag: 'adverse' }
        if (!isLong && price >= stopCur - band) return { flag: 'adverse' }
    }

    const target = (ps?.targets ?? []).find(t =>
        t?.hit_at == null && Number.isFinite(t?.price) && (isLong ? price >= t.price : price <= t.price))
    if (target) return { flag: 'scale_out', target }

    const r = rMultiple(entry, price, initialStop, ps?.entry?.direction ?? 'long')
    if (r != null && r >= 1 && Number.isFinite(stopCur) && Number.isFinite(entry)) {
        const protectedBE = isLong ? stopCur >= entry : stopCur <= entry
        if (!protectedBE) return { flag: 'breakeven' }
    }
    return { flag: null }
}

/**
 * Is a periodic thesis review due? The gate above only fires on price events; without this, a
 * position that simply sits there is never re-read, and "nothing moved" is not the same as "nothing
 * changed" — the news that breaks a thesis rarely moves price first.
 *
 * Measured from the last management read, falling back to the fill so a fresh position gets its
 * first review one full cadence in rather than immediately. Pure.
 */
export function reviewDue(ps, nowMs, cadence) {
    const lastAt = Date.parse(ps?.last_management?.at ?? ps?.entry?.fill_at ?? '')
    return !Number.isFinite(lastAt) || (nowMs - lastAt) >= _maxGapMs(cadence)
}

function _minGapMs(cadence) { return (Number(cadence?.min) || 5)  * 60_000 }
function _maxGapMs(cadence) { return (Number(cadence?.max) || 30) * 60_000 }

// ─── The validity gate ─────────────────────────────────────────────────────────
//
// The SECOND arithmetic question every wake asks, alongside "is price in a zone?". Without it the
// only thing Talos can ever say while price is far away is "outside my zones, checking back in
// 30m" — forever, on a setup whose premise died an hour ago.
//
// The two edges are NOT the same event, and collapsing them loses the whole point (long shown;
// mirrored for a short):
//
//   close BELOW `lower`     → the premise BROKE. Structure went the other way. Latches `fired`,
//                             and `on_break` decides what happens next.
//   close ABOVE `approach`  → it RAN AWAY. Nothing was wrong with the read — it was missed, which
//     (or `upper`)            is a different conversation entirely. Marks `drifting`. Never closes
//                             a setup: price can come back, and "you missed it" is not "you were
//                             wrong".
//
// CLOSES, NOT TOUCHES. A wick through the line must not kill a plan, so the live tick only decides
// whether it is worth PAYING for a candle; the candle's close is what decides the setup's fate.
// That two-step is why this stays cheap enough to run every wake.

/** Shared with Hermes — see readinessGates.hasEditProposal. Re-exported under the historical name. */
export const _hasEditProposal = hasEditProposal

/**
 * The edge whose breach means the premise broke. Pure.
 *
 * Takes a PLAN, not necessarily the document: a scenario view (scenarioView) carries the same two
 * fields, which is how one implementation serves every rival premise on a setup.
 */
export function adverseEdge(setup) {
    const v = setup?.validity
    if (!v) return null
    return setup?.direction === 'long' ? v.lower ?? null : v.upper ?? null
}

/**
 * The edge whose breach means price ran away. `approach` is the authored away-pivot; the envelope's
 * far side stands in when none was given, so a range with only two edges still reports a runaway
 * rather than staying silent. Pure.
 */
export function awayEdge(setup) {
    const v = setup?.validity
    if (!v) return null
    const long = setup?.direction === 'long'
    return v.approach ?? (long ? v.upper ?? null : v.lower ?? null)
}

/**
 * Which side of the validity range a price sits beyond — 'adverse' | 'away' | null.
 *
 * ADVERSE WINS a tie. If a malformed range somehow makes both true, "the premise broke" is the
 * safer of the two to report: it asks the user to look, where "it ran away" is only ever an FYI.
 * Pure — used with the live tick as the cheap pre-filter AND with the candle close as the verdict.
 */
export function validityBreach(setup, price) {
    if (!Number.isFinite(price) || !setup?.validity) return null
    const long = setup?.direction === 'long'

    const adverse = adverseEdge(setup)
    if (Number.isFinite(adverse) && (long ? price < adverse : price > adverse)) return 'adverse'

    const away = awayEdge(setup)
    if (Number.isFinite(away) && (long ? price > away : price < away)) return 'away'

    return null
}

/** Which edge of the range a breach came through, in the document's words. Pure. */
function _breachEdge(direction, side) {
    return direction === 'long'
        ? (side === 'adverse' ? 'lower' : 'upper')
        : (side === 'adverse' ? 'upper' : 'lower')
}

/**
 * The $set for a confirmed breach of ONE scenario, plus whether a card should fire.
 *
 * FIRE-ONCE, both sides, PER SCENARIO. Price oscillating around an edge would otherwise notify on
 * every wake — the single most likely way for this feature to become something the user mutes.
 * `fired` is terminal for that premise (only a re-map clears it, exactly as the call path does);
 * `drifting` is announced once and then stays quiet, and can still escalate to `fired` if price
 * later breaks the other way.
 *
 * The latch lives in `monitor_state.scenarios.<id>` rather than on the scenario itself, because the
 * `scenarios` array is the AUTHORED plan and a monitor must not rewrite what the user wrote. Pure.
 */
export function breachPatch(setup, sc, side, price, nowMs) {
    const prior = scenarioState(setup, sc?.id)?.invalidation_status ?? null
    const edge  = _breachEdge(setup?.direction, side)
    const label = scenarioLabel(sc)
    const many  = (setup?.scenarios?.length ?? 0) > 1
    const at    = new Date(nowMs).toISOString()
    const key   = `monitor_state.scenarios.${sc?.id}`

    if (side === 'away') {
        // Already announced (or already dead) → nothing to say.
        if (prior != null) return { set: {}, card: null, status: null }
        const reason = `price ran to ${price} — past the ${edge} edge of where ${many ? label : 'this setup'} works`
        return {
            set:    { [key]: { invalidation_status: INVALIDATION.DRIFTING, invalidation_edge: edge, invalidation_reason: reason, at } },
            card:   'ran_away',
            status: INVALIDATION.DRIFTING,
            edge, reason,
        }
    }

    if (prior === INVALIDATION.FIRED) return { set: {}, card: null, status: null }

    const reason = `closed at ${price}, past the ${edge} edge — ${many ? label : 'the premise'} is broken`
    return {
        set:    { [key]: { invalidation_status: INVALIDATION.FIRED, invalidation_edge: edge, invalidation_reason: reason, at } },
        // `notify_only` is the authored "let it die quietly" — still its own card, never silence.
        card:   sc?.validity?.on_break === 'notify_only' ? 'invalidated_fyi' : 'invalidated',
        status: INVALIDATION.FIRED,
        edge, reason,
    }
}

/**
 * The document's own invalidation axis, rolled up from its scenarios.
 *
 * A setup is not dead because ONE premise died — that is the entire point of authoring rivals. It is
 * dead when nothing is left standing, and only then does `on_break` get to end it. The scenario that
 * fired last owns that decision: it is the one the user was still waiting on.
 *
 * `drifting` rolls up the same way (everything alive has run away from us) and never closes
 * anything. Pure — `next` is this wake's id→status map, layered over what the document already held.
 */
export function rollUpBreaches(setup, next, last, nowMs) {
    const all = setup?.scenarios ?? []
    if (!all.length) return {}

    const statusOf = (id) => next[id] ?? scenarioState(setup, id)?.invalidation_status ?? null
    const dead     = all.filter(sc => statusOf(sc.id) === INVALIDATION.FIRED).length
    const drifting = all.filter(sc => statusOf(sc.id) === INVALIDATION.DRIFTING).length

    if (dead === all.length) {
        const many = all.length > 1
        const set  = {
            invalidation_status: INVALIDATION.FIRED,
            invalidation_edge:   last?.edge ?? null,
            invalidation_reason: many ? `every scenario has broken — ${last?.reason ?? 'the plan is gone'}` : (last?.reason ?? null),
        }
        // The ONE branch that ends the setup, and only because the user asked for it at build time —
        // on the LAST premise standing, never on the first one to go.
        if (last?.scenario?.validity?.on_break === 'close') {
            Object.assign(set, { status: 'closed', closedReason: 'invalidated', closedAt: nowMs })
        }
        return set
    }

    // Everything still alive has run away. Announce once; the document's latch is what keeps it once.
    if (dead + drifting === all.length && setup?.invalidation_status == null) {
        return {
            invalidation_status: INVALIDATION.DRIFTING,
            invalidation_edge:   last?.edge ?? null,
            invalidation_reason: last?.reason ?? null,
        }
    }
    return {}
}

// ─── Condition results ─────────────────────────────────────────────────────────

/**
 * Coerce the model's per-condition answers onto the conditions the setup actually declared.
 *
 * Keyed by ID, and an answer for an id the setup doesn't have is DROPPED — a hallucinated id must
 * never latch, and it must never be counted as a check. A declared condition the model said
 * nothing about comes back 'unchecked' rather than absent, so the record always has one row per
 * condition and "it didn't answer" is visible instead of silent.
 *
 * `met` is a THREE-state word, not a boolean: yes / no / unchecked. Collapsing it would make "the
 * provider was down" indistinguishable from "I looked and it isn't happening" — the single most
 * dangerous confusion available here, because one of those is a reason to wait and the other is a
 * reason to go get the data. Pure.
 */
export function normalizeConditionResults(rawResults, declared) {
    const list = Array.isArray(declared) ? declared : []
    if (!list.length) return []

    const byId = new Map()
    for (const r of (Array.isArray(rawResults) ? rawResults : [])) {
        if (r && typeof r === 'object' && typeof r.id === 'string') byId.set(r.id.trim(), r)
    }

    return list.map(c => {
        const r   = byId.get(c.id)
        const met = r?.met === true ? 'yes' : r?.met === false ? 'no' : String(r?.met ?? '').toLowerCase()
        return {
            id:   c.id,
            met:  ['yes', 'no', 'unchecked'].includes(met) ? met : 'unchecked',
            note: typeof r?.note === 'string' && r.note.trim() ? r.note.trim() : null,
        }
    })
}

/**
 * Latch the conditions that have RESOLVED and stay resolved — see docs/desks/mentor-talos.md
 * §2.4. Only `latching` + `met:'yes'` is written, and only once: a settled event should never be
 * re-searched, both because it wastes the call and because a re-run can come back different and
 * talk the model out of a fact it already established.
 *
 * A `live` condition is never latched (it can flip on the next candle), and an 'unchecked' result
 * never latches at ALL — caching a failed look as a finding is the bug this three-state exists to
 * prevent. Returns dotted $set keys so it merges into the wake's single write. Pure.
 */
export function latchPatch(setup, results, nowMs, declared = null) {
    // `declared` is root ∪ the armed scenario's — the same list the wake judged. It defaults to the
    // root tier alone so a caller with no scenario in hand still behaves.
    const byId  = new Map((declared ?? setup?.conditions ?? []).map(c => [c.id, c]))
    const prior = setup?.monitor_state?.conditions ?? {}
    const patch = {}

    for (const r of results ?? []) {
        if (r.met !== 'yes') continue
        if (byId.get(r.id)?.persistence !== 'latching') continue
        if (prior[r.id]?.met === true) continue   // already latched — never re-stamp the timestamp
        patch[`monitor_state.conditions.${r.id}`] = { met: true, at: new Date(nowMs).toISOString(), note: r.note }
    }
    return patch
}

/**
 * What this wake actually spent, as a running tally.
 *
 * A typed watch list could be priced BEFORE it was saved ("this setup costs one chart + candles"),
 * and the FE showed that at build time. Free-text conditions can't be: the model decides what to
 * reach for once it has read them, which is the whole point. So the estimate is replaced by a
 * measurement — one that gets more accurate with every wake instead of being a guess frozen at
 * Generate, and that the eventual round cap can be sized from (docs/desks/mentor-talos.md).
 *
 * `assessments` counts only the wakes that PAID for a read, not every poll: dividing tool calls by
 * check_count would blend in the free arithmetic wakes and quietly understate what a read costs.
 * Pure. No calls (a cheap wake, or a failed one that never reached a tool) → no patch.
 */
export function costPatch(setup, calls) {
    if (!Array.isArray(calls) || !calls.length) return {}
    const prior = setup?.monitor_state?.cost ?? {}
    return {
        'monitor_state.cost': {
            tool_calls:  (Number(prior.tool_calls)  || 0) + calls.length,
            assessments: (Number(prior.assessments) || 0) + 1,
            last:        calls,
        },
    }
}

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
export const _nextStatus = nextStatus

// Talos's bands. Tighter than Hermes's (1/8 vs 2/10) because a setup's cadence is already
// horizon-scaled, so its floor is cheap. The DISTANCE is measured locally too: zoneDistance treats
// a zero-width zone as an exact level worth measuring to, where Hermes ignores such a band entirely
// — a real difference, test-locked on both sides, and not something an extraction should quietly
// settle. Only the interpolation between the bands is shared.
const NEAR_WIDTHS = 1
const FAR_WIDTHS  = 8
export function proximityGapMin(setup, price) {
    const { min = 5, max = 30 } = setup?.cadence ?? {}
    // Measured against EVERY live premise's entry, not the projected one: price walking toward the
    // breakout must tighten the loop even while the projection still shows the false break.
    return gradedGap(zoneDistance(liveEntryZones(setup), price), { min, max, near: NEAR_WIDTHS, far: FAR_WIDTHS })
}

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
}

export const _testDeps = _deps
