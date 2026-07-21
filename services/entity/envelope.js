// The shared entity envelope — the ONLY shape services (monitor loop, reconciler, trades
// ledger, notify, WS/SSE) are allowed to touch. Per-kind logic lives in the payload + its
// evaluator/prompt/card renderer, never here. See ENTITY_MODEL.md.
//
// Invariant / success test: adding a 4th kind = a new payload + evaluator + prompt + card,
// with ZERO change to any service that consumes an Envelope.

/** The execution-tier kinds. Each is one flat doc in the `entities` collection. */
export const KINDS = Object.freeze({
    IDEA:           'idea',
    CALL:           'call',
    PORTFOLIO_ITEM: 'portfolio_item',
})

/**
 * Owner is DERIVED from kind, never stored (open-decision #5 in ENTITY_MODEL.md).
 * portfolio_item → themis at the item tier; the book aggregate is assessed by themis too.
 */
const OWNER_BY_KIND = Object.freeze({
    [KINDS.IDEA]:           'minos',
    [KINDS.CALL]:           'hermes',
    [KINDS.PORTFOLIO_ITEM]: 'themis',
})

/** @returns {'minos'|'hermes'|'themis'|null} the monitor that owns this kind. */
export function ownerForKind(kind) {
    return OWNER_BY_KIND[kind] ?? null
}

export function isKind(kind) {
    return Object.values(KINDS).includes(kind)
}

/**
 * Derive an entity's kind from a legacy idea doc: a holding (carries portfolioId) is a
 * portfolio_item; everything else is an idea. The single rule used by the migration, insert-time
 * stamping, and the toEnvelope adapter — keep them in sync.
 */
export function kindForDoc(doc) {
    return doc?.portfolioId != null ? KINDS.PORTFOLIO_ITEM : KINDS.IDEA
}

/** A fresh, empty monitor_state — the single shape carried by every kind (open-decision #4). */
export function blankMonitorState() {
    return { nextCheckAt: null, checkCount: 0, memo: null, timeline: [] }
}

/**
 * The canonical envelope shape, for reference (plain object, not a class — matches the
 * codebase's data-as-plain-doc style). Adapters in toEnvelope.js produce this from legacy docs.
 *
 * @typedef {Object} Envelope
 * @property {string}  id
 * @property {'idea'|'call'|'portfolio_item'} kind
 * @property {string|null}  userId
 * @property {string|null}  parentId      book id for portfolio_item, else null
 * @property {string|null}  status
 * @property {string|null}  owner         derived via ownerForKind
 * @property {string}       asset
 * @property {string|null}  assetClass
 * @property {string|null}  direction     long|short (idea/portfolio_item) | long|short|both (call)
 * @property {number|null}  createdAt
 * @property {Object}       monitorState  { nextCheckAt, checkCount, memo, timeline[] }
 * @property {Object}       execution     { broker, accounts[], mainAccountId, brokerSymbol,
 *                                          basisOffset, orderState, brokerOrders[] }
 * @property {Object}       sizing        { unit, requested, resolvedQty }
 * @property {Object}       payload       opaque, per-kind
 */

/** Canonical, empty execution binding — the block the blind execution path reads/writes. */
export function blankExecution() {
    return {
        broker:        null,
        accounts:      [],
        mainAccountId: null,
        brokerSymbol:  null,
        basisOffset:   0,
        orderState:    null,
        brokerOrders:  [],
    }
}
