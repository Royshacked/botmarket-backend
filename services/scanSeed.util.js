// The Argus hand-off seed — ONE parser for every desk a scanned name can be handed to.
//
// A hand-off arrives as a typed object rather than free text: Argus validated the name, wrote a
// one-line thesis and a short read, and recommended the lens to build it through. Three desks now
// receive that: Kairos (`call`), Analyst (`coverage`) and Mentor (`setup`).
//
// It was two hand-written copies before this — Kairos's, and Analyst's carrying the comment
// "Mirrors Kairos's _sanitizeSeed", which is the shape duplication takes just before it drifts. They
// had ALREADY diverged in what they carried (a forward-dated window on one, a sector on the other),
// and a third copy for Mentor would have made the divergence permanent.
//
// SHARE THE PIPE, NOT THE JUDGMENT. This coerces every field a hand-off can carry and each desk
// decides what to DO with it — which is not a formality here: `recommended_mode` is deliberately
// dropped from Kairos's prompt (its lens is chosen by the caller, and the field only pre-fills a UI
// chip) and is load-bearing for Mentor, which AUTHORS `trade_mode` and must put the recommendation
// in front of the user. Same field, opposite handling, one parser.
//
// String-only and lean on purpose: this is untrusted request-body input on the way into a prompt.

/**
 * Coerce a hand-off seed. Returns null when there is no usable ticker — a seed without one names
 * nothing and is worse than absent, because a desk would open on a blank.
 *
 * Every field is optional except the ticker. A desk reads the ones it has a use for and ignores
 * the rest; nothing here decides anything.
 *
 * @param {unknown} raw
 * @returns {{ticker, direction, sector, thesis, analysis, recommended_mode, window}|null}
 */
export function sanitizeScanSeed(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    const s = k => (typeof raw[k] === 'string' && raw[k].trim() ? raw[k].trim() : null)
    const ticker = s('ticker')
    if (!ticker) return null

    // A forward-dated list's period. It rides along so a desk can NARRATE the gated window; the
    // actual time-gate is set by code at save, never from this.
    const w    = (raw.window && typeof raw.window === 'object' && !Array.isArray(raw.window)) ? raw.window : {}
    const from = (typeof w.from === 'string' && w.from.trim()) ? w.from.trim() : null
    const to   = (typeof w.to   === 'string' && w.to.trim())   ? w.to.trim()   : null

    return {
        ticker:           ticker.toUpperCase(),
        direction:        s('direction'),
        sector:           s('sector'),
        thesis:           s('thesis'),
        analysis:         s('analysis'),
        recommended_mode: s('recommended_mode'),
        window:           (from || to) ? { from, to } : null,
    }
}
