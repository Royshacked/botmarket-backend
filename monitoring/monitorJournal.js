// ── The monitor journal — one row per read ────────────────────────────────────
//
// ONE append-only, first-person log per entity, in its own collection (services/journal.service),
// read newest-first by the pop-out. A model read produces one row; so do the four events code
// writes on a trade without a model — the fill, the close, an invalidation, and the one line a
// not-yet-live setup writes before it sleeps. Nothing else does: a wake that cost no model call
// writes nothing, which is what keeps the record a history rather than a heartbeat
// (docs/design/talos-per-candle.md).
//
// The row says what the read LOOKED AT, what it DECIDED and what it is WAITING FOR:
//
//   { at, reason, price, rung, verdict, note, warning?, conditions?, tools?, proposal?,
//     fired?, armed?, zone_id?, next_check_at }
//
//   reason ∈ first_look | candle | guard | expiry_review | limit_order | limit_disarmed
//            | entry | invalidation | exit | pre_active
//
//   `conditions`  what it checked — [{ id, met, note }], straight from the read
//   `tools`       what it pulled — the tool names, in order
//   `fired`       the guard that caused a `guard` wake, WITH the time it was armed
//   `armed`       what is being watched from here on
//
// The prose here is not per-monitor judgment: a failed read and a fill line read the same for any
// monitor. What IS judgment — the model's own sentence — rides in as `note`.

import { toNum } from '../services/format.util.js'

function _fmt(n) { return Number.isFinite(Number(n)) ? String(Number(n)) : '?' }

// Honest one-line note for a failed wake, by failure kind. 'truncated'/'malformed' = the model
// replied but we couldn't parse it; 'runaway' = it kept calling tools and never answered;
// 'io'/unknown = the read itself couldn't complete.
export function failNote(verb, asset, failReason) {
    const who = asset ?? 'the chart'
    if (failReason === 'truncated' || failReason === 'malformed') {
        return `Went to ${verb} ${who} but its reply came back malformed — retrying at the next close.`
    }
    if (failReason === 'runaway') {
        return `Went to ${verb} ${who} and kept digging without reaching a decision — stopping this look and retrying at the next close.`
    }
    return `Went to ${verb} ${who} but the read didn't complete — retrying at the next close.`
}

// When the model gives no first-person note, synthesize one from the verdict so the log still reads.
export function verdictFallbackNote(verdict) {
    switch (verdict) {
        case 'enter':        return 'This finally looks ready — proposing an entry.'
        case 'wait':         return "Not the moment yet — waiting."
        case 'stand_aside':  return 'Conditions are against this one right now — standing aside.'
        case 'let_expire':   return 'Nothing materialized — letting it expire.'
        case 'edit':         return 'The setup has drifted — proposing a re-map.'
        case 'hold':         return 'Read the trade; nothing I am watching has come true. Holding.'
        case 'move_stop':    return 'Tightening the protection — proposing a new stop.'
        case 'take_partial': return 'A watched target\'s condition is here — proposing the partial.'
        case 'exit_now':     return 'The reason for this trade has gone — proposing we get flat.'
        case 'add_leg':      return 'The planned leg is printing — proposing to add it.'
        default:             return 'Read the chart; no change.'
    }
}

/**
 * Build one journal row. Pure — `at` derives from `nowMs`, so tests are deterministic.
 *
 * The code-written events (pre_active / entry / exit) and a failed read word themselves. Anything
 * else is a READ, where the monitor supplies what the model said and what the read pulled.
 *
 * @param {string} reason  the wake kind
 * @param {object} opts    { nowMs, entity, price, zone, nextAt, raw, note, verb, failed, failReason,
 *                           closedReason, pnl, woke, armed, rung, tools }
 */
export function journalEntry(reason, {
    nowMs, entity = null, price = null, zone = null, nextAt = null,
    raw = null, note = null, verb = 'read', failed = false, failReason = null,
    closedReason = null, pnl = null,
    // The guard that woke this (guardSweep writes it to `monitor_state.woke_on`). Absent on a wake
    // the sweep did not cause.
    woke = null,
    // What is armed AFTER this wake. Passed explicitly by a read that just rewrote the set, because
    // the entity in hand still carries the one being replaced.
    armed: armedIn = null,
    rung = null,
    tools = null,
} = {}) {
    const at    = new Date(nowMs).toISOString()
    const noun  = entity?.kind ?? 'setup'
    const armed = Array.isArray(armedIn) ? armedIn
        : (Array.isArray(entity?.monitor_state?.guards) ? entity.monitor_state.guards : null)

    // The position is flat. The LAST row: it says what happened rather than what happens next.
    if (reason === 'exit') {
        const why = { stop: 'stop hit', target: 'target hit', manual: 'closed by hand' }[closedReason] ?? closedReason
        return { at, reason, price: toNum(price), verdict: null,
            note: `Out of ${entity?.asset ?? 'the position'}${price != null ? ` at ${_fmt(price)}` : ''}`
                + `${why ? ` — ${why}` : ''}${pnl != null ? `. Realised ${_fmt(pnl)}.` : '.'}`,
            next_check_at: null }
    }
    if (reason === 'pre_active') {
        return { at, reason, price: null, verdict: null,
            note: `Not live yet for ${entity?.asset ?? `this ${noun}`} — I start watching at ${entity?.active_from ?? '?'}.`,
            next_check_at: nextAt }
    }
    if (failed) {
        return { at, reason, price: toNum(price), verdict: null, ...(rung ? { rung } : {}),
            note: failNote(verb, entity?.asset, failReason),
            ...(tools?.length ? { tools } : {}),
            next_check_at: nextAt }
    }

    const read = (note ?? raw?.read ?? '').toString().trim()
    return {
        at, reason,
        price:   toNum(price),
        ...(rung ? { rung } : {}),
        ...(zone?.id ? { zone_id: zone.id } : {}),
        verdict: raw?.verdict ?? null,
        note:    read || verdictFallbackNote(raw?.verdict),
        ...(raw?.warning ? { warning: String(raw.warning) } : {}),
        ...(Array.isArray(raw?.conditions) && raw.conditions.length ? { conditions: raw.conditions } : {}),
        ...(tools?.length ? { tools } : {}),
        ...(raw?.proposal ? { proposal: raw.proposal } : {}),
        // Omitted, not nulled: a reader tolerating absence is cheaper than rows carrying emptiness.
        ...(woke ? { fired: { price: woke.price ?? null, direction: woke.direction ?? null,
                              means: woke.means ?? null, armed_at: woke.armed_at ?? null } } : {}),
        ...(armed?.length ? { armed } : {}),
        next_check_at: nextAt,
    }
}
