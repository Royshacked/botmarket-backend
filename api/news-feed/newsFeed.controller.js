import { newsFeedService } from './newsFeed.service.js'

export function getNewsFeed(req, res) {
    res.send({ articles: newsFeedService.get() })
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
