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
import { PaperAdapter }   from './adapters/paper.adapter.js'
import { ManualAdapter }  from './adapters/manual.adapter.js'
import { httpError }      from '../../services/httpError.util.js'

const ADAPTERS = {
    ctrader: CTraderAdapter,
    ibkr:    IBKRAdapter,
    paper:   PaperAdapter,
    manual:  ManualAdapter,
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
    if (!Adapter) throw httpError(400, `Unknown broker type: "${brokerType}". Supported: ${SUPPORTED_BROKERS.join(', ')}`)
    return new Adapter()
}
