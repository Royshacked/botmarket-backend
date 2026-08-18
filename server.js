// config loads .env itself, so importing it first makes the environment available to every module
// below regardless of import order — see services/config.js for why that ordering was a real trap.
import { config, validateConfig, unknownConfigKeys } from './services/config.js'
import dns from 'dns'
// A DEV workaround, and only that. A developer's router blocks the SRV queries a `mongodb+srv://`
// URI needs, so the resolver is forced to a public one. It used to run unconditionally, which meant
// shipping a global DNS override to production — where it overrides whatever resolver the platform
// or VPC provides, and a private Mongo endpoint becomes unresolvable in a way that reads as a Mongo
// outage. `config.dnsServers` is empty in production and unchanged in development.
if (config.dnsServers.length) dns.setServers(config.dnsServers)

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
import { ensureTradeIndexes } from './services/tradeCapture.service.js'
import { ensureExperienceIndexes } from './api/experience/experience.model.js'
import { ensureWorkspaceIndexes } from './api/workspace/workspace.model.js'
import { ensurePendingActionIndexes } from './services/pendingAction/pendingAction.repo.js'
import { pendingActionRoutes } from './api/pendingAction/pendingAction.routes.js'
import { threadService } from './services/thread.service.js'
import { mentorRoutes } from './api/mentor/mentor.routes.js'
import { setupsRoutes } from './api/setups/setups.routes.js'
import { tradeIdeasRoutes } from './api/trade-ideas/tradeIdeas.routes.js'
import { authRoutes }   from './api/authentication/authentication.routes.js'
import { userRoutes }   from './api/user/user.routes.js'
import { brokerRoutes }      from './api/broker/broker.routes.js'
import { paperRoutes }       from './api/paper/paper.routes.js'
import { workspaceRoutes }   from './api/workspace/workspace.routes.js'
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
// The software exit monitor — kind-blind, and the caller positionMonitor.checkPosition lost when
// Minos was deleted. Until it started, a stop that was not a plain price level was accepted, stored
// and shown as protection while nothing evaluated it. Tied to a CAPABILITY, not to a desk.
import { exitMonitor } from './monitoring/exit.monitor.js'
import { logger, switchToSyncLogging } from './services/logger.service.js'
import { closeRenderer }    from './services/chartRender/klineRender.provider.js'
import { closeDb, getDb }   from './providers/mongodb.provider.js'
import { healthRoutes }     from './api/health/health.routes.js'
import { securityHeaders }  from './middleware/securityHeaders.middleware.js'
import { apiLimiter, authLimiter, agentLimiter } from './middleware/rateLimit.middleware.js'
import { startLoop, stopLoops, markDraining } from './services/lifecycle.service.js'
import { createInstanceLock, LOCK_COLLECTION } from './services/instanceLock.service.js'
import { setLoopLeader } from './services/loopLeader.js'
import os from 'os'

const app = express()
const server = http.createServer(app)

// Never advertise the framework.
app.disable('x-powered-by')

// How many reverse proxies sit in front of us. Load-bearing for the IP-keyed rate limiters: without
// it every request behind Render's proxy reports the proxy's own address, so the whole internet
// shares one bucket. A COUNT, never `true` — see config.trustProxyHops.
app.set('trust proxy', config.trustProxyHops)

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

// Response hardening. Carries the microphone permission that used to be set inline here — the
// browser mic is how voice input reaches /api/transcribe. Deliberately does NOT set a CSP; see
// middleware/securityHeaders.middleware.js for why that is its own piece of work.
app.use(securityHeaders)

app.use(cookieParser())

// Health BEFORE the limiters: a probe runs every few seconds and must never spend a user's budget,
// and a 429 on the health check reads to the platform as an outage. Unauthenticated by necessity.
app.use('/api/health', healthRoutes)

// The blanket backstop, ahead of every route including /api/transcribe (which is mounted before
// the JSON parser and would otherwise sit outside it).
app.use('/api', apiLimiter)

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

// ARCHIVED DESKS. The Idea agent (legacy `idea` kind) went on 2026-07-29 and was deleted
// 2026-08-07; Kairos (`call`) and its monitor Hermes followed on 2026-08-18 and now live under
// `archive/`, imported by nothing. Both return later — Kairos as a premium Mentor mode.
//
// NB the `idea` KIND is not gone and must not be: /api/trade-ideas still serves it, and every
// portfolio holding IS one of those documents (kindForDoc — an idea WITH a portfolioId). It is
// the execution tier, not a desk.
// The two targeted limiters. Mounted here, ahead of the routers, because Express runs middleware
// in mount order and a limiter registered after its route never sees the request.
//
// The agent limiter is pinned to the STREAM paths specifically, not to the desk prefixes. Every
// desk exposes exactly one `POST /stream` (Axl also has `/brief/stream`), and those are the only
// endpoints that buy tokens. Limiting `/api/portfolio` wholesale would have counted its fifteen
// ordinary reads against the same budget and throttled a user for browsing their own book.
app.use('/api/auth', authLimiter)
for (const desk of ['axl', 'mentor', 'portfolio', 'scanner', 'analyst', 'strategy']) {
    app.use(`/api/${desk}/stream`, agentLimiter)
}
app.use('/api/axl/brief/stream', agentLimiter)

app.use('/api/mentor',      mentorRoutes)
app.use('/api/setups',      setupsRoutes)
app.use('/api/trade-ideas', tradeIdeasRoutes)
app.use('/api/auth',        authRoutes)
app.use('/api/users',       userRoutes)
app.use('/api/broker',      brokerRoutes)
app.use('/api/paper',       paperRoutes)
// Which of the three books (live / paper / manual) the user is standing in. Persisted server-side
// because `manual` is broker-less and so has no connection flag to derive itself from.
app.use('/api/workspace',   workspaceRoutes)
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
ensureTradeIndexes()
ensureExperienceIndexes()
ensureWorkspaceIndexes()
ensurePendingActionIndexes()
threadService.ensureThreadIndexes()

// ─── Background loops ─────────────────────────────────────────────────────────
// ONE INSTANCE RUNS THESE, and that is now enforced rather than merely documented. They start
// behind a Mongo lease (services/instanceLock.service.js): a second process wins nothing, starts
// no loops, and says so — it still serves HTTP. Before this, `replicas: 2` in a file that is not
// in this repo silently gave you two of every loop, including two reconcilers cancelling each
// other's exit orders.
//
// It buys SAFETY, NOT SCALE. `chatWs.socketMap` is per-process request-path state, so a user on
// the follower still misses cards the leader emits. Read docs/architecture/single-instance.md
// before raising a replica count — a green lease is not permission.

// Minos (the legacy `idea` monitor) was DELETED on 2026-08-18. The deferred-order sweep used to
// ride inside its tick, so switching Minos off in July silently stranded every order parked at
// 'awaiting_market' overnight; marketOpen is its own kind-blind loop now, tied to no agent's
// lifecycle. Minos's other survivor is monitoring/preflightEntry.js.
//
// Each goes through `startLoop`, which starts it AND registers it for shutdown. Every one of these
// already exported a `stop()` that nothing ever called: on SIGTERM the loops kept ticking while the
// HTTP server drained, so a deploy could kill the reconciler part-way through placing an exit.
// Registering here is what makes `stopLoops()` writable — and makes a twelfth loop one line that
// cannot forget to be shut down. See services/lifecycle.service.js.
function startBackgroundLoops() {
    startLoop('marketOpen',   marketOpenMonitor)
    startLoop('exits',        exitMonitor)
    startLoop('talos',        talosService)
    startLoop('coverage',     coverageMonitorService)
    startLoop('tilt',         tiltMonitorService)
    startLoop('themis',       themisService)
    startLoop('reconciler',   executionReconciler)
    startLoop('paperFill',    paperFillService)
    startLoop('paperEquity',  paperEquityService)
    startLoop('paperMark',    paperMarkService)
    startLoop('marketBrief',  marketBriefNotifier)
}

const loopsLock = createInstanceLock({
    getCollection: async () => (await getDb()).collection(LOCK_COLLECTION),
    instanceId: `${os.hostname()}:${process.pid}`,
    ttlMs:   config.instanceLeaseTtlMs,
    renewMs: config.instanceLeaseRenewMs,
    onAcquired: () => { setLoopLeader(true);  startBackgroundLoops() },
    // Losing the lease mid-flight is not hypothetical — a Mongo blip or a long GC pause is
    // enough, and by then another process may legitimately hold it. Standing the loops down is
    // what stops there being two reconcilers for the length of the outage.
    onLost:     async () => { setLoopLeader(false); await stopLoops() },
})

// Not awaited: a database that is slow or down must not hold up the HTTP listener. The lock
// retries on its own interval, so the loops start whenever the lease becomes winnable.
loopsLock.start().catch(err => logger.error('[server]', 'loop lease failed to start', err))

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

// ─── Shutdown ─────────────────────────────────────────────────────────────────
//
// The previous version was `server.close()` and nothing else, and it failed twice over.
//
// It never stopped the loops — all eleven kept running while the HTTP server drained, so the
// reconciler could be part-way through `read the idea → ask the broker whether the position
// survived → place / cancel exits` when the platform's SIGKILL landed. A real order, lost on an
// ordinary deploy.
//
// And it could never finish. `server.close()` waits for open connections, and this app's
// connections are SSE streams held open BY DESIGN with a 30s heartbeat, so the callback would not
// fire until the platform killed the process ~30s later. The graceful path was, in practice, the
// hard one.
//
// The order below is the whole point: out of rotation, then stop claiming work, then stop
// accepting sockets, then force the sockets that will never close themselves, then release
// outbound resources. Every step is bounded, and a backstop covers the lot.

let shuttingDown = false

async function shutdown(signal, code = 0) {
    if (shuttingDown) return
    shuttingDown = true
    // From here every line is written synchronously. Async appends are dropped by
    // process.exit(), which loses exactly the record that says how shutdown went.
    switchToSyncLogging()
    logger.info('[server]', `${signal} — shutting down`)

    // Armed FIRST so it covers every step below, including a hang inside one of them. unref'd: a
    // shutdown backstop must never itself be the reason a process stays alive.
    const backstop = setTimeout(() => {
        logger.error('[server]', `shutdown exceeded ${config.shutdownGraceMs}ms — forcing exit`)
        process.exit(code || 1)
    }, config.shutdownGraceMs)
    backstop.unref()

    let exitCode = code
    try {
        // 1. Out of rotation before a single socket closes, so the load balancer stops routing
        //    here while we can still answer what is already in flight.
        markDraining()

        // 2. Stop claiming new work — ahead of the sockets deliberately. A monitor that begins a
        //    broker round trip after this point has nowhere left to write the answer.
        const stopped = await stopLoops()
        logger.info('[server]', `stopped ${stopped.length} background loops`)

        // Release AFTER the loops are down, never before: handing the lease over while ours are
        // still winding up would put a replacement's reconciler alongside our own.
        await loopsLock.stop()

        // 3. Refuse new connections; let requests already running finish.
        //
        // The log line matters as much as the call. Between step 2 and step 4 there used to be a
        // FIVE-SECOND SILENT WINDOW, and the first real Ctrl-C landed inside it: the log stopped
        // dead after 'stopped N loops' with no way to tell whether we had reached this step, were
        // waiting on a socket, or had been killed outright. Shutdown runs once per process life,
        // so narrating each step costs nothing and is the only forensics there will ever be.
        const socketGraceMs = Math.max(1_000, Math.floor(config.shutdownGraceMs / 2))
        logger.info('[server]', `draining connections (up to ${socketGraceMs}ms)`)
        const closed = new Promise(resolve => server.close(resolve))
        server.closeIdleConnections()

        // 4. An SSE stream is never idle and never ends on its own, so `closed` would hang here
        //    forever. Give in-flight work half the budget, then take the sockets down — leaving
        //    the other half to close Mongo and Chromium, which is the part that must not be cut.
        let graceTimer = null
        const grace = new Promise(resolve => { graceTimer = setTimeout(() => resolve(true), socketGraceMs) })
        const forced = await Promise.race([closed.then(() => false), grace])
        clearTimeout(graceTimer)
        if (forced) {
            logger.warn('[server]', `connections still open after ${socketGraceMs}ms — closing them`)
            server.closeAllConnections()
            await closed
        } else {
            logger.info('[server]', 'connections drained on their own')
        }
        logger.info('[server]', 'closing outbound resources (renderer, db)')

        // 5. Outbound resources. Each is guarded on its own: failing to shut Chromium down must
        //    not skip closing the database.
        await closeRenderer().catch(err => logger.error('[server]', 'renderer close failed', err))
        await closeDb().catch(err => logger.error('[server]', 'db close failed', err))

        logger.info('[server]', 'shutdown complete')
    } catch (err) {
        logger.error('[server]', 'shutdown failed', err)
        exitCode = exitCode || 1
    }
    clearTimeout(backstop)
    process.exit(exitCode)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// ─── Last-resort process handlers ─────────────────────────────────────────────
//
// Neither existed, and this process is the whole system: one instance running all eleven loops. An
// unhandled rejection reaching Node's default handler took down Talos watching live stops, the
// reconciler watching fills and the paper engines together, with positions open and no log line
// saying why.

// ALWAYS fatal. The process state after an uncaught exception is unknown by definition, and
// "unknown" is not a state in which to keep placing broker orders. Exit non-zero and let the
// platform restart us clean — through the same graceful path, so the loops still stop in order.
process.on('uncaughtException', (err) => {
    logger.error('[server]', 'UNCAUGHT EXCEPTION — state is unknown, shutting down', err)
    shutdown('uncaughtException', 1)
})

// NOT fatal by default, which is a deliberate departure from the usual advice and specific to this
// deployment. A rejection escaping one provider call is already contained — createPollLoop and
// createDueLoop each catch per tick — so killing the fleet for one leaked promise is the worse
// outcome. It is logged at error either way, and never swallowed. Set UNHANDLED_REJECTION_FATAL to
// take the strict line; see config.unhandledRejectionFatal.
process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(`Non-error rejection: ${String(reason)}`)
    logger.error('[server]', 'UNHANDLED REJECTION', err)
    if (config.unhandledRejectionFatal) shutdown('unhandledRejection', 1)
})