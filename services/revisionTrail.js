// The append-only trail that makes a view LIVING rather than merely current. PURE.
//
// A research artifact's value is not only what it says today — it is what we believed, when, and
// what changed our mind. Every desk that maintains a standing view keeps the same trail: the
// Analyst's coverage (rating and target changes, re-models, verdicts) and the strategy desk's
// sector stances (reaffirmed, tilted, closed out). Two callers, one shape, so the shape lives here.
//
// APPEND-ONLY is the whole point. An entry is never edited or removed, and a revision that records
// "nothing changed" is still worth writing when the view was genuinely re-examined — a trail with
// gaps can't distinguish "we held the view" from "nobody looked".

/** A trimmed string, or null. */
const _str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * One entry in the trail → `{ at, kind, note, changed }`. Pure.
 *
 * `kind` is the event in the desk's own vocabulary ('initiate' | 'remodel' | 'rating_change' |
 * 'target_hit' | 'publish' | 'reaffirm' | …) — deliberately not an enum here, because what counts
 * as an event is the desk's judgment, while the entry's SHAPE is the shared mechanism.
 * `changed` is a `{field: {from, to}}` diff.
 */
export function newRevision({ kind = null, note = null, changed = null, at = null } = {}) {
    return {
        at:      _str(at) ?? new Date().toISOString(),
        kind:    _str(kind),
        note:    _str(note),
        changed: (changed && typeof changed === 'object' && !Array.isArray(changed)) ? changed : null,
    }
}

/**
 * Shallow diff over the fields worth logging → `{field: {from, to}}`, or null when nothing moved.
 * Compared by value (JSON), so a nested object that was rebuilt but is identical does not read as a
 * change — otherwise every re-normalisation would look like a revision.
 */
export function diffFields(prev, next, fields = []) {
    const changed = {}
    for (const k of fields) {
        if (JSON.stringify(prev?.[k] ?? null) !== JSON.stringify(next?.[k] ?? null)) {
            changed[k] = { from: prev?.[k] ?? null, to: next?.[k] ?? null }
        }
    }
    return Object.keys(changed).length ? changed : null
}
