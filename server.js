// config loads .env itself, so importing it first makes the environment available to every module
// below regardless of import order — see services/config.js for why that ordering was a real trap.
import { config, validateConfig, unknownConfigKeys } from './services/config.js'
import dns from 'dns'
dns.setServers(['8.8.8.8', '1.1.1.1'])  // router blocks Node.js SRV queries; use public DNS

// ── Fail fast on bad configuration ────────────────────────────────────────
// Two failures, not one. MISSING is fatal as before. MALFORMED is new and is the more interesting
// case: a value that IS set but doesn't parse (`CANDLE_CACHE_INTRADAY_MS=abc`) used to fall through
// to the default in silence, so the system ran correctly-looking on a setting nobody chose.
const { missing, malformed } = validateConfig()
if (missing.length) {
    console.error(`[server] Missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
}
if (malformed.length) {
    console.error(`[server] Malformed env vars (unparseable, would silently use the default): `
        + malformed.map(m => `${m.key}=${JSON.stringify(m.value)}`).join(', '))
    process.exit(1)
}
// A key in .env that no config entry claims is what a typo looks like from the only side it is
// visible from. A warning, not fatal — an operator may keep unrelated notes in that file.
const unknown = unknownConfigKeys()
if (unknown.length) {
    console.warn(`[server] .env sets keys nothing reads (typo, or leftovers): ${unknown.join(', ')}`)
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
import { ensureExperienceIndexes } from './api/experience/experience.model.js'
import { ensurePendingActionIndexes } from './services/pendingAction/pendingAction.repo.js'
import { pendingActionRoutes } from './api/pendingAction/pendingAction.routes.js'
import { threadService } from './services/thread.service.js'
import { kairosRoutes } from './api/kairos/kairos.routes.js'
import { mentorRoutes } from './api/mentor/mentor.routes.js'
import { setupsRoutes } from './api/setups/setups.routes.js'
import { tradeIdeasRoutes } from './api/trade-ideas/tradeIdeas.routes.js'
import { authRoutes }   from './api/authentication/authentication.routes.js'
import { userRoutes }   from './api/user/user.routes.js'
import { brokerRoutes }      from './api/broker/broker.routes.js'
import { paperRoutes }       from './api/paper/paper.routes.js'
import { tradesRoutes }      from './api/trades/trades.routes.js'
import { transcribeRoutes }  from './api/transcribe/transcribe.routes.js'
import { portfolioRoutes }   from './api/portfolio/portfolio.routes.js'
import { scannerRoutes }     from './api/scanner/scanner.routes.js'
import { analystRoutes }     from './api/analyst/analyst.routes.js'
import { strategyRoutes }    from './api/strategy/strategy.routes.js'
import { axlRoutes }         from './api/axl/axl.routes.js'
import { threadsRoutes }     from './api/threads/threads.routes.js'
import { turnsRoutes }       from './api/turns/turns.routes.js'
import { marketRoutes }      from './api/market/market.routes.js'
import { calendarRoutes }    from './api/calendar/calendar.routes.js'
// import { minosService } from './monitoring/minos.monitor.service.js'   // ARCHIVED — see the start() below
import { hermesService }    from './monitoring/hermes.monitor.service.js'
import { talosService }     from './monitoring/talos.monitor.service.js'
import { coverageMonitorService } from './monitoring/coverage.monitor.service.js'
import { tiltMonitorService }     from './monitoring/tilt.monitor.service.js'
import { themisService }      from './monitoring/themis.monitor.service.js'
import { executionReconciler } from './monitoring/execution.reconciler.js'
import { paperFillService }  from './monitoring/paperFill.service.js'
import { paperEquityService } from './monitoring/paperEquity.service.js'
import { paperMarkService }   from './monitoring/paperMark.service.js'
import { marketBriefNotifier } from './monitoring/marketBrief.notify.js'
import { marketOpenMonitor } from './monitoring/marketOpen.monitor.js'
import { logger }           from './services/logger.service.js'
import { closeRenderer }    from './services/chartRender/klineRender.provider.js'

const app = express()
const server = http.createServer(app)

// CORS — must come before every route.
// app.options handles the preflight for non-simple requests (e.g. audio/webm Content-Type).
if (!config.isProduction) {
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

if (config.isProduction) {
    app.use(express.static(path.resolve('public')))
}

// The Idea agent (legacy `idea` kind) was archived 2026-07-29 — superseded by Kairos (`call`) and
// Mentor (`setup`) — and DELETED 2026-08-07. It sat unmounted for ten days, so `git log` is the
// only place it now lives; nothing here reads it. NB the `idea` KIND is not gone: /api/trade-ideas
// still serves it, and portfolio holdings ride that plumbing.
app.use('/api/kairos',      kairosRoutes)
app.use('/api/mentor',      mentorRoutes)
app.use('/api/setups',      setupsRoutes)
app.use('/api/trade-ideas', tradeIdeasRoutes)
app.use('/api/auth',        authRoutes)
app.use('/api/users',       userRoutes)
app.use('/api/broker',      brokerRoutes)
app.use('/api/paper',       paperRoutes)
app.use('/api/trades',      tradesRoutes)
app.use('/api/portfolio',   portfolioRoutes)
// The queued list — what is waiting on the user, from both the off-hours queue and the entities
// the market-open sweep just unparked. See docs/architecture/off-hours-queue.md.
app.use('/api/pending-actions', pendingActionRoutes)
app.use('/api/scanner',     scannerRoutes)
app.use('/api/analyst',     analystRoutes)
app.use('/api/strategy',    strategyRoutes)
app.use('/api/axl',         axlRoutes)
app.use('/api/threads',     threadsRoutes)
// Stopping an agent turn — its own endpoint because stopping and walking away are different
// intentions that used to arrive as the same closed socket (see api/_shared/sse.util.js).
app.use('/api/turns',       turnsRoutes)
app.use('/api/market',      marketRoutes)
app.use('/api/calendar',    calendarRoutes)
app.use('/api/chat',        chatRoutes)

attachChatWs(server)
ensureChatIndexes()
ensureUserIndexes()
ensureIdeaIndexes()
ensureKairosIndexes()
ensureTradeIndexes()
ensureExperienceIndexes()
ensurePendingActionIndexes()
threadService.ensureThreadIndexes()

// ─── Background loops ─────────────────────────────────────────────────────────
// SINGLE INSTANCE ONLY. These eleven loops start unconditionally, with no leader election, so a
// second process runs a second copy of every one of them. Some claim their work through Mongo and
// are safe (Hermes/Talos via dueLoop's lease, marketOpen via claimIf, paperFill via claimOrder, the
// brief notifier via its card dedupe); others rely on being the only process alive — above all
// execution.reconciler's in-memory exit-order lock, which a second instance cannot even see.
// Read docs/architecture/single-instance.md BEFORE raising an instance/replica count.

// ARCHIVED 2026-07-29 — Minos watched the legacy `idea` kind, which nothing builds any more, and
// its tick was also picking up `setup` entities that belong to Talos. Not started; re-add this
// line to revive it (the kind filter it was missing is now in place).
// minosService.start()
// The deferred-order sweep used to ride inside Minos, so archiving Minos silently stranded every
// order that parked at 'awaiting_market' overnight. It is its own loop now, kind-blind, and is not
// tied to any agent's lifecycle. See monitoring/marketOpen.monitor.js.
marketOpenMonitor.start()
hermesService.start()
talosService.start()
coverageMonitorService.start()
tiltMonitorService.start()
themisService.start()
executionReconciler.start()
paperFillService.start()
paperEquityService.start()
paperMarkService.start()
marketBriefNotifier.start()

// SPA fallback: only in production when static assets live in public/
if (config.isProduction) {
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

const port = config.port

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

    server.close(async (err) => {
        await closeRenderer().catch(() => {})   // shut the headless Chromium down cleanly
        if (err) {
            logger.error(`Error closing server (${signal}):`, err)
            process.exit(1)
        }
        process.exit(0)
    })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))