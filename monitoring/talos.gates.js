import { INVALIDATION } from '../services/entity/vocabulary.js'
import { toNum } from '../services/format.util.js'
import { scenarioLabel, legPrice } from '../services/setup.schema.js'

// Talos's PURE TIER — every decision the monitor makes without touching the network.
//
// Split out of talos.monitor.service.js, which had grown to ~1500 lines holding four unrelated
// jobs: the poll loop and its wake handlers, the scheduling, the persistence, and this. Same reason
// talos.assess.js, monitorJournal.js and readinessGates.js each came out of it before — what is
// left reads as orchestration, which is what that file's own header claims it is.
//
// EVERYTHING HERE IS PURE. No IO, no clock beyond an explicit `nowMs`, no injected deps. Four
// groups, in the order a wake asks them:
//
//   1. THE LEVEL GATES     is price at one of this setup's legs, and whose premise is it?
//   2. IN-POSITION         where does the trade stand (R, MAE, MFE)?
//   3. THE VALIDITY GATE   has the premise broken, or has price simply run away?
//   4. THE RECORD          what the model answered, folded onto what the setup declared.
//
// Imported by talos.monitor.service.js (the loop) and asserted directly by talosMonitor.test.js.

/**
 * The cheap arithmetic gate: is price AT one of these legs? Returns the first that matches (legs are
 * armed simultaneously; whichever price reaches first acts).
 *
 * BEHAVIOUR-PRESERVING, not a new rule. This was `price >= z.lower && price <= z.upper`, and every
 * leg has been zero-width since the guards build — so containment already WAS equality, and the
 * band form only survived because the keys did. It matches about as often as it did before, which is
 * to say rarely: measured in prod, only 2 of 70 journal rows carried a resolved level at all
 * (docs/desks/mentor-talos.md §Entry). That is not a fault to fix here. A spot quote landing exactly
 * on an authored price is a coincidence; the thing that PROVES price reached a level is the guard
 * sweep, which tests the range since the last look, and `_hitFromGuard` is its side of this gate.
 *
 * `enter` stopped depending on either of them on 2026-09-23 — the verdict is the whole gate. What a
 * match still decides is which rival premise is on the table and which leg fires.
 */
export function legGate(legs, price) {
    if (!Number.isFinite(price)) return null
    return (legs ?? []).find(z => legPrice(z) === price) ?? null
}

/**
 * The premise a FIRED PRICE GUARD belongs to, or null.
 *
 * The guard sweep proved price reached a level; this says which plan that level was part of, so the
 * wake can judge the right premise and arm the right leg. This is the path that actually resolves in
 * practice, because the model arms its entry guard AT the authored price — so the match is exact by
 * construction rather than by luck.
 *
 * Null when the level belongs to no leg — a line the model drew somewhere the plan does not reach.
 * That is a legitimate wake and deliberately not an entry level: a read woken here can re-map the
 * setup (`edit`), and an `enter` it returns fires on the scenario's first unfilled leg (`firingLeg`)
 * rather than on a line with no size behind it. Pure.
 */
export function _hitFromGuard(setup, woke) {
    const lvl = toNum(woke?.price)
    if (!Number.isFinite(lvl)) return null
    for (const sc of liveScenarios(setup)) {
        const leg = (sc.entry_legs ?? []).find(z => legPrice(z) === lvl)
        if (leg) return { scenario: sc, leg }
    }
    return null
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
 * The gate across a setup's rival premises: the first LIVE scenario with an entry leg AT price.
 * Returns `{ scenario, leg }`, because everything downstream needs both — the leg to report, and
 * the scenario to know which conditions to judge, which stop to place and which size to take.
 *
 * Scenarios are ordered as authored, so a primary declared first wins a tie against a rival drawn at
 * the same price. Two premises entering at one level is a build-time smell, not a runtime decision to
 * agonise over: whichever the user wrote first is the one they meant.
 */
export function scenarioGate(setup, price) {
    if (!Number.isFinite(price)) return null
    for (const scenario of liveScenarios(setup)) {
        const leg = legGate(scenario.entry_legs, price)
        if (leg) return { scenario, leg }
    }
    return null
}

// ─── In-position arithmetic ────────────────────────────────────────────────────
//
// Where a LIVE position stands, recomputed every wake and never authored. There is no gate here any
// more: WHETHER a position is read at all is `watchedLegs` (setup.schema), and WHEN is the candle
// close (docs/design/talos-per-candle.md). What stays is the arithmetic the read and the pop-out
// both want — R from the risk originally taken, and the extremes carried across wakes.

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

// ─── The validity gate ─────────────────────────────────────────────────────────
//
// The SECOND arithmetic question every wake asks, alongside "is price at a leg?". Without it the
// only thing Talos can ever say while price is far away is "nowhere near my levels, checking back in
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
            // THE AUTHORED ANSWER picks the card, exactly as `on_break` picks between `invalidated`
            // and `invalidated_fyi` below. `pass` is the user saying at build time that a missed trade
            // is a missed trade — so they are told and asked nothing. Anything else (the default is
            // `revise`, and Generate refuses a range with neither) opens the plan back up with Mentor,
            // because the level has moved and a continuation has to be MEASURED rather than
            // remembered (docs/design/mentor-challenge.md §3).
            card:   sc?.validity?.on_away === 'pass' ? 'ran_away_fyi' : 'ran_away',
            status: INVALIDATION.DRIFTING,
            // The way in that did not fill. It travels so the card can name the continuation worth
            // looking at — a question, never a level: nothing here authors a price.
            archetype: sc?.archetype ?? null,
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
