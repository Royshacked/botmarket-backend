// Read a stored `entities` doc and present it as the canonical Envelope, so the execution path can
// be envelope-blind. The reverse (envelope → write) is intentionally NOT here yet — it lands
// per-kind at P4. Ideas were folded into `entities` at P2, so this is no longer a strangler bridge
// over legacy storage; it is the read adapter for an idea's payload.
//
// Casing note: idea docs are camelCase (userId, mainAccountId, brokerSymbol). ENVELOPE fields do
// not diverge: `userId` is stored under that one name by every kind — do not reintroduce a
// per-kind alias.

import { ownerForKind, blankMonitorState, kindForDoc } from './envelope.js'

/**
 * A legacy idea doc → Envelope. A portfolio holding is, TODAY, an idea carrying `portfolioId`;
 * we surface it as kind `portfolio_item` with `parentId` set — the target model — so downstream
 * code is already blind before the physical split (P4).
 *
 * payload = the full source doc during the strangler window (non-destructive: evaluators keep
 * reading payload.entry_condition_tree etc. exactly as today). It gets trimmed to kind-specific
 * fields at the P2/P4 cutover.
 *
 * @param {Object} doc  raw idea document
 * @returns {import('./envelope.js').Envelope}
 */
export function ideaToEnvelope(doc) {
    if (!doc) return null
    // `kindForDoc`, not the rule written out again. Its own doc names the three places that must
    // agree — "the migration, insert-time stamping, and the toEnvelope adapter" — and this was the
    // one of the three keeping a private copy, which is how a list of places to keep in sync becomes
    // a list of places to fix.
    const kind = kindForDoc(doc)
    return {
        id:         doc.id,
        kind,
        userId:     doc.userId ?? null,
        parentId:   doc.portfolioId ?? null,
        status:     doc.status ?? null,
        owner:      ownerForKind(kind),
        asset:      doc.asset ?? '',
        assetClass: doc.asset_class ?? null,
        direction:  doc.direction ?? null,
        createdAt:  doc.savedAt ?? null,
        // Ideas DO have a persisted monitor_state as of 2026-08-18: the entry and exit loops both
        // schedule on `monitor_state.next_check_at`. This used to hard-blank it and say "no loop
        // polls the kind", which was true for exactly one day and is the shape of statement that
        // caused a stop to go unwatched for weeks — so it reads the document rather than asserting
        // an absence.
        //
        // `checkCount` and `memo` stay empty on purpose: those are a JOURNALLING monitor's, and
        // neither of these two journals. Blank there is still the faithful answer.
        monitorState: { ...blankMonitorState(), nextCheckAt: doc.monitor_state?.next_check_at ?? null },
        execution: {
            broker:        doc.broker ?? null,
            accounts:      Array.isArray(doc.accounts) ? doc.accounts : [],
            mainAccountId: doc.mainAccountId ?? null,
            brokerSymbol:  doc.brokerSymbol ?? null,
            basisOffset:   Number(doc.basisOffset) || 0,
            orderState:    doc.orderState ?? null,
            brokerOrders:  Array.isArray(doc.brokerOrders) ? doc.brokerOrders : [],
        },
        sizing: {
            unit:        'shares',
            requested:   doc.quantity ?? null,
            resolvedQty: doc.quantity ?? null,
        },
        payload: doc,
    }
}

/**
 * Dispatch by source collection tag. Extend with portfolioItemToEnvelope at P4.
 *
 * NO PRODUCTION CALLER TODAY: the one live consumer of this module is orderPlan.service, which calls
 * `ideaToEnvelope` directly. Recorded rather than removed — the envelope is documented architecture
 * (docs/architecture/entity-model.md) with a stated P4 cutover. Covered by entityEnvelope.test.
 */
export function toEnvelope(doc, _source) {
    return ideaToEnvelope(doc)
}
