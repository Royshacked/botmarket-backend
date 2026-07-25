/**
 * Server-side order-plan builder.
 *
 * Resolves an idea's account IDs against the user's live broker accounts and
 * computes the per-account order quantities. The main account (idea.mainAccountId)
 * trades the raw quantity; every other account scales by its balance ratio to the
 * main account. Building this server-side means the plan no longer depends on the
 * browser, and can be acted on by the monitor (deferred / auto modes).
 */

import { brokerService }      from '../api/broker/broker.service.js'
import { paperBrokerService, VIRTUAL_MODES } from '../api/broker/paperBroker.service.js'
import { SUPPORTED_BROKERS }  from '../api/broker/broker.factory.js'
import { logger }             from './logger.service.js'
import { ideaToEnvelope }     from './entity/toEnvelope.js'

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
        // Virtual modes (paper/manual) are resolved below straight from their store —
        // per-idea-bound and not gated on the global connection/toggle — so skip them
        // here to keep ONE canonical resolution path (no divergent double-mapping).
        if (!connected || VIRTUAL_MODES.includes(broker)) continue
        const { accounts: accs = [] } = await brokerService.getTradingAccounts(broker, userId)
        for (const a of accs) {
            const id = String(a.id)
            if (want.has(id)) byId.set(id, { ...a, broker })
        }
    }

    // Virtual accounts: resolve any still-unmatched wanted id straight from the store,
    // tagging it with its mode as the broker. Only modes with a REGISTERED adapter are
    // tagged — a 'manual' id (no adapter yet) is left unresolved rather than producing a
    // broker:'manual' partition that placeOrder can't service (400). This is how an idea
    // bound to a chosen paper account partitions onto broker:'paper' through the normal path.
    for (const id of want) {
        if (byId.has(id)) continue
        const mode = paperBrokerService.accountMode(id)
        if (!mode || !SUPPORTED_BROKERS.includes(mode)) continue
        const acct = await paperBrokerService.getAccount(userId, id)
        if (acct) byId.set(id, {
            id: acct.accountId, login: acct.accountId, name: acct.name,
            currency: acct.currency, balance: acct.cashBalance, broker: mode,
        })
    }
    return byId
}

/**
 * Kind-BLIND order-plan builder. Reads only the shared Envelope's execution binding +
 * sizing + identity — so an idea, a call, or a portfolio_item plan the same way (see
 * ENTITY_MODEL.md P1). The main account (execution.mainAccountId) trades the raw quantity;
 * every other account scales by its balance ratio to the main account.
 *
 * @param {import('./entity/envelope.js').Envelope} envelope
 * @param {{ resolveAccounts?: typeof resolveUserAccounts }} [deps]  injectable for tests
 * @returns {Promise<Array<{ broker, accountId, accountNo, quantity, type }>>}
 *          `type` is the broker execution type — always 'market' for a confirmed entry
 *          (NOT the entity's trade STYLE: intraday/swing).
 */
export async function buildOrderPlan(envelope, { resolveAccounts = resolveUserAccounts } = {}) {
    const accounts      = envelope?.execution?.accounts
    const mainAccountId = envelope?.execution?.mainAccountId
    const quantity      = envelope?.sizing?.resolvedQty ?? envelope?.sizing?.requested
    const userId        = envelope?.userId
    if (!Array.isArray(accounts) || accounts.length === 0) return []

    const wantedIds = new Set(accounts.map(a => String(typeof a === 'object' ? a.id : a)))

    // Resolve account IDs → live account info across the user's connected brokers
    let byId
    try {
        byId = await resolveAccounts(userId, wantedIds)
    } catch (err) {
        logger.error(LOG, `Failed to resolve accounts for entity ${envelope?.id}: ${err.message}`)
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

/**
 * @param {object} idea  must carry accounts[], mainAccountId, quantity, userId
 * @returns {Promise<Array<{ broker, accountId, accountNo, quantity, type }>>}
 * Thin idea-shim over the kind-blind {@link buildOrderPlan}: the real call path now flows
 * through the Envelope, byte-identically. Callers stay unchanged.
 */
export async function buildOrderPlanForIdea(idea) {
    return buildOrderPlan(ideaToEnvelope(idea))
}
