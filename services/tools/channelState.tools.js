// The channel-state read for Axl — the "what's the channel picture" broadcast.
//
// UNBOUND — no userId, same as sectorView.tools.js and for the same reason: channel state is a
// house-layer broadcast written by the Python engine for all readers equally. A handler that cannot
// see a user cannot leak one into it.
//
// This is the SHOW half of Axl's job. Authoring or changing engine data is Python's; Axl reports
// what the engine already wrote.

import { makeToolHandler }     from '../agentUtils.js'
import { formatChannelState }  from './aether.tools.js'
import { getChannelState }     from '../../api/aether/aether.service.js'

const LOG = '[channelState]'

export const CHANNEL_STATE_TOOL_SPEC = {
    get_channel_state: `The latest channel-state snapshot from the Aether engine: current pressure scores per channel and the active regime label. Call it for "what's the channel picture", "where is pressure building", "what's the Aether read", or any question about which macro channels are elevated right now. READ-ONLY and broadcast — it knows nothing about this user's book. If no data is available yet it says so; do not invent a state. No arguments.`,
}

export function makeChannelStateHandlers(deps = {}) {
    const { current = () => getChannelState() } = deps

    return {
        get_channel_state: makeToolHandler('get_channel_state',
            async () => formatChannelState(await current()),
            (err) => `Could not read the channel state: ${err.message}`, LOG),
    }
}
