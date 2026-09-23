import { ENTITIES } from '../services/entity/entityCollection.js'
import { INVALIDATION, isInvalidated, PAST_ENTRY, LIVE_POSITION } from '../services/entity/vocabulary.js'
import { isAssetOpen, nextCandleCloseMs } from '../services/market.service.js'
import { logger } from '../services/logger.service.js'
import { toNum } from '../services/format.util.js'
import { fetchCandles } from './monitorUtils.js'
import { fetchLastPrice } from '../services/lastPrice.service.js'
import { createDueLoop, makePersist } from './dueLoop.js'
import { journalEntry } from './monitorJournal.js'
import { isPreActive, isExpiring, isPastExpiry, effectiveVerdict, nextStatus, hasEditProposal } from './readinessGates.js'
import { buildOrderPlanForIdea } from '../services/orderPlan.service.js'
import { notifyManualEntry, entryLegFromIdea } from '../services/manualNotify.service.js'
import { assessSetup, assessPosition, READINESS_VERDICTS, openingRung } from './talos.assess.js'
import { scenarioView, scenarioLabel, declaredConditions, projectScenario, pickScenario, stopEdge, targetLevels, addEntryLeg, legQuantity, firingLeg, resolveRung, clampGuards, normalizeWatch, disarmedSetupPatch, watchedLegs, hasWatchedLegs, allowedVerdicts } from '../services/setup.schema.js'
import { tierFor, clampExpensiveGap, tickExpensiveDue } from './talos.tiers.js'
import { cheapRead as _cheapRead } from './talos.cheap.js'
import { cancelRestingEntryOrders } from '../services/restingOrders.service.js'
import { notifySetupEntryConfirm, notifySetupInvalidation, notifySetupManage, notifySetupLimitDisarm } from '../services/tradeNotify.service.js'
import { isSelfExecuted } from '../services/venue.resolve.service.js'
import { brokerService } from '../api/broker/broker.service.js'
import { zoneGate, scenarioGate, liveScenarios, _hitFromGuard, computeMetrics, metricsSet, validityBreach, breachPatch, rollUpBreaches, normalizeConditionResults, latchPatch, costPatch } from './talos.gates.js'

// Talos — the guardian of the `setup` kind (docs/design/talos-per-candle.md).
//
// THE RULE: Talos spends a model call only on a condition the user wrote in words. In position that
// is true only for a leg the user made conditional (`watchedLegs`); a position of plain levels is
// DORMANT — the broker holds its orders and this loop never selects it.
//
// WHAT A WAKE COSTS (2026-09-23, docs/design/talos-two-tier.md). Until then every pre-entry wake was
// a full read. It is now one of three, decided by `talos.tiers.tierFor`: the EXPENSIVE read (a
// first look, an expiry review, a fired guard, or the countdown the last read set having elapsed),
// a CHEAP read (numbers only, no tools — it answers "is this fired" and escalates on this same wake
// if it is), or NOTHING at all when the last expensive read said no numbers-only pass could help.
// Measured on 95 recorded reads: 78% of wakes needed no expensive read.
//
// It polls kind:'setup' exclusively and shares no mutable state with any other loop. The guard
// sweep (guardSweep.service) is the free tier between reads: it evaluates the armed prices against
// the range since its last pass and, on a crossing, makes the document due. There is exactly one
// place a setup is ever assessed, and it is here.
//
// WHAT IS IN THIS FILE: the loop, the wake handlers, the scheduling and the writes. The free
// arithmetic — which scenario price is at, the validity gate, the condition ledger — is
// talos.gates.js, which is pure and has no idea a loop exists.

const LOG        = '[talos.monitor]'
const COLLECTION = ENTITIES
const KIND       = 'setup'

const POLL_INTERVAL_MS    = 60_000
const CHECK_TIMEOUT_MS    = 90_000
const EXPIRY_THRESHOLD_MS = 15 * 60_000   // run the expiry review within 15m of valid_until
// How long after a candle closes the read is scheduled, so the provider has the bar. The poll adds
// up to a minute on top; measure before tightening (docs/design/talos-per-candle.md, decision B).
export const READ_LAG_MS  = 30_000

// The statuses the loop polls — the readiness ladder a setup shares with a call:
//   'waiting'  persisted but NOT monitored (Arm is the user's separate act) — never polled
//   'looking'  armed — polled.
const ACTIVE_STATUSES = ['looking']
// PAST ENTRY — 'hit' (awaiting the user's confirm / a fill) and 'long'/'short' (live at the broker).
const POSITION_STATUSES = [...PAST_ENTRY]

const _loop = createDueLoop({
    collection: COLLECTION,
    kind:       KIND,
    statuses:   [...ACTIVE_STATUSES, ...POSITION_STATUSES],
    // A setup with no trading venue can be detected but never executed, so it is not worth a price
    // fetch — let alone a read. A DORMANT position (plain exits, nothing to judge) is excluded at
    // the query for the same reason: it costs nothing to hold.
    // NOTE: `$ne: null` does NOT match a missing field — a doc with no `broker` key is excluded
    // too. That is what we want (generate always stamps one), but it fails SILENTLY: if a
    // `looking` setup looks inert, check `broker` first.
    filter:     { broker: { $ne: null }, 'monitor_state.dormant': { $ne: true } },
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

    // Past entry → the position path. A live setup has no use for an entry read.
    if (POSITION_STATUSES.includes(setup.status)) return _checkPosition(setup, nowMs, deps)

    // Not live yet — sleep until it opens. No price fetch, no read. ONLY the schedule is written:
    // being pre-active is a fact about the CLOCK, not a lifecycle rung.
    if (_isPreActive(setup, nowMs)) {
        const wakeAt = new Date(Date.parse(setup.active_from)).toISOString()
        await deps.persist(setup.id, _wakePatch(setup, wakeAt), _entry('pre_active', { setup, nowMs, nextAt: wakeAt }))
        return { reason: 'pre_active' }
    }

    // Pure price-touch — no conditions to judge. The confirm card fires on the first open-market
    // wake; Talos's value is in judging conditions, and when there are none the limit order IS the
    // plan. Past-expiry setups fall through: the normal path runs an expiry_review so the model
    // decides, rather than auto-firing an enter on a setup whose window may have closed.
    if (setup.entry_mode === 'limit' && !_isPastExpiry(setup, nowMs)) {
        const sc   = liveScenarios(setup)[0] ?? null
        const zone = sc?.entry_zones?.[0] ?? null
        if (sc && !zone) logger.warn(LOG, `[${setup.id}] limit setup has scenario but no entry_zones — falling through to normal path`)
        if (sc && zone) {
            if (!deps.isAssetOpen(setup.asset, setup.asset_class)) return _sleepShut(setup, nowMs, deps)
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

    // Market shut → no candle is closing and no entry can happen. Sleep until the first close after
    // the open. The expiry review is exempt: a setup may need to roll or die at the close.
    if (!expiring && !deps.isAssetOpen(setup.asset, setup.asset_class)) return _sleepShut(setup, nowMs, deps)

    const price = await deps.getPrice(setup)
    // WHY THIS WAKE HAPPENED, as recorded by the sweep that caused it (guardSweep.service.js).
    // One-shot: cleared by every write below, so it describes this wake and no later one.
    const woke  = setup.monitor_state?.woke_on ?? null
    // Which PREMISE price reached, when it reached one. `scenarioGate` asks where price is RIGHT
    // NOW; the sweep already established where it has BEEN, up to a minute earlier — a level touched
    // and left in that minute would make the spot check say "nothing here" and throw away the very
    // crossing that paid for the wake. So a fired price guard resolves to its own zone, whatever
    // price is doing by the time we look.
    //
    // SINCE 2026-09-23 THIS NO LONGER GATES THE ENTRY. It tells the READ which premise is on the
    // table (the ARMED LEVEL block) and stamps the leg when one is reached; whether the setup fires
    // is the verdict's call alone (`_applyVerdict`, `firingLeg`). Against a zero-width price this
    // check matches a live quote only by coincidence, which is exactly why it stopped deciding.
    const hit   = scenarioGate(setup, price) ?? _hitFromGuard(setup, woke)

    // Validity is a hard safety check — code, free, and always first. A breached premise fires
    // its card whether or not a read would have followed.
    const breached = await _checkValidity(setup, price, nowMs, deps)
    if (breached) return breached

    const reason = expiring ? 'expiry_review'
        : woke ? 'guard'
        : !setup.monitor_state?.last_assessment ? 'first_look'
        : 'candle'
    const rung = openingRung(setup)

    // WHAT THIS WAKE COSTS (talos.tiers). Until 2026-09-23 every wake was a full read; measured on
    // 95 recorded reads, 78% of them needed no such thing.
    const tier = tierFor(setup, { reason, woke })

    // Nothing a numbers-only pass could check, and the countdown has not elapsed — the last
    // expensive read said so by returning `watch: null`. The guard sweep is still watching prices.
    if (tier === 'sleep') {
        const nextAt = _nextReadAt(setup, nowMs, rung, deps)
        await deps.persist(setup.id, {
            ..._wakePatch(setup, nextAt),
            'monitor_state.expensive_due': tickExpensiveDue(setup),
        }, null)
        return { reason, tier: 'sleep' }
    }

    if (tier === 'cheap') {
        const cheap = await deps.cheapRead(setup, { price, scenario: hit?.scenario ?? null })
        if (!cheap.escalate) {
            const nextAt = _nextReadAt(setup, nowMs, rung, deps)
            await deps.persist(setup.id, {
                ..._wakePatch(setup, nextAt),
                'monitor_state.expensive_due': tickExpensiveDue(setup),
                ...latchPatch(setup, _cheapAsLedger(cheap), nowMs, declaredConditions(setup, hit?.scenario ?? pickScenario(setup))),
            }, _entry(reason, { setup, nowMs, price, rung, nextAt, tier: 'cheap', read: cheap.read, model: cheap._model }))
            return { reason, tier: 'cheap', escalated: false }
        }
        // Escalated — fall straight through to the full read on THIS wake, not the next one. A
        // trigger that fired does not wait a candle for the tier above to notice.
        logger.info(LOG, `[${setup.id}] cheap read escalated${cheap._failReason ? ` (${cheap._failReason})` : ''}`)
    }

    const raw  = await deps.assess(setup, hit, { reason, price, woke })

    if (!raw || raw._failReason) {
        const nextAt = _nextReadAt(setup, nowMs, rung, deps)
        await deps.persist(setup.id, _wakePatch(setup, nextAt),
            _entry(reason, { setup, nowMs, price, rung, nextAt, failed: true, failReason: raw?._failReason, tools: raw?._tools, model: raw?._model }))
        return { reason, failed: true }
    }

    const onMenu = READINESS_VERDICTS.has(raw.verdict) ? raw.verdict : 'wait'
    if (onMenu !== raw.verdict) logger.warn(LOG, `off-menu verdict "${raw.verdict}" for ${setup.id} — treating as wait`)

    const verdict = _effectiveVerdict(onMenu, reason, _isPastExpiry(setup, nowMs))
    if (verdict !== onMenu) logger.info(LOG, `[${setup.id}] verdict "${onMenu}" → "${verdict}" (${reason}${_isPastExpiry(setup, nowMs) ? ', past expiry' : ''})`)

    return _applyVerdict(setup, hit, { ...raw, verdict }, nowMs, reason, price, deps)
}

/** A shut market: park on the first candle close after the open. No read, no journal line. */
async function _sleepShut(setup, nowMs, deps) {
    const nextAt = _nextReadAt(setup, nowMs, openingRung(setup), deps)
    await deps.persist(setup.id, _wakePatch(setup, nextAt), null)
    return { reason: 'market_closed' }
}

/**
 * Cancel the pending broker order and return the setup to 'waiting'.
 *
 * A limit order exists only while its setup is armed. When expiry or a validity breach fires, the
 * order is canceled at the broker and the setup goes dormant — the user's explicit re-arm is the
 * gate back in. Only `orderState: 'placed'` has a live broker order to cancel.
 */
async function _disarmLimit(setup, disarmReason, nowMs, deps) {
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

// ─── Past entry ───────────────────────────────────────────────────────────────

/**
 * A setup that is past entry.
 *
 *   'hit'         awaiting the user's confirm, or a fill. Nothing to say that the card didn't
 *                 already say — keep the limit-disarm checks moving, no read.
 *   long/short    the first wake after the fill writes the fill line and stamps position_state.
 *                 After that: a read on every candle close IF a leg is watched, else DORMANT.
 *
 * The CLOSE line is not written here: the reconciler flips a closed setup to 'closed', which drops
 * it out of the polled statuses before this ever sees it, so it rides the same guarded write as the
 * status flip (entityRepo.finalizeClose).
 */
async function _checkPosition(setup, nowMs, deps) {
    const ps    = setup.position_state ?? {}
    const inPos = setup.status === 'long' || setup.status === 'short'

    // Awaiting confirm/fill → check disarm triggers for limit orders, then keep the schedule moving.
    if (!inPos) {
        if (setup.entry_mode === 'limit') {
            if (_isPastExpiry(setup, nowMs)) return _disarmLimit(setup, 'expired', nowMs, deps)
            if (liveScenarios(setup).some(s => s.validity)) {
                const price    = await deps.getPrice(setup)
                const breached = await _checkValidity(setup, price, nowMs, deps)
                if (breached)               return _disarmLimit(setup, 'validity_breach', nowMs, deps)
            }
        }
        await deps.persist(setup.id, _wakePatch(setup, _nextReadAt(setup, nowMs, openingRung(setup), deps)), null)
        return { reason: 'awaiting_fill' }
    }

    // Already stamped → the management path.
    if (ps.entry?.fill_at != null) {
        const scenario = _armedScenario(setup)
        const watched  = watchedLegs(setup, scenario, ps.entry)

        // NOTHING TO JUDGE. Every leg is a plain level resting at the broker; the reconciler reports
        // the fill and the close. Excluded at the query from here on — an edit that adds a condition
        // clears the flag (setups.service).
        if (!hasWatchedLegs(watched)) {
            await deps.persist(setup.id, {
                'monitor_state.dormant':     true,
                'monitor_state.check_count': (setup.monitor_state?.check_count ?? 0) + 1,
            }, null)
            logger.info(LOG, `[${setup.id}] every exit rests at the broker — dormant`)
            return { reason: 'dormant' }
        }

        // NO READS OFF-HOURS. `fetchLastPrice` answers with the last CLOSE at 2am, and a read on a
        // frozen price can post an `exit_now` card about a trade nobody can exit. The position is not
        // unwatched while we sleep: the stop rests at the broker.
        if (!deps.isAssetOpen(setup.asset, setup.asset_class)) return _sleepShut(setup, nowMs, deps)
        return _managePosition(setup, ps, scenario, watched, nowMs, deps)
    }

    // First wake after the fill. Bookkeeping, not monitoring: it fetches no price, calls no model
    // and posts no card — it writes down a fill that has already happened. Deliberately ahead of
    // the off-hours gate so a setup filled at the close has its position_state before the open.
    const fillPrice = toNum(ps.entry?.intended) ?? toNum(setup.armed_zone_id ? _zoneById(setup, setup.armed_zone_id)?.upper : null)
    const fillAtMs  = setup.ordersPlacedAt ?? setup.entryTriggeredAt ?? nowMs
    // The WORKING stop, chosen by price rather than by array position (setup.schema stopEdge).
    const stop = stopEdge(setup)

    // Recorded as a LEG: a position built by scaling in has several fills at different prices, and
    // `fill_price` must be their size-weighted average because every R is measured from it.
    const entry = addEntryLeg(ps.entry, {
        zone_id:  setup.armed_zone_id ?? null,
        price:    fillPrice,
        quantity: toNum(_zoneById(setup, setup.armed_zone_id)?.quantity) ?? setup.quantity ?? null,
        at:       new Date(fillAtMs).toISOString(),
    })

    const nextAt = _nextReadAt(setup, nowMs, openingRung(setup), deps)
    const patch = {
        ..._wakePatch(setup, nextAt),
        'position_state.entry.legs':       entry.legs,
        'position_state.entry.fill_price': entry.fill_price,
        'position_state.entry.fill_at':    new Date(fillAtMs).toISOString(),
        'position_state.entry.size':       entry.size,
        'position_state.entry.direction':  setup.direction ?? (setup.status === 'short' ? 'short' : 'long'),
        'position_state.phase':            'running',
        // FROZEN AT FILL, and deliberately not read live off the scenario afterwards. What protects
        // the position is the order resting at the broker. `current` is what a `move_stop` verdict
        // advances; `initial` stays put because every R multiple is measured from it.
        'position_state.stop.initial':     stop,
        'position_state.stop.current':     stop,
        // Nearest-first. `watched` says whether Talos reads it (a condition) or the broker holds it.
        'position_state.targets':          targetLevels(setup).map(t => ({
            price: t.target, quantity: t.quantity, watched: t.conditions.length > 0,
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
// ignore it. A MORE urgent verdict does fire over it. add_leg sits below every protective verdict on
// purpose: adding size must never out-rank a pending decision about protecting what is already on.
const VERDICT_SEVERITY = { hold: 0, add_leg: 1, take_partial: 2, move_stop: 3, exit_now: 4 }

/**
 * One in-position wake over the WATCHED legs: metrics → READ → verdict held to the menu those legs
 * allow → persist, and a card when the verdict wants the user to do something.
 */
async function _managePosition(setup, ps, scenario, watched, nowMs, deps) {
    const price   = await deps.getPrice(setup)
    const metrics = computeMetrics(ps, price, nowMs)
    const woke    = setup.monitor_state?.woke_on ?? null
    const reason  = woke ? 'guard' : 'candle'
    const rung    = openingRung(setup)

    const base = (nextAt) => ({ ...metricsSet(metrics), ..._wakePatch(setup, nextAt) })

    const raw = await deps.assessPosition(setup, ps, { price, reason, woke, metrics, watched })
    if (!raw || raw._failReason) {
        const nextAt = _nextReadAt(setup, nowMs, rung, deps)
        await deps.persist(setup.id, base(nextAt),
            _entry(reason, { setup, nowMs, price, rung, nextAt, failed: true, failReason: raw?._failReason, verb: 'reassess', tools: raw?._tools, model: raw?._model }))
        return { reason, failed: true }
    }

    // THE MENU IS THE LEGS. The prompt offered exactly `allowedVerdicts(watched)`; this is the half
    // that cannot be talked out of it.
    const menu = allowedVerdicts(watched)
    let verdict = menu.includes(raw.verdict) ? raw.verdict : 'hold'
    if (verdict !== raw.verdict) logger.warn(LOG, `off-menu management verdict "${raw.verdict}" for ${setup.id} — treating as hold`)

    // The proposal, resolved against the document rather than trusted: a leg the model names must
    // be a watched leg, and a pending entry must actually be printing.
    let proposal = null
    let legZone  = null
    if (verdict === 'take_partial') {
        legZone = watched.targets.find(z => z.id === raw.proposal?.leg) ?? (watched.targets.length === 1 ? watched.targets[0] : null)
        const size = Number(ps.entry?.size)
        const qty  = toNum(legZone?.quantity)
        if (!legZone || !Number.isFinite(qty) || !(size > 0)) { verdict = 'hold'; logger.warn(LOG, `take_partial without a sized watched target for ${setup.id} — treating as hold`) }
        else proposal = { leg: legZone.id, quantity: qty, size_pct: Math.round((qty / size) * 10000) / 100 }
    } else if (verdict === 'move_stop') {
        const stop = toNum(raw.proposal?.stop ?? raw.proposal?.new_stop)
        if (!Number.isFinite(stop)) { verdict = 'hold'; logger.warn(LOG, `move_stop without a level for ${setup.id} — treating as hold`) }
        else proposal = { stop, why: raw.proposal?.why ?? null }
    } else if (verdict === 'add_leg') {
        // The leg must be a WATCHED pending one (never a filled leg whose level a guard re-touched),
        // and it must be printing: price at it now, or the sweep saw it reached since the last read.
        const wokeZone = _hitFromGuard(setup, woke)?.zone ?? null
        legZone = watched.entries.find(z => z.id === raw.proposal?.leg)
            ?? zoneGate(watched.entries, price)
            ?? watched.entries.find(z => z.id === wokeZone?.id)
            ?? null
        const printing = legZone && (zoneGate([legZone], price) || wokeZone?.id === legZone.id)
        if (!printing) { verdict = 'hold'; logger.warn(LOG, `add_leg with no planned leg printing for ${setup.id} — treating as hold`) }
        else proposal = { leg: legZone.id }
    }

    const nextAt   = _nextReadAt(setup, nowMs, rung, deps)
    const pending  = ps?.pending_action ?? null
    const fires    = verdict !== 'hold'
        && (VERDICT_SEVERITY[verdict] ?? 0) > (pending ? (VERDICT_SEVERITY[pending.verdict] ?? 0) : -1)
    const nextRung = resolveRung(raw.next_timeframe, setup)
    const armedNow = clampGuards(raw.guards, price)
    const declared = [watched.stop, ...watched.targets, ...watched.entries].filter(Boolean).flatMap(z => z.conditions ?? [])
    const conditions = normalizeConditionResults(raw.conditions, declared)

    const set = {
        ...base(nextAt),
        ...(nextRung ? { 'monitor_state.timeframe': nextRung } : {}),
        // Written WHOLE on every read, never merged: what the model does not re-arm is forgotten.
        'monitor_state.guards': armedNow,
        'monitor_state.last_assessment': _assessmentRecord({ nowMs, reason, scenario, raw, verdict, conditions, price, rung }),
        ...latchPatch(setup, conditions, nowMs, declared),
        ...costPatch(setup, raw._tools),
        'position_state.last_management': { at: new Date(nowMs).toISOString(), verdict },
        ...(raw.memo_update ? { 'monitor_state.memo': String(raw.memo_update) } : {}),
        ...(fires ? { 'position_state.pending_action': { verdict, proposal, at: new Date(nowMs).toISOString(), read: raw.read ?? null } } : {}),
    }

    // The execution half of a scale-in — an order plan for ONE leg, at that leg's size. Deliberately
    // NOT routed through the entry flow, which assumes nothing is open yet. `status` is untouched;
    // `armed_zone_id` moves to the new leg so the fill stamps against the right zone.
    if (verdict === 'add_leg' && legZone) {
        const projection = projectScenario(setup, setup.armed_scenario_id ?? null)
        const executable = { ...setup, ...projection, quantity: legQuantity(scenario, legZone.id) ?? null }
        if (Number.isFinite(executable.quantity) && executable.quantity > 0) {
            const plan = await deps.buildOrderPlan(executable).catch(err => {
                logger.error(LOG, `scale-in order plan failed for ${setup.id}:`, err.message)
                return []
            })
            if (plan.length > 0) {
                set.armed_zone_id = legZone.id
                set.pendingOrder  = { plan, builtAt: nowMs }
                set.orderState    = deps.isAssetOpen(setup.asset, setup.asset_class) ? 'awaiting_confirm' : 'awaiting_market'
            } else {
                logger.info(LOG, `[${setup.id}] planned leg printed with no placeable accounts — alert only`)
            }
        } else {
            logger.warn(LOG, `[${setup.id}] planned leg ${legZone.id} carries no size — nothing to place`)
        }
    }

    await deps.persist(setup.id, set, _entry(reason, {
        setup, nowMs, price, rung, nextAt, armed: armedNow, woke,
        raw: { ...raw, verdict, proposal, conditions }, tools: raw._tools, model: raw._model,
    }))

    if (fires) await deps.onManageCard(setup, { verdict, proposal, read: raw.read ?? null }).catch(() => {})

    logger.info(LOG, `[${setup.id}] ${reason} → ${verdict}${fires ? ' (card)' : ''}`)
    return { reason, verdict, card: fires }
}

/** The premise that actually won the entry — its legs are the ones on the hook. */
function _armedScenario(setup) {
    const id = setup?.armed_scenario_id
    return (setup?.scenarios ?? []).find(s => s.id === id) ?? pickScenario(setup)
}

function _zoneById(setup, id) {
    return (setup?.scenarios ?? []).flatMap(sc => sc.entry_zones ?? []).find(z => z.id === id) ?? null
}

// ─── The validity gate ─────────────────────────────────────────────────────────

/**
 * The validity gate for one wake. Returns a result when the setup's fate changed, else null so the
 * caller falls through to its normal path.
 *
 * TWO STEPS, and the order is the whole reason this is affordable. The live tick is a FILTER, not
 * the verdict: it costs nothing and it is wrong often enough that acting on it would kill setups on
 * wicks. Only when the tick says "possibly breached" do we pay for candles and ask the real question
 * — did a bar CLOSE out there? A candle fetch that fails returns null: unknown is not "broken".
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

        // Which close decides the breach: the range's own rung, else the PREMISE. It used to fall
        // to `ladder[0]` — the coarsest of the derived ±2 window — which on a setup drawn at the
        // bottom of the rung list was a chart two rungs above anything the plan spoke about.
        const tf = sc.validity.timeframe || setup.timeframe
        if (!closes.has(tf)) closes.set(tf, await deps.getClose(setup, tf))
        const close = closes.get(tf)
        if (!Number.isFinite(close)) {
            logger.info(LOG, `[${setup.id}] tick ${price} looks past ${scenarioLabel(sc)}'s ${suspected} edge but no ${tf} close available — leaving it alone`)
            continue
        }

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

    const rolled = rollUpBreaches(setup, next, last, nowMs)
    Object.assign(set, rolled)

    const survivors = liveScenarios(setup).filter(sc => next[sc.id] !== INVALIDATION.FIRED)
    const remaining = survivors.length

    const projected = setup.armed_scenario_id ?? pickScenario(setup)?.id ?? null
    if (remaining && next[projected] === INVALIDATION.FIRED) {
        Object.assign(set, projectScenario(setup, survivors[0].id))
        logger.info(LOG, `[${setup.id}] projection moves to ${scenarioLabel(survivors[0])} — the one it was showing is gone`)
    }
    const nextAt = _nextReadAt(setup, nowMs, openingRung(setup), deps)
    await deps.persist(setup.id, { ..._wakePatch(setup, nextAt), ...set }, _entry('invalidation', {
        setup, nowMs, price: events[0].price, nextAt,
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

// ─── Verdicts ─────────────────────────────────────────────────────────────────

/**
 * Act on a pre-entry verdict.
 *
 * THE ENTRY GATE IS THE VERDICT, AND ONLY THE VERDICT (2026-09-23). Whether the setup is fulfilled
 * is what `conditions[]` is for, and the read is what judges them — so an `enter` fires the confirm
 * card, full stop. It no longer has to ALSO be standing on a level that a containment test agrees
 * about.
 *
 * What the level still decides is WHICH leg (`firingLeg`): the one price is at when the wake
 * resolved to a specific zone, else the scenario's first unfilled leg. The zone keeps the order
 * price, the size and the r:r; it stopped being a second opinion (see firingLeg for what that cost
 * in prod).
 *
 * Anything other than `enter` keeps looking, the read recorded so it is visible on the setup
 * without a card. Card spam isn't a risk: firing moves the setup to 'hit'.
 */
async function _applyVerdict(setup, hit, raw, nowMs, reason, price, deps) {
    const zone     = hit?.zone ?? null
    const scenario = hit?.scenario ?? pickScenario(setup)
    const declared = declaredConditions(setup, scenario)
    const rung     = openingRung(setup)
    // Resolved for an `enter` whether or not price is standing on a level right now.
    const leg      = raw.verdict === 'enter' ? firingLeg(scenario, zone) : null

    const conditions = normalizeConditionResults(raw.conditions, declared)
    const armedNow   = clampGuards(raw.guards, price)
    const nextRung   = resolveRung(raw.next_timeframe, setup)
    const assessment = _assessmentRecord({ nowMs, reason, zone, scenario, raw, verdict: raw.verdict, conditions, price, rung })
    const nextAt     = _nextReadAt(setup, nowMs, nextRung ?? rung, deps)

    const base = {
        ..._wakePatch(setup, nextAt),
        'monitor_state.memo':            raw.memo_update ?? setup.monitor_state?.memo ?? null,
        'monitor_state.last_assessment': assessment,
        ...(nextRung ? { 'monitor_state.timeframe': nextRung } : {}),
        // Written WHOLE on every read, never merged: what the model does not re-arm is forgotten.
        'monitor_state.guards': armedNow,
        // The two fields that pace the NEXT expensive read and configure the cheap passes between
        // (talos.tiers). Rewritten whole each read, for the same reason guards are.
        'monitor_state.expensive_due': clampExpensiveGap(raw.next_expensive_in),
        'monitor_state.watch':         normalizeWatch(raw.watch),
        ...latchPatch(setup, conditions, nowMs, declared),
        ...costPatch(setup, raw._tools),
    }
    const row = (extra = {}) => _entry(reason, {
        setup, nowMs, price, rung, nextAt, armed: armedNow, zone,
        raw: { ...raw, conditions }, tools: raw._tools, model: raw._model, ...extra,
    })

    if (reason === 'expiry_review' && raw.verdict === 'let_expire') {
        await deps.persist(setup.id, { ...base, status: 'closed', closedReason: 'expired', closedAt: nowMs }, row())
        return { reason, verdict: raw.verdict, closed: true }
    }

    if (raw.verdict === 'edit' && !isInvalidated(setup.invalidation_status) && _hasEditProposal(raw)) {
        const patch = {
            ...base,
            ...(zone ? { armed_zone_id: zone.id, armed_scenario_id: scenario?.id ?? null } : {}),
            invalidation_status: INVALIDATION.FIRED,
            invalidation_edge:   'time',
            invalidation_reason: raw.edit_proposal?.why ?? raw.read ?? null,
        }
        await deps.persist(setup.id, patch, row())
        try { await deps.onEditCard(setup, assessment) }
        catch (err) { logger.warn(LOG, `edit card failed for ${setup.id}:`, err.message) }
        return { reason, verdict: raw.verdict, edited: true }
    }

    if (leg) {
        const projection = projectScenario(setup, scenario?.id ?? null)
        const executable = {
            ...setup, ...projection,
            quantity: legQuantity(scenario, leg.id) ?? projection.quantity,
        }
        const patch = {
            ...base, ...projection,
            status: _nextStatus(raw.verdict),
            armed_zone_id: leg.id,
            armed_scenario_id: scenario?.id ?? null,
            entryTriggeredAt: nowMs,
        }

        if (isSelfExecuted(setup.broker)) {
            patch.orderState = 'awaiting_manual_fill'
            await deps.persist(setup.id, patch, row())
            try { await deps.onManualCard(executable) }
            catch (err) { logger.warn(LOG, `manual entry card failed for ${setup.id}:`, err.message) }
            return { reason, verdict: raw.verdict, fired: true, manual: true }
        }

        const plan = await deps.buildOrderPlan(executable).catch(err => {
            logger.error(LOG, `order plan failed for ${setup.id}:`, err.message)
            return []
        })
        if (plan.length > 0) {
            patch.pendingOrder = { plan, builtAt: nowMs }
            patch.orderState   = deps.isAssetOpen(setup.asset, setup.asset_class) ? 'awaiting_confirm' : 'awaiting_market'
        } else {
            logger.info(LOG, `[${setup.id}] level reached with no placeable accounts — alert only`)
        }

        await deps.persist(setup.id, patch, row())

        if (patch.orderState !== 'awaiting_market') {
            try { await deps.onCard(executable, assessment) }
            catch (err) { logger.warn(LOG, `entry card failed for ${setup.id}:`, err.message) }
        }

        return { reason, verdict: raw.verdict, fired: true, orderState: patch.orderState ?? null }
    }

    // An `enter` with no leg to fire on — a premise carrying no entry zone, which readiness refuses
    // at Generate. Recorded rather than silently swallowed, because the alternative is a user whose
    // setup said "enter" and did nothing, with nothing anywhere saying why.
    if (raw.verdict === 'enter') {
        logger.warn(LOG, `[${setup.id}] enter verdict with no entry leg on ${scenario?.id ?? 'any scenario'} — nothing to place`)
    }

    // Not an entry. Arm the premise price reached, when it reached one, so the fill stamps against
    // the right leg if a later read does say enter.
    if (zone) {
        await deps.persist(setup.id, { ...base, status: _nextStatus(raw.verdict), armed_zone_id: zone.id, armed_scenario_id: scenario?.id ?? null }, row())
        return { reason, verdict: raw.verdict, watching: true }
    }

    await deps.persist(setup.id, base, row())
    return { reason, verdict: raw.verdict }
}

/**
 * A cheap read's answers in the shape `latchPatch` speaks, so a LATCHING condition the cheap tier
 * settled stays settled and is never re-asked — of either tier. Only `fired` latches: `unknown` is
 * the tier saying it could not look, which must never be recorded as an answer. Pure.
 */
function _cheapAsLedger(cheap) {
    return (cheap?.conditions ?? []).map(c => ({ id: c.id, met: c.state === 'fired' ? 'yes' : 'no', note: c.note }))
}

/** What the last read concluded — the pop-out's "where Talos stands now", kept on the document. */
function _assessmentRecord({ nowMs, reason, zone = null, scenario, raw, verdict, conditions, price, rung }) {
    return {
        at:             new Date(nowMs).toISOString(),
        reason,
        zone_id:        zone?.id ?? null,
        scenario_id:    scenario?.id ?? null,
        verdict,
        read:           raw.read ?? null,
        warning:        verdict === 'enter' ? null : (raw.warning ?? null),
        conditions,
        rung,
        tools:          raw._tools ?? [],
        ...(raw._model ? { model: raw._model } : {}),
        price:          Number.isFinite(price) ? price : null,
        ...(raw.edit_proposal ? { edit_proposal: raw.edit_proposal } : {}),
    }
}

/** Shared with the readiness ladder — see readinessGates. Re-exported under the historical names. */
export const _hasEditProposal = hasEditProposal
export const _isPreActive  = isPreActive
export const _isPastExpiry = isPastExpiry
export const _isExpiring   = (setup, nowMs) => isExpiring(setup, nowMs, EXPIRY_THRESHOLD_MS)

/**
 * A setup does NOT spare `edit` from the past-expiry cutoff. Talos latches on the branch that fires
 * the edit card, but a latched setup whose model keeps answering `edit` falls through to the normal
 * path — sparing it here would reopen the forever-loop the cutoff exists to close.
 */
const SPARE_PAST_EXPIRY = ['enter']
export const _effectiveVerdict = (verdict, reason, pastExpiry) =>
    effectiveVerdict(verdict, reason, pastExpiry, SPARE_PAST_EXPIRY)
export const _nextStatus = nextStatus

// ─── Scheduling ───────────────────────────────────────────────────────────────

/**
 * When to read again: the next close of `rung` for this instrument, plus the lag the provider
 * needs to have the bar. Before a position exists (pre-entry, or a limit order awaiting its fill),
 * never later than the expiry review — a day rung must not sleep through a setup's last quarter
 * hour. Session-aware through market.service, so a shut market lands on the first close after the
 * open.
 */
export function _nextReadAt(setup, nowMs, rung, deps = _deps) {
    const close = deps.nextCandleCloseMs(setup.asset, setup.asset_class, rung, nowMs)
    let at = Number.isFinite(close) ? close + READ_LAG_MS : nowMs + 15 * 60_000
    if (!LIVE_POSITION.includes(setup.status)) {
        const review = Date.parse(setup.valid_until ?? '') - EXPIRY_THRESHOLD_MS
        if (Number.isFinite(review) && review > nowMs && review < at) at = review
    }
    return new Date(at).toISOString()
}

/** The three fields every wake writes. `woke_on` is ONE-SHOT: it describes this wake and no later one. */
function _wakePatch(setup, nextAt) {
    return {
        'monitor_state.check_count':   (setup.monitor_state?.check_count ?? 0) + 1,
        'monitor_state.next_check_at': nextAt,
        'monitor_state.woke_on':       null,
    }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

// One journal row for a wake, through the shared builder (monitorJournal.js).
function _entry(reason, { setup, read = null, ...rest }) {
    return journalEntry(reason, {
        ...rest,
        entity: setup,
        note:   read,
        // Read off the document rather than threaded through every call site: the sweep put it
        // there and every row wants it. An explicit `woke` still wins.
        woke: rest.woke ?? setup?.monitor_state?.woke_on ?? null,
    })
}

// The wake's write, from the shared writer (dueLoop.makePersist) — the monitor's $set, then the
// journal row. Reached through `deps.persist` so tests can observe what a wake WRITES.
const _persist = makePersist({ collection: COLLECTION, kind: KIND, log: LOG })

// ─── Injectable IO ────────────────────────────────────────────────────────────

const _deps = {
    isAssetOpen,
    nextCandleCloseMs,
    getPrice:   (setup) => fetchLastPrice(setup.asset),
    assess:     assessSetup,
    cheapRead:  _cheapRead,
    assessPosition,
    persist:    _persist,
    // The CLOSE of the last completed candle on a timeframe — the validity gate's verdict, as
    // opposed to `getPrice`'s live tick which is only its trigger. The SECOND-TO-LAST row: the last
    // one is the bar still forming. Null on any failure, read as "don't know".
    getClose: async (setup, tf) => {
        const rows = await fetchCandles(setup.id, setup.asset, tf, 3)
        const closed = rows?.at(-2)
        return Number.isFinite(closed?.c) ? closed.c : null
    },
    buildOrderPlan: buildOrderPlanForIdea,
    // The cards. Each is this desk's own copy; the transport (postBotCard) is the shared piece.
    onCard:         notifySetupEntryConfirm,
    onInvalidation: notifySetupInvalidation,
    onEditCard: (setup, assessment) => notifySetupInvalidation(setup, {
        card: 'stale_map',
        reason: assessment?.edit_proposal?.why ?? assessment?.read ?? null,
        edit_proposal: assessment?.edit_proposal ?? null,
    }),
    onManualCard: (setup) => notifyManualEntry(setup.userId, { legs: [entryLegFromIdea(setup)], kind: 'setup' }),
    onManageCard: notifySetupManage,
    cancelOrder: (broker, userId, acct, orderId) => brokerService.cancelOrder(broker, userId, acct, orderId),
    onDisarmCard: notifySetupLimitDisarm,
}

export const _testDeps = _deps
