// What one desk hands another inside a chain (unified-chat plan phase 5c, G3) — ported from the client's
// services/pipeline/artifact.js with the two kinds that are LIVE. `mandate` and `scan_request` had no
// producer left and were not ported; their client copies leave in phase 7.
//
// Keyed by KIND — what it is — never by where it goes: who receives a kind is contracts.receiverOf's call.
// `from` is provenance, not routing.

export const KIND = Object.freeze({
    CANDIDATE_LIST: 'candidate_list',   // Argus → Mentor (one pick) | Argus → Prometheus (a research queue)
    COVERAGE_SET:   'coverage_set',     // Prometheus → Atlas: what came back with a thesis
})

// An EMPTY artifact is a result, not an absence — a sleeve that screened to nothing is a decision for the
// desk downstream.
export const STATUS = Object.freeze({ FILLED: 'filled', EMPTY: 'empty', PARTIAL: 'partial' })

let _seq = 0

export function makeArtifact({ kind, items = [], context = {}, from = null, status = null, note = null }) {
    if (!Object.values(KIND).includes(kind)) throw new Error(`unknown artifact kind: ${kind}`)
    const list = Array.isArray(items) ? items : []
    return {
        kind,
        items:   list,
        context: context && typeof context === 'object' ? context : {},
        from,
        status:  status ?? (list.length ? STATUS.FILLED : STATUS.EMPTY),
        note,
        key:     `${Date.now()}-${++_seq}`,
    }
}
