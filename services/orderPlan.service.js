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

    // VIRTUAL ACCOUNTS FIRST. A paper or manual account resolves from our OWN store — a string
    // prefix and one document read, both certain — so it never needed a broker to be knowable.
    // It used to be resolved AFTER the live probe below, which meant an unrelated broker outage
    // could fail it: one throw from getTradingAccounts and the whole function threw, the caller
    // read "no venue", and a manual book was refused because cTrader's socket was down. Nothing
    // about a bank book depends on cTrader.
    //
    // Ordering is safe because the two id spaces cannot collide: a virtual id is
    // `<mode>-<userId>-<short>` and `accountMode` matches only that prefix, where a live id is a
    // broker login.
    for (const id of want) {
        const mode = paperBrokerService.accountMode(id)
        // Only modes with a REGISTERED adapter are tagged, so an id whose mode has no adapter is
        // left unresolved rather than producing a partition the execution path can't service.
        if (!mode || !SUPPORTED_BROKERS.includes(mode)) continue
        const acct = await paperBrokerService.getAccount(userId, id)
        if (acct) byId.set(id, {
            id: acct.accountId, login: acct.accountId, name: acct.name,
            currency: acct.currency, balance: acct.cashBalance, broker: mode,
        })
    }

    // Everything the caller asked for was local → there is nothing a broker could add, so don't
    // reach for one. A paper or manual book now touches no network at all on this path.
    if (byId.size === want.size) return byId

    const connections = await brokerService.listConnections(userId)
    for (const [broker, connected] of Object.entries(connections)) {
        // Virtual modes are already done above — skipped here to keep ONE canonical resolution
        // path per account (no divergent double-mapping).
        if (!connected || VIRTUAL_MODES.includes(broker)) continue
        // Per-broker guard: one unreachable broker must not lose the accounts of another, nor
        // discard what already resolved. It used to take the whole resolution down with it.
        try {
            const { accounts: accs = [] } = await brokerService.getTradingAccounts(broker, userId)
            for (const a of accs) {
                const id = String(a.id)
                if (want.has(id)) byId.set(id, { ...a, broker })
            }
        } catch (err) {
            logger.warn(LOG, `account resolve: ${broker} unreachable, its accounts stay unresolved: ${err.message}`)
        }
    }
    return byId
}

/**
 * Kind-BLIND order-plan builder. Reads only the shared Envelope's execution binding +
 * sizing + identity — so an idea, a call, or a portfolio_item plan the same way (see
 * docs/architecture/entity-model.md P1). The main account (execution.mainAccountId) trades the raw quantity;
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
