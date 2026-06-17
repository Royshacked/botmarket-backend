/**
 * Server-side order-plan builder.
 *
 * Resolves an idea's account IDs against the user's live broker accounts and
 * computes the per-account order quantities. The main account (idea.mainAccountId)
 * trades the raw quantity; every other account scales by its balance ratio to the
 * main account. Building this server-side means the plan no longer depends on the
 * browser, and can be acted on by the monitor (deferred / auto modes).
 */

import { brokerService } from '../api/broker/broker.service.js'
import { logger }        from './logger.service.js'

const LOG = '[orderPlan]'

/**
 * Resolve a set of account IDs to live account info across the user's connected
 * brokers, tagging each with the broker it belongs to. The single source for
 * account→broker resolution — shared by the order-plan builder and the idea fork.
 * @param {string} userId
 * @param {Iterable<string|number>} wantedIds
 * @returns {Promise<Map<string, object>>}  id → { ...account, broker }
 */
export async function resolveUserAccounts(userId, wantedIds) {
    const want = new Set([...wantedIds].map(String))
    const byId = new Map()
    if (want.size === 0) return byId

    const connections = await brokerService.listConnections(userId)
    for (const [broker, connected] of Object.entries(connections)) {
        if (!connected) continue
        const { accounts: accs = [] } = await brokerService.getTradingAccounts(broker, userId)
        for (const a of accs) {
            const id = String(a.id)
            if (want.has(id)) byId.set(id, { ...a, broker })
        }
    }
    return byId
}

/**
 * @param {object} idea  must carry accounts[], mainAccountId, quantity, userId
 * @returns {Promise<Array<{ broker, accountId, accountNo, quantity, type }>>}
 *          `type` is the broker execution type — always 'market' for a confirmed
 *          entry (NOT idea.type, which is the trade STYLE: intraday/swing/scalp).
 */
export async function buildOrderPlanForIdea(idea) {
    const { accounts, mainAccountId, quantity, userId } = idea
    if (!Array.isArray(accounts) || accounts.length === 0) return []

    const wantedIds = new Set(accounts.map(a => String(typeof a === 'object' ? a.id : a)))

    // Resolve account IDs → live account info across the user's connected brokers
    let byId
    try {
        byId = await resolveUserAccounts(userId, wantedIds)
    } catch (err) {
        logger.error(LOG, `Failed to resolve accounts for idea ${idea.id}: ${err.message}`)
        return []
    }

    const mainId   = mainAccountId != null ? String(mainAccountId) : [...wantedIds][0]
    const mainAcct = byId.get(mainId)
    const baseQty  = Number(quantity) || 0

    const plan = []
    for (const id of wantedIds) {
        const acct = byId.get(id)
        if (!acct) continue
        const isMain = id === mainId
        const ratio  = (!isMain && mainAcct?.balance && acct.balance)
            ? acct.balance / mainAcct.balance
            : 1
        plan.push({
            broker:    acct.broker,
            accountId: id,
            accountNo: acct.login ?? id,
            quantity:  Math.round(baseQty * ratio * 10000) / 10000,
            type:      'market',
        })
    }
    return plan
}
