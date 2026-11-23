// The situation network's loop (services/situation/watch.js; docs/design/situation-network-plan.md step 9): every hour,
// and once at boot, one tick decides what is due — the first build, the monthly rebuild, the weekly update, or the
// three-hourly news watch that may call an event update. SITUATION_NETWORK=true turns it on (opt-in until the forward
// test starts); off, a tick does nothing.

import { createPollLoop } from './pollLoop.js'
import { tick } from '../services/situation/watch.js'

const LOG = '[situationNetwork]'
export const CHECK_INTERVAL_MS = 60 * 60 * 1000

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => tick(), eager: true, log: LOG, name: 'situation network' })

export const situationNetworkMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
