// Strangler bridge: read a LEGACY doc (an `ideas`-collection idea, a `kairos_calls` call) and
// present it as the canonical Envelope, WITHOUT migrating storage. This is what lets P1 make the
// execution path envelope-blind while data still lives in the old collections. The reverse
// (envelope → collection write) is intentionally NOT here yet — it lands per-kind in P2–P4.
//
// Casing note: idea docs are camelCase (userId, mainAccountId, brokerSymbol); call docs are
// snake_case (user_id, main_account_id, broker_symbol). Canonical envelope = camelCase; the
// adapters absorb the mismatch so no service ever branches on kind to read a field.

import { KINDS, ownerForKind, blankMonitorState } from './envelope.js'

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
    const kind = doc.portfolioId != null ? KINDS.PORTFOLIO_ITEM : KINDS.IDEA
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
        // Ideas have no persisted monitor_state today (Minos throttles in-memory) — empty is faithful.
        monitorState: blankMonitorState(),
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
 * A legacy kairos_call doc → Envelope. The call is the entity; its broker binding lives on the
 * call, but its LIVE order state (orderState / brokerOrders) still lives on the linked idea
 * shadow until P3 drops the shadow — so those stay null/[] here by design.
 *
 * @param {Object} doc  raw kairos_calls document (post-normalizeCall shape)
 * @returns {import('./envelope.js').Envelope}
 */
export function callToEnvelope(doc) {
    if (!doc) return null
    const ms = doc.monitor_state ?? {}
    return {
        id:         doc.id,
        kind:       KINDS.CALL,
        userId:     doc.user_id ?? null,          // snake → camel
        parentId:   null,
        status:     doc.status ?? null,
        owner:      ownerForKind(KINDS.CALL),
        asset:      doc.asset ?? '',
        assetClass: doc.asset_class ?? null,
        direction:  doc.bias ?? null,             // call expresses side as `bias`
        createdAt:  doc.savedAt ?? null,
        monitorState: {
            nextCheckAt: ms.next_check_at ?? null,
            checkCount:  ms.check_count ?? 0,
            memo:        ms.memo ?? null,
            timeline:    Array.isArray(ms.timeline) ? ms.timeline : [],
        },
        execution: {
            broker:        doc.broker ?? null,
            accounts:      Array.isArray(doc.accounts) ? doc.accounts : [],
            mainAccountId: doc.main_account_id ?? null,   // snake → camel
            brokerSymbol:  doc.broker_symbol ?? null,     // snake → camel
            basisOffset:   Number(doc.basis_offset) || 0, // snake → camel
            orderState:    null,   // lives on the idea shadow until P3
            brokerOrders:  [],     // idem
        },
        sizing: {
            unit:        doc.sizing?.unit ?? null,
            requested:   doc.sizing?.max_size ?? null,
            resolvedQty: null,
        },
        payload: doc,
    }
}

/** Dispatch by source collection tag. Extend with portfolioItemToEnvelope at P4. */
export function toEnvelope(doc, source) {
    if (source === 'call') return callToEnvelope(doc)
    return ideaToEnvelope(doc)
}
