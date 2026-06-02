/**
 * Broker Factory
 *
 * Registry of all supported broker adapters.
 * To add a new broker:
 *   1. Create providers/{name}.provider.js
 *   2. Create api/broker/adapters/{name}.adapter.js
 *   3. Import and add to ADAPTERS below — nothing else changes.
 */

import { CTraderAdapter } from './adapters/ctrader.adapter.js'
import { IBKRAdapter }    from './adapters/ibkr.adapter.js'

const ADAPTERS = {
    ctrader: CTraderAdapter,
    ibkr:    IBKRAdapter,
}

/** All broker type identifiers the system currently supports. */
export const SUPPORTED_BROKERS = Object.keys(ADAPTERS)

/**
 * Return a fresh adapter instance for the given broker type.
 * @param {string} brokerType  e.g. 'ctrader' | 'ibkr'
 * @returns {import('./adapters/broker.interface.js').BrokerAdapter}
 * @throws {Error} 400 if brokerType is not registered
 */
export function getBrokerAdapter(brokerType) {
    const Adapter = ADAPTERS[brokerType]
    if (!Adapter) {
        const err = new Error(`Unknown broker type: "${brokerType}". Supported: ${SUPPORTED_BROKERS.join(', ')}`)
        err.status = 400
        throw err
    }
    return new Adapter()
}
