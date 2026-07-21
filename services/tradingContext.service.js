// Shared trading-context accessor (KAIROS_MODES.md cross-cutting). Assembles the user's AUTHORITATIVE
// venue + account menu from existing backend state (broker connections + accounts + capabilities +
// paper/manual) — NO new persisted state. One read used by all desk agents (idea/kairos/atlas) + the
// feasibility gate + sizing. Best-effort: never throws; a failed leg just drops from the menu.
//
// Returns:
//   { modes: { paper: bool, manual: bool, live_brokers: [name] },
//     accounts: [ { id, broker, mode, name, balance, currency, capabilities } ] }

import { brokerService } from '../api/broker/broker.service.js'
import { paperBrokerService, VIRTUAL_MODES } from '../api/broker/paperBroker.service.js'
import { logger } from './logger.service.js'

const LOG = '[tradingContext]'

function _caps(broker) {
    try { return brokerService.capabilities(broker) } catch { return {} }
}

export async function getTradingContext(userId) {
    const empty = { modes: { paper: false, manual: false, live_brokers: [] }, accounts: [] }
    if (!userId) return empty

    let connections
    try { connections = await brokerService.listConnections(userId) }
    catch (err) { logger.warn(LOG, 'listConnections failed', err.message); return empty }

    const liveBrokers = Object.entries(connections)
        .filter(([b, on]) => on && !VIRTUAL_MODES.includes(b))
        .map(([b]) => b)

    const accounts = []

    // Live broker accounts.
    for (const broker of liveBrokers) {
        try {
            const { accounts: accs = [] } = await brokerService.getTradingAccounts(broker, userId)
            const caps = _caps(broker)
            for (const a of accs) accounts.push({
                id: String(a.id), broker, mode: 'live',
                name: a.name ?? a.login ?? String(a.id),
                balance: a.balance ?? null, currency: a.currency ?? null, capabilities: caps,
            })
        } catch (err) { logger.warn(LOG, `getTradingAccounts(${broker}) failed`, err.message) }
    }

    // Virtual (paper / manual) accounts.
    for (const mode of ['paper', 'manual']) {
        if (!connections[mode]) continue
        try {
            const accs = await paperBrokerService.listAccounts(userId, { mode })
            const caps = _caps(mode)
            for (const a of accs) accounts.push({
                id: String(a.accountId ?? a.id), broker: mode, mode,
                name: a.name ?? String(a.accountId ?? a.id),
                balance: a.cashBalance ?? a.balance ?? null, currency: a.currency ?? null, capabilities: caps,
            })
        } catch (err) { logger.warn(LOG, `listAccounts(${mode}) failed`, err.message) }
    }

    return {
        modes: { paper: !!connections.paper, manual: !!connections.manual, live_brokers: liveBrokers },
        accounts,
    }
}
