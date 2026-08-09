// ── The monitor journal ───────────────────────────────────────────────────────
//
// ONE append-only, first-person log shared by every monitor that watches an entity through time.
// A wake produces one entry; the pop-out reads the run of them as the monitor's running monologue.
//
// This lived inside Hermes, and Talos grew a copy with the SENTENCES REMOVED — same shape, same
// $push, same cap, but writing `{at, kind, price, next_at}` and nothing a reader could read. Setups
// therefore had a journal that could only be rendered as JSON. The prose here is not per-monitor
// judgment: "price is outside my zones, checking back in 30m" is arithmetic, and every monitor that
// watches zones says it the same way. What IS judgment — Hermes's four-axis assessment payload,
// Talos's per-condition read — stays with the monitor and rides in as `note` / `axes`.
//
// The entry shape is Hermes's, because the call pop-out already renders it and Hermes's histories
// are the long ones. Talos's older `{kind, next_at}` entries stay readable — the client tolerates
// both — and age out of the cap on their own.
//
//   { at, reason, price, verdict, note, next_check_at, zone_id?, fetched?, axes?, failed?, fail_reason? }
//
// `reason` ∈ pre_active | market_closed | scheduled | momentum_pulse | zone_trip | expiry_review
//            | entry | exit
//
// NAMING, and why `market_closed` is spelled out. This value used to be `closed`, which read as "the
// POSITION closed" to everyone who met it — while it actually means "the MARKET is shut, I'm holding
// off". The two are opposite events on the same timeline, and the ambiguity survived long enough to
// mislead a reader of the docs. `exit` is now the position-closed line; `market_closed` is the
// market one. `LEGACY_REASON` below keeps already-persisted entries readable.

import { toNum } from '../services/format.util.js'

/** Default cap. A monitor whose journal spans more eras (Hermes) passes its own. */
export const JOURNAL_MAX = 50

/**
 * Read-side only: entries written before the rename carry `closed` and meant the MARKET was shut.
 * Applied when rendering a stored timeline so old lines keep their meaning; never write through it.
 * Entries age out of the cap on their own, so this can be deleted once no live journal predates it.
 */
const LEGACY_REASON = { closed: 'market_closed' }

/** Normalise a stored entry's `reason` for display. Pure. */
export function readReason(reason) {
    return LEGACY_REASON[reason] ?? reason
}

function _fmt(n) { return Number.isFinite(Number(n)) ? String(Number(n)) : '?' }

/** "188–189" (single) or "188–189, 192–193" (multi). Calls and setups both carry `entry_zones`. */
export function zonesLabel(entity) {
    const zones = Array.isArray(entity?.entry_zones) ? entity.entry_zones : []
    const parts = zones
        .filter(z => Number.isFinite(Number(z?.lower)) && Number.isFinite(Number(z?.upper)))
        .map(z => `${_fmt(z.lower)}–${_fmt(z.upper)}`)
    return { text: parts.length ? parts.join(', ') : '(no zones)', multi: parts.length > 1 }
}

/** Whole-minute gap between now and an ISO next-check (≥1), or null if unparseable. */
export function gapMin(nextAt, nowMs) {
    const t = Date.parse(nextAt)
    if (!Number.isFinite(t)) return null
    return Math.max(1, Math.round((t - nowMs) / 60_000))
}

// Honest one-line note for a failed wake, by failure kind. 'truncated'/'malformed' = the model
// replied but we couldn't parse it (a bad reply, not a data/vision fetch failure); 'runaway' = it
// kept calling tools and never answered; 'io'/unknown = the read itself couldn't complete.
export function failNote(verb, asset, failReason) {
    const who = asset ?? 'the chart'
    if (failReason === 'truncated' || failReason === 'malformed') {
        return `Went to ${verb} ${who} but its reply came back malformed — retrying shortly.`
    }
    if (failReason === 'runaway') {
        return `Went to ${verb} ${who} and kept digging without reaching a decision — stopping this look and retrying shortly.`
    }
    return `Went to ${verb} ${who} but the read didn't complete — retrying shortly.`
}

// When the model gives no first-person note, synthesize one from the verdict so the log still reads.
// The verdict menu is shared across the readiness monitors, so this wording is too.
export function verdictFallbackNote(verdict) {
    switch (verdict) {
        case 'enter':       return 'This finally looks ready — proposing an entry.'
        case 'wait':        return "In the zone, but the trigger isn't here yet — waiting."
        case 'stand_aside': return 'Conditions are against this one right now — standing aside.'
        case 'let_expire':  return 'Nothing materialized — letting it expire.'
        case 'edit':        return 'The setup has drifted — proposing a re-map.'
        default:            return 'Read the chart; no change.'
    }
}

/**
 * Build one journal entry. Pure — `at` derives from `nowMs`, so tests are deterministic.
 *
 * The cheap wakes (pre_active / closed / scheduled) and a failed read write themselves: every
 * monitor has the same arithmetic to report and no reason to word it differently. Anything else is
 * an ASSESSMENT, where the monitor supplies what it learned:
 *   `note`         the model's own first-person read (falls back to the verdict wording)
 *   `axes`         the monitor's structured detail, when it has any (Hermes's four axes)
 *   `fetched`      what the read pulled, for the "I looked at" line
 *
 * @param {string} reason  the wake kind
 * @param {object} opts    { nowMs, entity, price, zone, nextAt, raw, note, axes, fetched, verb, failed, failReason }
 */
export function journalEntry(reason, {
    nowMs, entity = null, price = null, zone = null, nextAt = null,
    raw = null, note = null, axes = null, fetched = null,
    verb = 'read', failed = false, failReason = null,
    closedReason = null, pnl = null,
} = {}) {
    const at   = new Date(nowMs).toISOString()
    const noun = entity?.kind ?? 'call'

    if (reason === 'market_closed') {
        return { at, reason, price: null, verdict: null,
            note: `Market's closed for ${entity?.asset ?? 'this asset'} — holding. I'll look again at the open.`,
            next_check_at: nextAt }
    }
    // The position is flat. The LAST line on the timeline, so it says what happened rather than what
    // happens next: no `next_check_at`, because there is no next check.
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
    if (reason === 'scheduled') {
        const zl  = zonesLabel(entity)
        const gap = gapMin(nextAt, nowMs)
        return { at, reason, price: toNum(price), verdict: null,
            note: `Price ${_fmt(price)} is outside my zone${zl.multi ? 's' : ''} ${zl.text}. No setup forming${gap ? ` — checking back in ${gap}m` : ''}.`,
            next_check_at: nextAt }
    }
    if (failed) {
        return { at, reason, price: toNum(price), verdict: null,
            note: failNote(verb, entity?.asset, failReason),
            next_check_at: nextAt }
    }

    const read = (note ?? raw?.read ?? '').toString().trim()
    return {
        at, reason,
        price:   toNum(price),
        zone_id: zone?.id ?? null,
        ...(fetched != null ? { fetched } : {}),
        verdict: raw?.verdict ?? null,
        note:    read || verdictFallbackNote(raw?.verdict),
        ...(axes ? { axes } : {}),
        next_check_at: nextAt,
    }
}

/**
 * Fold a journal entry into a Mongo update doc: `$set` as given, the entry appended and the log
 * trimmed to its last `max`. One place owns the path and the cap, so a monitor cannot half-write
 * the journal by forgetting the `$slice`.
 */
export function withJournal($set, entry, max = JOURNAL_MAX) {
    const update = { $set }
    if (entry) update.$push = { 'monitor_state.timeline': { $each: [entry], $slice: -max } }
    return update
}
