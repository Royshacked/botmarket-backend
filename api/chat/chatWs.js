import { WebSocketServer, WebSocket } from 'ws'
import { parse }                      from 'url'
import jwt                            from 'jsonwebtoken'
import { logger }                     from '../../services/logger.service.js'

const LOG = '[chatWs]'

// userId (string) → WebSocket
const socketMap = new Map()

let wss = null

export function attach(httpServer) {
    wss = new WebSocketServer({ noServer: true })

    httpServer.on('upgrade', (req, socket, head) => {
        const { pathname } = parse(req.url, true)
        if (pathname !== '/ws/chat') return  // not ours — leave for other upgrade handlers

        const token = _extractToken(req)
        if (!token) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
            socket.destroy()
            return
        }

        let userId
        try {
            const payload = jwt.verify(token, process.env.JWT_SECRET)
            // JWT payload shape matches the auth middleware: { _id, username, ... }
            userId = String(payload._id ?? payload.id ?? payload.userId)
            if (!userId || userId === 'undefined') throw new Error('no userId in token')
        } catch {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
            socket.destroy()
            return
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req, userId)
        })
    })

    wss.on('connection', (ws, _req, userId) => {
        logger.info(LOG, 'connected', { userId })
        socketMap.set(userId, ws)

        ws.send(JSON.stringify({ event: 'connected' }))

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw)
                if (msg.event === 'ping') ws.send(JSON.stringify({ event: 'pong' }))
            } catch { /* ignore malformed frames */ }
        })

        ws.on('close', () => {
            if (socketMap.get(userId) === ws) socketMap.delete(userId)
            logger.info(LOG, 'disconnected', { userId })
        })

        ws.on('error', (err) => {
            logger.warn(LOG, 'socket error', { userId, message: err.message })
        })
    })

    logger.info(LOG, 'WS server attached to /ws/chat')
}

/**
 * Push an event to a connected user. No-op if the user is offline.
 */
export function emit(userId, event, data) {
    const ws = socketMap.get(String(userId))
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event, data }))
    }
}

function _extractToken(req) {
    // Cookie only (same name as REST auth middleware: 'token'). The JWT is NEVER
    // accepted via a query param — tokens in URLs leak into proxy/access logs,
    // browser history, and Referer headers. Same-origin WS carries the cookie.
    const cookieHeader = req.headers.cookie ?? ''
    const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/)
    if (match) return decodeURIComponent(match[1])

    return null
}
