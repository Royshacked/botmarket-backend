// Shared, defensive normalizer for the `conviction` block the LLM emits on a
// trade idea, a portfolio leg, and a scan candidate. The three contracts use the
// exact same shape, so this is the single boundary that keeps a malformed/partial
// block from the model out of persistence and the UI.
//
//   { level: 'low' | 'medium' | 'high', score: 0..1, rationale: string }
//
// `level` + `rationale` are user-facing (rendered by the ConvictionChip).
// `score` is an internal 0–1 estimate kept only for later calibration against
// realized outcomes — never shown.

const LEVELS = new Set(['low', 'medium', 'high'])

/**
 * Coerce a raw conviction object into the canonical shape, or null when there's
 * nothing usable (so the chip simply doesn't render). Tolerates the model
 * omitting fields, emitting an out-of-enum level, or a non-numeric score.
 */
export function cleanConviction(raw) {
    if (!raw || typeof raw !== 'object') return null

    const level = LEVELS.has(raw.level) ? raw.level : null

    const rationale = (typeof raw.rationale === 'string' && raw.rationale.trim())
        ? raw.rationale.trim()
        : null

    const n = Number(raw.score)
    const score = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null

    // No bucket and no reason → treat as absent rather than render an empty chip.
    if (!level && !rationale) return null

    return { level, score, rationale }
}
