/**
 * cTrader execution-event translator.
 *
 * Pure ProtoOA → normalized BrokerExecution translation, split out of the adapter:
 * `toExecution` maps a ProtoOAExecutionEvent (2126) onto the shared bus contract,
 * `closeReason` infers why a position closed, and the enum tables they read live
 * here too. No adapter `this` state — the session is passed explicitly so these
 * stay pure functions the adapter can call directly.
 */

import { toAppAsset } from '../../../services/brokerSymbol.service.js'

// ProtoOA trade-side enum (sent as integers in JSON).
export const TRADE_SIDE = { long: 1, short: 2 }

// Inbound ProtoOA enums for translating ProtoOAExecutionEvent (2126).
export const EXEC_TYPE = {       // ProtoOAExecutionType
    ORDER_ACCEPTED: 2, ORDER_FILLED: 3, ORDER_CANCELLED: 5,
    ORDER_EXPIRED: 6, ORDER_REJECTED: 7, ORDER_PARTIAL_FILL: 11,
}
export const POSITION_STATUS  = { OPEN: 1, CLOSED: 2 }   // ProtoOAPositionStatus
export const PROTO_ORDER_TYPE = { LIMIT: 2, STOP: 3 }    // a TP closes via LIMIT, an SL via STOP
export const MONEY_SCALE      = 100   // ProtoOA money fields are integer cents (moneyDigits=2)

/**
 * Translate a ProtoOAExecutionEvent (2126) into a normalized BrokerExecution,
 * or null for events the reconciler doesn't care about (swaps, deposits, acks).
 * @param {import('../../../providers/ctrader.session.provider.js').CTraderSession} session
 * @param {object} p  the ProtoOAExecutionEvent payload
 * @returns {import('./broker.interface.js').BrokerExecution|null}
 */
export function toExecution(session, p) {
    const order    = p?.order ?? {}
    const deal     = p?.deal ?? {}
    const position = p?.position ?? {}
    const closeDetail = deal.closePositionDetail ?? null

    const positionId = position.positionId ?? deal.positionId ?? order.positionId
    const symbolId   = order.tradeData?.symbolId ?? position.tradeData?.symbolId
    const tradeSide  = position.tradeData?.tradeSide ?? order.tradeData?.tradeSide
    // Per-fill commission cost (deal.commission is signed integer cents) → absolute amount.
    const commission = deal.commission != null ? Math.abs(deal.commission / MONEY_SCALE) : undefined

    // Reverse the broker symbol back to the app's canonical asset (e.g. US100 →
    // NQ) so the reconciler can match `exec.symbol` to the idea's stored `asset`.
    const brokerName = symbolId != null ? session.symbolNameById(symbolId) : null
    const appAsset   = brokerName ? toAppAsset('ctrader', brokerName) : null

    const base = {
        broker:    'ctrader',
        accountId: String(p?.ctidTraderAccountId ?? session.ctid),
        at:        Number(deal.executionTimestamp ?? p?.timestamp ?? Date.now()),
        ...(order.orderId   != null && { orderId:    String(order.orderId) }),
        ...(positionId      != null && { positionId: String(positionId) }),
        ...(appAsset        != null && { symbol: appAsset }),
        ...(tradeSide       != null && { direction: tradeSide === TRADE_SIDE.short ? 'short' : 'long' }),
    }

    switch (p?.executionType) {
        case EXEC_TYPE.ORDER_REJECTED:
            return { ...base, type: 'order.rejected' }
        case EXEC_TYPE.ORDER_CANCELLED:
        case EXEC_TYPE.ORDER_EXPIRED:
            return { ...base, type: 'order.cancelled' }
        case EXEC_TYPE.ORDER_FILLED:
        case EXEC_TYPE.ORDER_PARTIAL_FILL: {
            const fullyClosed = position.positionStatus === POSITION_STATUS.CLOSED
            const closing = fullyClosed || order.closingOrder === true || closeDetail != null
            if (closing) {
                // A partial close (position still OPEN) must NOT close the idea — it's
                // one slice of a multi-level exit. Report it as position.reduced so the
                // reconciler records the slice and re-syncs the remaining exit orders;
                // only a full close (positionStatus CLOSED) flips the idea to closed.
                return {
                    ...base,
                    type:   fullyClosed ? 'position.closed' : 'position.reduced',
                    reason: closeReason(order),
                    ...(deal.executionPrice != null && { price: deal.executionPrice }),
                    ...(deal.filledVolume   != null && { quantity: deal.filledVolume }),
                    ...(closeDetail?.profit != null && { pnl: closeDetail.profit / MONEY_SCALE }),
                    ...(commission != null && { commission }),
                }
            }
            // A fill that doesn't close → a new/added position.
            return {
                ...base,
                type: position.positionStatus === POSITION_STATUS.OPEN ? 'position.opened' : 'order.filled',
                ...(deal.executionPrice  != null && { price: deal.executionPrice }),
                ...(deal.filledVolume    != null && { quantity: deal.filledVolume }),
                ...(position.stopLoss    != null && { stopLoss: position.stopLoss }),
                ...(position.takeProfit  != null && { takeProfit: position.takeProfit }),
                ...(commission != null && { commission }),
            }
        }
        default:
            return null   // ORDER_ACCEPTED, SWAP, DEPOSIT_WITHDRAW, … — not reconciled
    }
}

// Infer why a position closed from the order that closed it: a native take-profit
// is a LIMIT order, a native stop-loss is a STOP order; anything else (a manual
// market close) we can't attribute, so report 'manual'.
export function closeReason(order) {
    if (order?.orderType === PROTO_ORDER_TYPE.LIMIT) return 'tp'
    if (order?.orderType === PROTO_ORDER_TYPE.STOP)  return 'stop'
    return 'manual'
}
