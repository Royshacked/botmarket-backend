// Read a stored `entities` doc and present it as the canonical Envelope, so the execution path can
// be envelope-blind. The reverse (envelope → write) is intentionally NOT here yet — it lands
// per-kind at P4. Both collections were folded into `entities` (P2 ideas, P3a calls), so this is no
// longer a strangler bridge over legacy storage; it is the read adapter for the shape difference
// that remains between an idea's payload and a call's.
//
// Casing note: idea docs are camelCase (userId, mainAccountId, brokerSymbol); a call's PAYLOAD is
// snake_case (main_account_id, broker_symbol) and the adapters absorb that, so no service ever
// branches on kind to read a field. ENVELOPE fields do not diverge: `userId` is stored under that
// one name by every kind (see scripts/migrate-call-userid.mjs) — do not reintroduce a per-kind alias.

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
 * A call doc → Envelope. The call IS the entity, execution included: since P3b a confirmed call
 * carries its own orderState / brokerOrders (kairos.handoff merges the execution shape onto the
 * call rather than minting an idea shadow), so this reads them straight off the doc.
 *
 * @param {Object} doc  raw `entities` document, kind:'call' (post-normalizeCall shape)
 * @returns {import('./envelope.js').Envelope}
 */
export function callToEnvelope(doc) {
    if (!doc) return null
    const ms = doc.monitor_state ?? {}
    return {
        id:         doc.id,
        kind:       KINDS.CALL,
        userId:     doc.userId ?? null,           // envelope field — camelCase on the doc too
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
            // P3b: a confirmed call carries its OWN execution — kairos.handoff merges the shape
            // onto the call doc rather than minting an idea shadow. These read the call directly;
            // hard-coding null/[] here (as this did pre-P3b) reports a live, linked call as
            // unlinked, which is how a position silently loses its owner.
            orderState:    doc.orderState ?? null,
            brokerOrders:  Array.isArray(doc.brokerOrders) ? doc.brokerOrders : []
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
