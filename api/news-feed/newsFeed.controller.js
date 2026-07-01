import { newsFeedService } from './newsFeed.service.js'
import { logger } from '../../services/logger.service.js'
import { startSseStream } from '../_shared/sse.util.js'

export function getNewsFeed(req, res) {
    res.send({ articles: newsFeedService.get() })
}

// Phase 1 — raw articles, fast (no LLM) so the UI can render immediately.
export async function getAssetNews(req, res) {
    const symbol = (req.params.symbol ?? '').trim().toUpperCase()
    const query  = (req.query.q ?? '').trim()
    if (!symbol) return res.status(400).json({ error: 'symbol required' })

    try {
        // Company-name resolution now happens inside the service so a cache hit
        // short-circuits the Yahoo lookup too.
        const articles = await newsFeedService.getForSymbolRaw(symbol, query)
        res.send({ articles })
    } catch (err) {
        logger.error('[assetNews] error:', err)
        res.status(500).json({ error: 'Failed to fetch asset news' })
    }
}

// Phase 2 — relevance-filtered articles with sentiment (LLM), fetched after render.
export async function getAssetNewsSentiment(req, res) {
    const symbol = (req.params.symbol ?? '').trim().toUpperCase()
    const query  = (req.query.q ?? '').trim()
    if (!symbol) return res.status(400).json({ error: 'symbol required' })

    try {
        const articles = await newsFeedService.getForSymbolSentiment(symbol, query)
        res.send({ articles })
    } catch (err) {
        logger.error('[assetNews:sentiment] error:', err)
        res.status(500).json({ error: 'Failed to fetch asset news sentiment' })
    }
}

export function streamNewsFeed(req, res) {
    // startSseStream sets the SSE headers (incl. X-Accel-Buffering), flushes,
    // starts the keep-alive heartbeat, and clears it on res close. This feed
    // pushes raw `data:` frames (no named events), so we ignore sendEvent and
    // write directly; we only add the client (de)registration on close.
    startSseStream(req, res)

    res.write(`data: ${JSON.stringify(newsFeedService.get())}\n\n`)

    newsFeedService.addClient(res)

    res.on('close', () => {
        newsFeedService.removeClient(res)
    })
}
