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
//   { at, reason, price, verdict, note, next_check_at, zone_id?, fetched?, axes?, failed?, fail_reason?,
//     fired?, armed?, skipped? }
//
// `reason` ∈ pre_active | market_closed | guard_time | guard_price | backstop | expiry_review
//            | entry | exit
//
// ── WHAT A LINE IS ABOUT, SINCE GUARDS ───────────────────────────────────────
// docs/desks/talos-guards.md. `reason` used to answer "what KIND of wake was this"; it now answers
// WHICH GUARD FIRED, so a run of entries reads as an audit trail of ATTENTION rather than a list of
// glances. Three fields carry the rest of that story:
//
//   `fired`    the guard that caused this wake, WITH the time it was armed — so a reader can see the
//              line was drawn hours earlier, deliberately, rather than stumbled into.
//   `armed`    what is being watched from here on. Replaces a bare `next_check_at`, which only ever
//              said when we would next stir and never what would bring us back sooner.
//   `skipped`  conjunctive guards that held on TIME but not on price since the last entry — wakes
//              deliberately NOT taken. The saving, made visible.
//
// AND THE RULE THAT PROTECTS ALL OF IT: A FREE POLL NEVER WRITES. The guard sweep evaluates every
// armed setup on a fast cadence and almost always answers "no". At that rate a line per pass would
// push 50 entries through the cap in under an hour, leaving a journal that is all heartbeat and no
// history. Only a wake that cost a model read may append.
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
const LEGACY_REASON = {
    closed: 'market_closed',
    // The zone gate's vocabulary, mapped to the guards that replaced it (2026-08-22). Same events
    // under both names — a level was reached, or a timer brought us back — so old entries keep their
    // meaning rather than rendering as an unknown key.
    zone_trip: 'guard_price',
    scheduled: 'guard_time',
    // `momentum_pulse` is deliberately NOT mapped. It was its own kind of wake (price walking far
    // enough from the map to buy one re-drawing read) and no guard means quite that, so relabelling
    // it would be a claim about history. It renders under its own name until it ages out.
}

/** Normalise a stored entry's `reason` for display. Pure. */
export function readReason(reason) {
    return LEGACY_REASON[reason] ?? reason
}

function _fmt(n) { return Number.isFinite(Number(n)) ? String(Number(n)) : '?' }

/**
 * The entry levels being watched: "312" (single) or "312, 318" (multi).
 *
 * WAS `zonesLabel`, which always printed a range. A level authored now is ZERO-WIDTH, so that
 * spelling would render "312–312" — and worse, it would go on telling the user about a BAND at
 * exactly the point the app stopped having any (docs/desks/talos-guards.md). A legacy band still
 * prints as a range, because that is honestly what such a document holds.
 *
 * Calls and setups both carry `entry_zones`.
 */
export function levelsLabel(entity) {
    const zones = Array.isArray(entity?.entry_zones) ? entity.entry_zones : []
    const parts = zones
        .filter(z => Number.isFinite(Number(z?.lower)) && Number.isFinite(Number(z?.upper)))
        .map(z => (Number(z.lower) === Number(z.upper) ? _fmt(z.lower) : `${_fmt(z.lower)}–${_fmt(z.upper)}`))
    return { text: parts.length ? parts.join(', ') : '(no levels)', multi: parts.length > 1 }
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
    // The guard that woke this (guardSweep writes it to `monitor_state.woke_on`). Absent on a wake
    // the sweep did not cause — a first look, or a deploy landing mid-cadence.
    woke = null,
    // What is armed AFTER this wake. Passed explicitly by a read that just rewrote the set, because
    // the entity in hand still carries the one being replaced.
    armed: armedIn = null,
} = {}) {
    const at   = new Date(nowMs).toISOString()
    const noun = entity?.kind ?? 'call'
    // What is armed AFTER this wake, and how many conjunctive guards held on time but not on price
    // since the last entry. Both read off the entity rather than passed per call site, so every
    // branch below carries them without six call sites remembering to.
    const armed   = Array.isArray(armedIn) ? armedIn
        : (Array.isArray(entity?.monitor_state?.guards) ? entity.monitor_state.guards : null)
    const skipped = Number(woke?.skipped) > 0 ? Number(woke.skipped) : 0

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
    // A wake that reached no premise. Under guards this is a TIMER that came back and found nothing
    // — the price levels are still armed and still watched by the sweep between now and next time,
    // which is why the line says what it is watching rather than only when it will stir.
    if (reason === 'guard_time' || reason === 'backstop') {
        const ll  = levelsLabel(entity)
        const gap = gapMin(nextAt, nowMs)
        return { at, reason, price: toNum(price), verdict: null,
            note: `Price ${_fmt(price)} — nothing at my level${ll.multi ? 's' : ''} ${ll.text}`
                + `${skipped ? `. ${skipped} timer wake${skipped === 1 ? '' : 's'} passed without a look` : ''}`
                + `${gap ? ` — back in ${gap}m unless something moves` : '.'}`,
            ..._guardFields({ woke, armed, skipped }),
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
        ..._guardFields({ woke, armed, skipped }),
        next_check_at: nextAt,
    }
}

/**
 * The wake-and-watch half of an entry, omitted entirely when there is nothing to say.
 *
 * OMITTED, NOT NULLED: these ride in a capped array on every setup document, and three null keys on
 * every line of fifty is storage bought for nothing. A reader tolerating their absence is cheaper
 * than a document carrying their emptiness.
 *
 * `armed_at` is what makes `fired` worth recording at all — it says the line was drawn deliberately,
 * hours earlier, rather than stumbled into.
 */
function _guardFields({ woke, armed, skipped }) {
    return {
        ...(woke ? { fired: { price: woke.price ?? null, direction: woke.direction ?? null,
                              means: woke.means ?? null, armed_at: woke.armed_at ?? null } } : {}),
        ...(armed?.length ? { armed } : {}),
        ...(skipped ? { skipped } : {}),
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
