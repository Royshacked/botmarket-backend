import { newsFeedService } from './newsFeed.service.js'

export function getNewsFeed(req, res) {
    res.send({ articles: newsFeedService.get() })
}

// Phase 1 — raw articles, fast (no LLM) so the UI can render immediately.
export async function getAssetNews(req, res) {
    const symbol = (req.params.symbol ?? '').trim().toUpperCase()
    const query  = (req.query.q ?? '').trim()
    if (!symbol) return res.status(400).json({ err: 'symbol required' })

    try {
        // Company-name resolution now happens inside the service so a cache hit
        // short-circuits the Yahoo lookup too.
        const articles = await newsFeedService.getForSymbolRaw(symbol, query)
        res.send({ articles })
    } catch (err) {
        console.error('[assetNews] error:', err)
        res.status(500).json({ err: 'Failed to fetch asset news' })
    }
}

// Phase 2 — relevance-filtered articles with sentiment (LLM), fetched after render.
export async function getAssetNewsSentiment(req, res) {
    const symbol = (req.params.symbol ?? '').trim().toUpperCase()
    const query  = (req.query.q ?? '').trim()
    if (!symbol) return res.status(400).json({ err: 'symbol required' })

    try {
        const articles = await newsFeedService.getForSymbolSentiment(symbol, query)
        res.send({ articles })
    } catch (err) {
        console.error('[assetNews:sentiment] error:', err)
        res.status(500).json({ err: 'Failed to fetch asset news sentiment' })
    }
}

export function streamNewsFeed(req, res) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // disable Render/nginx proxy buffering
    res.flushHeaders()

    res.write(`data: ${JSON.stringify(newsFeedService.get())}\n\n`)

    newsFeedService.addClient(res)

    // keep-alive ping every 30s so Render doesn't cut the idle connection
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 30000)

    req.on('close', () => {
        clearInterval(heartbeat)
        newsFeedService.removeClient(res)
    })
}
