// The clock every GRADED forecast runs on. PURE — no I/O, no DB, importable from anywhere.
//
// A forecast that can't be wrong isn't research, it's decoration. What makes one gradeable is a
// window: when the call was made, and when it comes due. This module owns that window — the horizon
// vocabulary, the arithmetic, and the one rule that keeps a living view honest:
//
//   REAFFIRMING A CALL KEEPS ITS CLOCK; CHANGING IT STARTS A NEW ONE.
//
// That rule is why `set_at` is preserved when it is already present and the deadline is always
// DERIVED, never trusted from input. A view re-examined daily would otherwise push its own deadline
// out one day at a time and never come due — which is exactly how the Analyst's price target
// behaved before it had a window at all (documented as validated, stored as free text, read by
// nothing).
//
// Two callers today: the Analyst's price target (`set_at` → `target_date`) and the strategy desk's
// per-sector stances (`set_at` → `review_date`). The deadline's FIELD NAME stays each caller's
// business — this module supplies the rule, not the schema.

/** Horizons a call may be made over. `12m` is the sell-side convention and our default. */
export const HORIZONS        = ['3m', '6m', '12m', '18m', '24m']
export const DEFAULT_HORIZON = '12m'
const HORIZON_MONTHS = { '3m': 3, '6m': 6, '12m': 12, '18m': 18, '24m': 24 }

/**
 * A horizon from the vocabulary. Anything unrecognised — a free-text `"12 months"`, an omission —
 * DEFAULTS rather than throwing: a view is worth more than its metadata, and a missing deadline
 * should become the house convention, not discard the work.
 */
export function normalizeHorizon(v) {
    return HORIZONS.includes(v) ? v : DEFAULT_HORIZON
}

/** A valid ISO instant, or null. */
export function toIso(v) {
    const ms = Date.parse(typeof v === 'string' ? v.trim() : '')
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * Add whole months to an ISO instant, clamped to the landing month's last day. Pure.
 *
 * The clamp is what stops Jan 31 + 1m landing on Mar 3: shift off the 1st, then take the smaller of
 * the original day and the landing month's length.
 */
export function addMonths(iso, months) {
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return null
    const d = new Date(ms)
    const day = d.getUTCDate()
    d.setUTCDate(1)                                   // park off the end before shifting
    d.setUTCMonth(d.getUTCMonth() + months)
    const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    d.setUTCDate(Math.min(day, lastOfMonth))
    return d.toISOString()
}

/**
 * The window a call is graded over → `{ horizon, set_at, ends_at }`. Pure.
 *
 * `set_at` survives if the input already carries one and re-stamps from `now` if it does not — which
 * is the whole reaffirm-vs-restart rule, expressed as a property of the data rather than as a flag
 * the caller has to remember to pass. It composes with an object spread: a patch that carries the
 * stored window through keeps its deadline, and a freshly authored call gets a new one.
 *
 * `ends_at` is ALWAYS derived, so a hand-written deadline can never disagree with its horizon.
 * Callers map it onto their own field name (`target_date`, `review_date`).
 */
export function openWindow({ set_at, horizon } = {}, now) {
    const h     = normalizeHorizon(horizon)
    const start = toIso(set_at) ?? now
    return { horizon: h, set_at: start, ends_at: addMonths(start, HORIZON_MONTHS[h]) }
}

/**
 * How far through its window a call is, as a fraction — 0 at the call, 1 at the deadline, >1 once
 * overdue. `null` when unknowable, and callers MUST treat that as "don't judge the timing" rather
 * than as early or late: a view written before windows existed, or checked without a clock, has to
 * behave exactly as it did before. Timing sharpens a verdict; it is never a precondition for one.
 */
export function windowProgress({ set_at, ends_at } = {}, nowMs) {
    if (!Number.isFinite(nowMs) || nowMs <= 0) return null   // no clock supplied → abstain
    const start = Date.parse(set_at ?? '')
    const end   = Date.parse(ends_at ?? '')
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
    return (nowMs - start) / (end - start)
}
