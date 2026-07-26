import { toBrokerSymbol } from './brokerSymbol.service.js'
import { brokerService } from '../api/broker/broker.service.js'
import { computeBasisOffset } from '../api/broker/brokerPrice.service.js'
import { logger } from './logger.service.js'

// The venue/symbol gate, shared by every entity that binds to a broker at Generate.
//
// Extracted from kairos.agent.service.js (which still re-exports it as `_resolveVenue` for its
// existing importers) so the `setup` kind resolves symbols through the SAME path as calls rather
// than growing a second copy of the cTrader basis logic. See docs/setup-entity.md §8.

const LOG = '[venue]'

/**
 * Bind an asset to a broker's price space: the broker-native symbol plus the basis offset between
 * chart space and broker space.
 *
 * Only cTrader needs resolving (NQ → US100 → US100.cash, plus the index basis). Paper and manual
 * trade in chart space, so symbol == asset and offset == 0.
 *
 * Never throws: a failed symbol lookup falls back to the static alias map, and a failed basis
 * computation falls back to zero. Binding must not be the thing that blocks a Generate.
 * Deps injectable for tests (no network).
 */
export async function resolveVenue(broker, userId, accountId, asset, deps = {}) {
    const {
        toBrokerSymbol:     _toBrokerSymbol     = toBrokerSymbol,
        // Wrapped (not detached) so the real brokerService method keeps its receiver.
        resolveSymbol:      _resolveSymbol      = (...args) => brokerService.resolveSymbol(...args),
        computeBasisOffset: _computeBasisOffset = computeBasisOffset,
    } = deps

    if (broker !== 'ctrader') return { broker_symbol: asset, basis_offset: 0 }

    const mapped = _toBrokerSymbol('ctrader', asset)
    let brokerSymbol = mapped
    try {
        const res = await _resolveSymbol('ctrader', userId, accountId, mapped)
        if (res?.found && res.symbol) brokerSymbol = res.symbol
    } catch (err) {
        logger.warn(LOG, `resolveSymbol ${asset}→${mapped} failed — using static map: ${err.message}`)
    }

    let basis_offset = 0
    try {
        const { offset } = await _computeBasisOffset({ brokerSymbol, asset })
        basis_offset = offset || 0
    } catch (err) {
        logger.warn(LOG, `basis offset failed for ${asset}→${brokerSymbol}: ${err.message}`)
    }

    return { broker_symbol: brokerSymbol, basis_offset }
}

/**
 * The workspace a broker implies. Paper and manual are their own venues; everything else is real
 * money. Mirrors the frontend's derived `isPaperIdea` rule so a setup can't display as live in one
 * place and paper in another.
 */
export function modeForBroker(broker) {
    if (broker === 'paper')  return 'paper'
    if (broker === 'manual') return 'manual'
    return 'live'
}
