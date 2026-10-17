// The markers on an agent's working state that the desk's own fold knows nothing about — what it is EDITING
// (seal.openForEdit: the sealed context is read on every turn, and an update seals only onto that entity) and which
// CHAIN it works for (the busy rule reads it). One rule for every writer that rebuilds a desk's state from its own
// fields: the session turn's fold, a direct edit, and a route landing on work in progress (plan phase 8a CR).

/** `next` with `prev`'s markers carried onto it. Pure; a null `next` stays null (the work is cleared). */
export function keepMarkers(next, prev) {
    if (!next) return next ?? null
    return {
        ...next,
        ...(prev?.editing ? { editing: prev.editing } : {}),
        ...(prev?.chainId ? { chainId: prev.chainId } : {}),
    }
}
