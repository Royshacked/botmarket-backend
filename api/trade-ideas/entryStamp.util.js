import { STATUS } from '../../services/entity/vocabulary.js'

/**
 * THE post-fill stamp — what an entity looks like the moment it is IN a position, whoever put it
 * there. Three writers used to spell it out separately: broker placement (placeOrdersForIdea), the
 * user's manual fill report (confirmManualEntry) and a leg born already live (bornLiveStamp). The
 * fields are the same claim in every case — the direction is now a status, the entry is placed and
 * activated at `at`, these are the broker links, and this is the research it was opened on — and
 * three copies of one claim is how one of them ends up missing a field.
 *
 * `ordersPlacedAt` is also the double-place guard: every placement path refuses when it is set.
 *
 * Pure. Callers add what is theirs: placement adds `brokerSymbol` and the exit routing, a manual
 * fill adds the confirmed `quantity` and its monitor flags, a born-live leg adds `entryTriggeredAt`.
 *
 * @param {{ direction: string|null, brokerOrders: object[], at: number, researchBasis?: object|null }} p
 */
export function placedStamp({ direction, brokerOrders, at, researchBasis = null }) {
    return {
        status:         direction === 'short' ? STATUS.SHORT : STATUS.LONG,
        ordersPlacedAt: at,
        activatedAt:    at,
        orderState:     'placed',
        brokerOrders,
        // The research we're opening ON, frozen for the life of the position (coverage.service).
        ...(researchBasis ? { research_basis: researchBasis } : {}),
    }
}
