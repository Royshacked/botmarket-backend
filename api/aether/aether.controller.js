// HTTP handlers for the Aether desk (channel-graph forecasting engine).
//
// Stream: admin-only (guarded in routes). Read endpoints: requireAuth — the engine outputs are
// house-layer broadcasts, same pattern as the strategy desk's tilt reads.

import { aetherAgentService }                        from '../../services/agents/aether.agent.service.js'
import { getChannelState, getForecasts, getExposure } from './aether.service.js'
import { streamAgentResponse, sseAgentCallbacks }    from '../_shared/sse.util.js'
import { parseChatMessages }                         from '../_shared/parse.util.js'
import { logger }                                    from '../../services/logger.service.js'

const LOG = '[aetherCtrl]'

export async function streamAether(req, res) {
    const { messages, model } = req.body ?? {}
    if (messages !== undefined && messages !== null) {
        const v = parseChatMessages(messages)
        if (v.error) return res.status(400).json({ error: v.error })
    }
    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const result = await aetherAgentService.chatStream({
                messages,
                model,
                userId: req.user._id,
                signal,
                ...sseAgentCallbacks(sendEvent),
            })
            return { reply: result.reply }
        },
    })
}

// ─── Read endpoints — house-layer broadcasts ──────────────────────────────────

export async function getState(req, res) {
    try {
        const doc = await getChannelState()
        res.json(doc)
    } catch (err) {
        logger.error(LOG, 'getState failed', err)
        res.status(500).json({ error: 'Failed to read channel state' })
    }
}

export async function getAetherForecasts(req, res) {
    try {
        const docs = await getForecasts()
        res.json(docs)
    } catch (err) {
        logger.error(LOG, 'getForecasts failed', err)
        res.status(500).json({ error: 'Failed to read forecasts' })
    }
}

export async function getExposureByTicker(req, res) {
    try {
        const { ticker } = req.params
        if (!ticker || typeof ticker !== 'string') return res.status(400).json({ error: 'ticker is required' })
        const doc = await getExposure(ticker)
        res.json(doc)
    } catch (err) {
        logger.error(LOG, 'getExposure failed', err)
        res.status(500).json({ error: 'Failed to read exposure' })
    }
}
