// WHICH TIER a wake runs on. Pure — no IO, no clock, no loop.
//
// docs/design/talos-two-tier.md §Phase 5. Talos wakes on every candle close; what this decides is
// what that wake COSTS: nothing, one cheap model call, or the full read.
//
// THE COUNTDOWN IS THE MECHANISM, and it is the expensive read's own. Every expensive read declares
// `next_expensive_in` — how many closes before this setup is worth looking at properly again — and
// that is a MATURITY estimate, not a budget: a head-and-shoulders with one shoulder printed needs a
// head, a right shoulder and a neckline break, the read knows it the moment it looks, and nothing
// that isn't a model could work it out. The closes in between are cheap, or free.
//
// WHY `read_mode` BARELY APPEARS HERE. Of the five modes, only `cheap_only` and `expensive_only` are
// overrides; `cheap_then_expensive`, `expensive_then_cheap` and `both` are the SAME machine from
// different starting points, and which one a setup is in falls out of what its reads keep asking
// for. A setup whose structural precondition has not settled gets `next_expensive_in: 1` from its
// own reads and is thereby "expensive_then_cheap" without anything having to say so.

/** A wake that is never triaged, whatever the mode says. */
const ALWAYS_EXPENSIVE_REASONS = new Set([
    // A scheduled decision, not a "did something happen" question. The 95-read replay found this
    // the hard way: the cheap tier's one missed action was a let_expire it slept through.
    'expiry_review',
    // Nothing has ever been read, so there is no `watch`, no countdown and nothing to triage
    // against. The first look is always the full one.
    'first_look',
])

/**
 * Which tier this wake runs on: `'expensive'` · `'cheap'` · `'sleep'`.
 *
 * @param {object} setup
 * @param {object} ctx  `{ reason, woke }` — the wake kind, and the guard that caused it if any
 */
export function tierFor(setup, { reason, woke } = {}) {
    if (ALWAYS_EXPENSIVE_REASONS.has(reason)) return 'expensive'

    // A fired price guard is the model's OWN alarm — it armed that level precisely because it
    // wanted waking there. Triaging it would be asking a cheaper model to second-guess the
    // expensive one's stated reason for being woken.
    if (woke) return 'expensive'

    const ms = setup?.monitor_state ?? {}
    if (setup?.read_mode === 'expensive_only') return 'expensive'

    // `cheap_only` never runs the expensive read ON A SCHEDULE — but it still ESCALATES, because
    // the cheap tier's answer to a condition it cannot settle is `unknown`, and a setup that can
    // never be looked at properly is one bad `not_fired` away from a missed trade. (The plan's
    // Open decision 3, resolved towards the safe variant: the floor is a first look, an expiry
    // review, a fired guard, and any escalation the cheap read itself asks for.)
    //
    // It also never sleeps: `cheapWatch` falls back to the premise rung, so this tier can run
    // without an expensive read ever having declared a watch.
    if (setup?.read_mode === 'cheap_only') return 'cheap'

    // The countdown the last expensive read set. Absent or elapsed → it is due. This is also what
    // makes "an expensive read has never run" resolve to `expensive` rather than to the sleep
    // branch below — only an expensive read ever writes `expensive_due`.
    const due = Number(ms.expensive_due)
    if (!(due > 0)) return 'expensive'

    // Between expensive reads. `watch` is what the last one left for this tier to check; declaring
    // NULL is a real answer — "no numbers-only pass could usefully check anything here" — and the
    // setup then costs nothing at all until the countdown elapses or a guard fires.
    return ms.watch ? 'cheap' : 'sleep'
}

/** Most closes an expensive read may push its own next look out by. */
export const MAX_EXPENSIVE_GAP = 24

/**
 * The countdown a read asked for, held to something sane. Absent/junk → 1, which means "read me
 * again next close" — the old behaviour, and the safe direction for a field the model may simply
 * not fill in.
 *
 * The CAP is the backstop for a setup whose completion has no price. Most chart patterns finish AT
 * a level — a neckline, a prior high — and a guard covers those exactly; "RSI divergence forming"
 * or "volume drying up" have nothing to arm a guard at, and this is all that stands behind them.
 * Pure.
 */
export function clampExpensiveGap(n) {
    const v = Math.trunc(Number(n))
    if (!Number.isFinite(v) || v < 1) return 1
    return Math.min(v, MAX_EXPENSIVE_GAP)
}

/**
 * What a CHEAP wake writes to the countdown: one closer. Floors at 0 rather than going negative, so
 * a document that sat through a restart cannot come back owing reads. Pure.
 */
export function tickExpensiveDue(setup) {
    const due = Number(setup?.monitor_state?.expensive_due)
    return Number.isFinite(due) && due > 1 ? due - 1 : 0
}
