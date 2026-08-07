import { WebSocketServer, WebSocket } from 'ws'
import { parse }                      from 'url'
import jwt                            from 'jsonwebtoken'
import { logger }                     from '../../services/logger.service.js'
import { config } from '../../services/config.js'

const LOG = '[chatWs]'

// userId (string) → Set<WebSocket>
//
// A SET, not one socket. Keyed one-per-user, a second connection for the same person silently
// replaced the first: the displaced socket stayed OPEN on the client, so the browser never saw a
// close, never reconnected, and simply stopped receiving events — its unread badge sat still while
// messages arrived, and only a REST read (opening the chat) showed the true count. Two tabs, or a
// reload racing its own predecessor's close, is all it took.
const socketMap = new Map()

/** Register a live socket for a user. Exported for tests — the registry is the whole bug. */
export function _register(userId, ws) {
    const set = socketMap.get(userId) ?? new Set()
    set.add(ws)
    socketMap.set(userId, set)
    return set.size
}

/** Drop one socket; forget the user entirely once their last connection goes. */
export function _unregister(userId, ws) {
    const set = socketMap.get(userId)
    if (!set) return 0
    set.delete(ws)
    if (set.size === 0) socketMap.delete(userId)
    return set.size
}

export function _socketCount(userId) {
    return socketMap.get(String(userId))?.size ?? 0
}

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
            const payload = jwt.verify(token, config.jwtSecret)
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
        const open = _register(userId, ws)
        logger.info(LOG, 'connected', { userId, sockets: open })

        ws.send(JSON.stringify({ event: 'connected' }))

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw)
                if (msg.event === 'ping') ws.send(JSON.stringify({ event: 'pong' }))
            } catch { /* ignore malformed frames */ }
        })

        ws.on('close', () => {
            const left = _unregister(userId, ws)
            logger.info(LOG, 'disconnected', { userId, sockets: left })
        })

        ws.on('error', (err) => {
            logger.warn(LOG, 'socket error', { userId, message: err.message })
        })
    })

    logger.info(LOG, 'WS server attached to /ws/chat')
}

/**
 * Push an event to EVERY live connection a user has — each tab is a reader of the same inbox, and
 * one of them missing a message is one of them showing a stale badge. No-op if the user is offline.
 */
export function emit(userId, event, data) {
    const set = socketMap.get(String(userId))
    if (!set?.size) return
    const frame = JSON.stringify({ event, data })
    for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame)
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
