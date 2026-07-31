// The chores every readiness monitor does before it can think.
//
// Hermes watches calls, Talos watches setups, and WHAT THEY THINK ABOUT is genuinely different —
// different questions, different data, different decisions. That part stays apart. But before
// either can think, both answer the same handful of clock-and-arithmetic questions, and both used
// to carry a private copy of every one:
//
//   is it too early to watch this yet?   is it past its expiry?   how soon should I look again?
//   does the model's verdict survive the clock?   what status does this verdict imply?
//
// COPIES ROT. Talos was written by copying Hermes, and in the copying its "too early" chore gained
// one extra line — it also disarmed the entity. Hermes doesn't. So every setup with a future
// `active_from` went to sleep and never woke, because the thing that wakes them only looks at armed
// ones. One wrong word in a copy of a chore. The expiry chore went the other way: Hermes had it,
// Talos didn't, so expired setups paid for a full vision assessment every cadence forever.
//
// WHAT IS NOT UNIFIED, and deliberately. Where the two monitors genuinely disagree, the difference
// is a PARAMETER here rather than a second implementation elsewhere — so it stays visible and
// intentional instead of being rediscovered as a bug:
//
//   • the cadence fallback when the model names no next check (Hermes: lazy / Talos: eager)
//   • which verdicts survive a past-expiry review (Hermes spares `edit`, Talos does not)
//   • the proximity bands, and whether a zero-width zone counts as a zone at all
//
// Everything here is PURE. No IO, no DB, no clock of its own — `nowMs` is always passed in.

/**
 * Not live yet: the entity names a start time that hasn't arrived. A primary gate — an entity that
 * isn't live can't be expiring, in a zone, or anything else, so this is asked first and answered
 * without spending a single fetch.
 *
 * No `active_from`, or an unparseable one, is NOT a gate: a garbage date must never silently stop
 * something being watched.
 */
export function isPreActive(entity, nowMs) {
    const from = entity?.active_from ? Date.parse(entity.active_from) : NaN
    return Number.isFinite(from) && nowMs < from
}

/**
 * Inside the final-review window (or already past it) → time to decide whether this dies or rolls.
 *
 * NOTE it stays true for ALL TIME once past `valid_until`, which is why `isPastExpiry` +
 * `effectiveVerdict` exist: without a terminator, every later wake takes the expensive path again.
 */
export function isExpiring(entity, nowMs, thresholdMs) {
    const until = entity?.valid_until ? Date.parse(entity.valid_until) : NaN
    return Number.isFinite(until) && (until - nowMs) <= thresholdMs
}

/** Actually past `valid_until` — not merely inside the review window. */
export function isPastExpiry(entity, nowMs) {
    const until = entity?.valid_until ? Date.parse(entity.valid_until) : NaN
    return Number.isFinite(until) && nowMs >= until
}

/**
 * Reconcile the model's verdict against WHY we woke and what the clock says. Two cases the model
 * cannot be trusted to get right on its own:
 *
 *   • `let_expire` on a ZONE TRIP would terminally kill an entity still inside its validity window.
 *     It is only on the menu for an expiry review → downgrade to `stand_aside`.
 *
 *   • An expiry review that is genuinely PAST `valid_until` but still won't commit (wait /
 *     stand_aside) leaves the entity alive, and since `isExpiring` never goes false again, the next
 *     wake pays for another full read — forever, on a plan whose window has closed. Force
 *     `let_expire` so it terminates.
 *
 * `spare` is the per-monitor judgment: which verdicts are allowed to survive that cutoff. Both
 * spare `enter` (a trigger that prints in the final minutes is still a real trigger). Hermes also
 * spares `edit`, because an edit LATCHES its invalidation axis and so cannot re-fire; a monitor
 * without that latch must not spare it, or the forever-loop simply reopens under another verdict.
 */
export function effectiveVerdict(verdict, reason, pastExpiry, spare = ['enter']) {
    if (verdict === 'let_expire' && reason !== 'expiry_review') return 'stand_aside'
    if (reason === 'expiry_review' && pastExpiry && !spare.includes(verdict)) return 'let_expire'
    return verdict
}

/**
 * The status a verdict implies. Only ENTRY moves the lifecycle: a stale thesis or a damaged premise
 * is the INVALIDATION axis, which is orthogonal and latches separately.
 */
export function nextStatus(verdict) {
    return verdict === 'enter' ? 'hit' : 'looking'
}

/**
 * Clamp the model's self-chosen gap (minutes) into the entity's cadence band.
 *
 * `fallback` is what a missing or junk request means, and the two monitors answer it differently on
 * purpose: a call falls back to the LAZY end (don't burn quota re-reading a quiet name), a setup to
 * the EAGER end (its cadence band is already horizon-scaled, so the floor is cheap). Passing it in
 * keeps that a stated choice rather than a discrepancy between two copies.
 */
export function clampGap(requestedMin, { min, max, fallback = max }) {
    const asked = Number(requestedMin)
    if (!Number.isFinite(asked)) return fallback
    return Math.min(Math.max(asked, min), max)
}

/**
 * Graded cadence: poll lazily when price is far from every zone and tighten as it approaches, so a
 * fast run into a zone isn't slept through by a timer set when price was miles away.
 *
 * Takes a DISTANCE ALREADY MEASURED IN ZONE WIDTHS, not the entity — because measuring it is where
 * the monitors legitimately differ (one ignores a zero-width zone, the other treats it as an exact
 * level worth measuring to). Sharing the interpolation without sharing the measurement is the whole
 * point: the fiddly part is common, the judgment stays local.
 *
 * `null` distance (no price, no usable zone) → the lazy end: polling flat-out on a broken feed
 * burns quota for nothing.
 */
export function gradedGap(distance, { min, max, near, far }) {
    if (!Number.isFinite(distance)) return max
    if (distance <= near) return min
    if (distance >= far)  return max
    return Math.round(min + ((distance - near) / (far - near)) * (max - min))
}
