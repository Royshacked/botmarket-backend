import 'dotenv/config'
import dns from 'dns'
dns.setServers(['8.8.8.8', '1.1.1.1'])  // router blocks Node.js SRV queries; use public DNS

// ── Fail fast on missing required env vars ────────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET']
const missing = REQUIRED_ENV.filter(k => !process.env[k])
if (missing.length) {
    console.error(`[server] Missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
}

import http from 'http'
import path from 'path'
import cors from 'cors'
import express from 'express'
import cookieParser from 'cookie-parser'

import { chatRoutes }         from './api/chat/chat.routes.js'
import { attach as attachChatWs } from './api/chat/chatWs.js'
import { ensureIndexes as ensureChatIndexes } from './api/chat/chat.service.js'
import { ensureUserIndexes } from './api/user/user.model.js'
import { ensureIdeaIndexes } from './api/trade-ideas/tradeIdeas.service.js'
import { ensureKairosIndexes } from './api/kairos/kairos.service.js'
import { ensureTradeIndexes } from './services/tradeCapture.service.js'
import { threadService } from './services/thread.service.js'
import { ideaRoutes } from './api/idea/idea.routes.js'
import { kairosRoutes } from './api/kairos/kairos.routes.js'
import { newsFeedRoutes } from './api/news-feed/newsFeed.routes.js'
import { tradeIdeasRoutes } from './api/trade-ideas/tradeIdeas.routes.js'
import { authRoutes }   from './api/authentication/authentication.routes.js'
import { userRoutes }   from './api/user/user.routes.js'
import { brokerRoutes }      from './api/broker/broker.routes.js'
import { paperRoutes }       from './api/paper/paper.routes.js'
import { tradesRoutes }      from './api/trades/trades.routes.js'
import { transcribeRoutes }  from './api/transcribe/transcribe.routes.js'
import { portfolioRoutes }   from './api/portfolio/portfolio.routes.js'
import { scannerRoutes }     from './api/scanner/scanner.routes.js'
import { axlRoutes }         from './api/axl/axl.routes.js'
import { threadsRoutes }     from './api/threads/threads.routes.js'
import { marketRoutes }      from './api/market/market.routes.js'
import { calendarRoutes }    from './api/calendar/calendar.routes.js'
import { newsFeedService }  from './api/news-feed/newsFeed.service.js'
import { minosService }     from './monitoring/minos.monitor.service.js'
import { hermesService }    from './monitoring/hermes.monitor.service.js'
import { executionReconciler } from './monitoring/execution.reconciler.js'
import { paperFillService }  from './monitoring/paperFill.service.js'
import { paperEquityService } from './monitoring/paperEquity.service.js'
import { paperMarkService }   from './monitoring/paperMark.service.js'
import { logger }           from './services/logger.service.js'

const app = express()
const server = http.createServer(app)

// CORS — must come before every route.
// app.options handles the preflight for non-simple requests (e.g. audio/webm Content-Type).
if (process.env.NODE_ENV !== 'production') {
    const corsOptions = {
        origin: [
            'http://127.0.0.1:3030',
            'http://localhost:3030',
            'http://127.0.0.1:5173',
            'http://localhost:5173',
        ],
        credentials: true,
    }
    app.options('*', cors(corsOptions))
    app.use(cors(corsOptions))
}

// Allow microphone access from the browser on all deployments
app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'microphone=*')
    next()
})

app.use(cookieParser())

// Transcribe must be registered before express.json() so the raw body parser
// gets the audio stream before the JSON middleware can touch it
app.use('/api/transcribe', transcribeRoutes)

// 10mb (vs the 100kb default): trade ideas persist their full chat transcript in
// `chat_state` (messages + analysisState), which overflows the default limit on
// longer conversations and 413s the save/update.
app.use(express.json({ limit: '10mb' }))

if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve('public')))
}

app.use('/api/idea', ideaRoutes)
app.use('/api/kairos',      kairosRoutes)
app.use('/api/news-feed',   newsFeedRoutes)
app.use('/api/trade-ideas', tradeIdeasRoutes)
app.use('/api/auth',        authRoutes)
app.use('/api/users',       userRoutes)
app.use('/api/broker',      brokerRoutes)
app.use('/api/paper',       paperRoutes)
app.use('/api/trades',      tradesRoutes)
app.use('/api/portfolio',   portfolioRoutes)
app.use('/api/scanner',     scannerRoutes)
app.use('/api/axl',         axlRoutes)
app.use('/api/threads',     threadsRoutes)
app.use('/api/market',      marketRoutes)
app.use('/api/calendar',    calendarRoutes)
app.use('/api/chat',        chatRoutes)

attachChatWs(server)
ensureChatIndexes()
ensureUserIndexes()
ensureIdeaIndexes()
ensureKairosIndexes()
ensureTradeIndexes()
threadService.ensureThreadIndexes()

newsFeedService.start()
minosService.start()
hermesService.start()
executionReconciler.start()
paperFillService.start()
paperEquityService.start()
paperMarkService.start()

// SPA fallback: only in production when static assets live in public/
if (process.env.NODE_ENV === 'production') {
    app.get('/**', (req, res) => {
        res.sendFile(path.resolve('public/index.html'))
    })
}

// Global error handler — must be last
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logger.error('Unhandled error', err)
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
})

const port = process.env.PORT || 3030

server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
        logger.error(
            `Port ${port} is already in use. Stop the other process (e.g. an old node server) or set PORT to a different value.`
        )
        process.exit(1)
    }
    throw err
})

server.listen(port, () => {
    logger.info('Server is running on port: ' + port)
})

let shuttingDown = false

function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true

    server.close((err) => {
        if (err) {
            logger.error(`Error closing server (${signal}):`, err)
            process.exit(1)
        }
        process.exit(0)
    })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))