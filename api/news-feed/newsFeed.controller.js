import { newsFeedService } from './newsFeed.service.js'
import { getCompanyName } from '../../providers/yahoofinance.provider.js'

export function getNewsFeed(req, res) {
    res.send({ articles: newsFeedService.get() })
}

export async function getAssetNews(req, res) {
    const symbol = (req.params.symbol ?? '').trim().toUpperCase()
    let   query  = (req.query.q ?? '').trim()
    if (!symbol) return res.status(400).json({ err: 'symbol required' })

    // If no company name provided (or it looks like a raw ticker), resolve it
    if (!query || /^[A-Z]{1,6}$/.test(query)) {
        query = await getCompanyName(symbol).catch(() => symbol)
    }

    try {
        const articles = await newsFeedService.getForSymbol(query)
        res.send({ articles })
    } catch (err) {
        console.error('[assetNews] error:', err)
        res.status(500).json({ err: 'Failed to fetch asset news' })
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
