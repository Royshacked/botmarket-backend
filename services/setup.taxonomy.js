// The AUTHORING TAXONOMY — the closed sets an entry, a stop and a target are chosen FROM.
//
// "Is there a better way into this trade?" is unanswerable as an open search and trivial against a
// closed set (docs/design/mentor-challenge.md §1). There are about eight ways anybody enters a
// trade, five things a stop anchors to, five things a target anchors to. Naming the member chosen
// does two things nothing in the app could do before:
//
//   "why THAT stop?"      → a citation — `structure`, the last swing at 234.8 — instead of prose
//   "what else was there?" → a finite list the plan can be made to answer for, one clause each
//
// SMALL ON PURPOSE. Eight archetypes is a real cover of how people enter; fifteen would make the
// rejection list noise, and a taxonomy too long to hold in the head is one that gets filed at
// random. Every id below is a way in that changes where the stop belongs — which is the test for
// whether it earns a place, since two "archetypes" sharing an invalidation are one archetype.
//
// NOT PER LENS, though the vocabularies lean — order blocks and sweeps are `smc` words, relative
// strength is the `institutional` read. Per-lens sets would mean two plans under two lenses could
// not be compared, and the lens is itself challengeable: the moment it changed, a per-lens
// archetype would have to be re-filed for a plan that had not moved.
//
// The glosses describe a LONG and mirror exactly for a short.
//
// The prose mirror lives in prompts/mentor_system_prompt.md: the model reads that, the schema
// normalises against this, and a drift test keeps the two spellings identical. Filing an archetype
// is Mentor's read of the plan and never a question put to the user — the same rule `trade_mode`
// already follows.
//
// Pure — no IO, no model calls, no clock.

/** The ways in. A plan's scenario names exactly one. */
export const ENTRY_ARCHETYPES = [
    'pullback',              // a retrace into a level that held before — the fill sits BELOW price
    'breakout',              // through a pre-defined trigger, at or above price
    'retest',                // the return to a level already broken — the second chance
    'sweep_reclaim',         // a push through the level that closes back inside it
    'fade',                  // against an extended move, into a level expected to reject
    'gap_fill',              // the fill of a gap or an unfilled imbalance
    'momentum_continuation', // no level — strength inside an established trend
    'event_gated',           // contingent on a dated catalyst landing; price is secondary
]

/**
 * What a stop is measured FROM. The anchor is the reason the price is that price, and it is what a
 * user challenges instead of arguing with a number: a `volatility` stop on a name whose structure
 * sits closer is a wider risk than the chart asked for.
 */
export const STOP_ANCHORS = [
    'structure',  // the last swing that would have to break
    'level',      // the far side of the level being traded — an order block's edge, a shelf
    'session',    // a prior-session line: PDL/PDH, the week's low, the open
    'volatility', // an ATR multiple from the entry — the anchor of last resort, not of first choice
    'indicator',  // the moving average or VWAP the thesis lives above
]

/**
 * What a target is measured TO. `r_multiple` is included and is the weakest of the five: a price
 * chosen for its arithmetic rather than for anything on the chart. It is honest when nothing above
 * is structural, and it is the one to challenge first when something is.
 */
export const TARGET_ANCHORS = [
    'liquidity',     // the next pool — resting stops, an untested high
    'structure',     // the next swing or supply shelf
    'measured_move', // the pattern's own projection
    'session',       // a prior-session line or a round number the tape respects
    'r_multiple',    // a fixed multiple of the risk, with no level under it
]

// ─── Siblings — the continuation of a way in ───────────────────────────────────
//
// When price leaves without filling the entry, the redraw conversation has to start somewhere, and
// the honest starting point is archetype-shaped: a missed `pullback` is usually a `retest` of the
// level that broke, and a missed `fade` is usually not a trade at all in that direction.
//
// This is a PROMPT AID, not a generator. Nothing here authors a price — the level the sibling needs
// is measured when price has actually printed it (docs/design/mentor-challenge.md §3, and the
// desk's own "live before levels"). A sibling is which question Mentor asks at the redraw, not what
// it answers.
//
// `null` is a real and common answer, and the three ways it happens are worth telling apart:
//
//   already on the momentum path  — `breakout`, `retest`, `event_gated`. There is nothing to
//                                   continue into; the move IS the premise, and it left.
//   the continuation is the other side — `fade`. A fade that runs away is evidence for the
//                                   opposite direction, which is a new plan and not this one's
//                                   sibling. Offering one here would walk a user into a reversal
//                                   trade wearing the label of the trade they just missed.
//   no structure to continue from — `gap_fill` past its gap has only momentum left, which is an
//                                   honest sibling but a thin one.
export const SIBLINGS = {
    pullback:              'retest',                // `breakout` is the user's alternative — worse fill, no wait
    sweep_reclaim:         'retest',                // of the level that was reclaimed
    gap_fill:              'momentum_continuation',
    breakout:              null,
    retest:                null,
    fade:                  null,
    momentum_continuation: null,
    event_gated:           null,
}

/**
 * The one matcher every taxonomy field goes through: a member of `list`, or null.
 *
 * ONE function rather than three `normalizeArchetype`-shaped copies, because the tolerance IS the
 * mechanism and not the judgment (CLAUDE.md): trim and case are spelling, a model that emits
 * `"Pullback"` means `pullback`, and whether that spelling is acceptable cannot be allowed to differ
 * between the archetype and the two anchor fields.
 *
 * A non-member degrades to null rather than throwing, which is the house rule for everything the
 * model authors — an unknown lens falls back, an unreadable leg is dropped, and the draft still
 * renders. Filing an archetype wrong must never cost the user the worksheet.
 *
 * Pure.
 */
export function normalizeTaxon(list, raw) {
    const id = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    return id && Array.isArray(list) && list.includes(id) ? id : null
}

/**
 * The continuation archetype for a way in that never filled, or null when there isn't one.
 *
 * Tolerant of junk by design — an unknown or missing archetype is "no sibling", never a throw. The
 * caller is a conversation, and a plan filed before this taxonomy existed must still be re-openable.
 * Going through `normalizeTaxon` is also what keeps an inherited object key (`toString`) from
 * resolving to something that is not an archetype at all.
 *
 * Pure.
 */
export function siblingOf(archetype) {
    const id = normalizeTaxon(ENTRY_ARCHETYPES, archetype)
    return id ? SIBLINGS[id] : null
}
