// The shared entity envelope — the ONLY shape services (monitor loop, reconciler, trades
// ledger, notify, WS/SSE) are allowed to touch. Per-kind logic lives in the payload + its
// evaluator/prompt/card renderer, never here. See docs/architecture/entity-model.md.
//
// Invariant / success test: adding a 4th kind = a new payload + evaluator + prompt + card,
// with ZERO change to any service that consumes an Envelope.

/**
 * The execution-tier kinds. Each is one flat doc in the `entities` collection.
 *
 * `setup` belongs here as much as the other three — it lives in `entities`, carries brokerOrders
 * and exitOrders, and goes through positionManage like any of them. It was missing, which made
 * `isKind('setup')` answer false about a kind that plainly exists.
 *
 * NOT here, and deliberately: `coverage` and `scan` are research artifacts in their own collections
 * with no execution, and `portfolio` is not a kind at all — a book is the SET of items carrying its
 * portfolioId, never a document. `portfolio_item` is the holding; the two are different things and
 * the watchlist/chat vocabulary that says `portfolio` is naming the book, not misspelling this.
 */
export const KINDS = Object.freeze({
    IDEA:           'idea',
    CALL:           'call',
    SETUP:          'setup',
    PORTFOLIO_ITEM: 'portfolio_item',
})

/**
 * The monitor that owns a kind BY NAME — derived, never stored (open-decision #5 in
 * docs/architecture/entity-model.md).
 *
 * `null` MEANS "NO KIND-SPECIFIC OWNER", NOT "UNWATCHED", and the difference has grown teeth. When
 * this map was written, a kind had one monitor or none. Since 2026-08-18 the entry and exit loops
 * are KIND-BLIND — both select `{ kind: { $ne: 'setup' } }` — so an `idea` and a `portfolio_item`
 * are watched by loops this map cannot name, because the answer is not one monitor.
 *
 * That is why `idea` still reads null while ideas are, in fact, being watched. Reading null as
 * "nothing is looking at this" would now be wrong in the dangerous direction, and the map's old
 * comment said exactly that. A caller asking who to blame for a stale entity has to look at the
 * kind-blind loops too.
 *
 * `setup` reads 'talos', which is true and specific: Talos polls kind:'setup' exclusively, and the
 * entry and exit loops both exclude it. It was absent entirely before, so this answered null about
 * a kind with a real, named owner — the confident wrong answer this map's own note warns about.
 */
const OWNER_BY_KIND = Object.freeze({
    [KINDS.IDEA]:           null,     // entry + exit loops, kind-blind
    [KINDS.CALL]:           null,     // Hermes archived with Kairos; nothing authors one
    [KINDS.SETUP]:          'talos',
    [KINDS.PORTFOLIO_ITEM]: 'themis',
})

/**
 * @returns {'themis'|'talos'|null} the monitor named for this kind, or null when no single monitor
 *   owns it. Null does NOT mean unwatched — see the note above.
 */
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
