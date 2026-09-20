// HTTP handlers for the Aether desk (event exposure).
//
// Stream and discovery: admin-only. The candidate list: requireAuth — a run is a house-layer
// broadcast, same pattern as the strategy desk's tilt reads.
//
// Five read endpoints went with the channel engine on 2026-09-09 — /state, /predicted-state,
// /forecasts, /exposure/:ticker and /shock-feed. All five were still serving authenticated
// users from collections that had stopped being written; /shock-feed was the worst of them,
// handing out 170 opportunity cards built on June's channel state.

import { aetherAgentService }                        from '../../services/agents/aether.agent.service.js'
import { getEventCandidates, getCandidatesForTicker, tickerWindowDays, getScorecard } from './aether.service.js'
import { quickRead } from '../../services/aetherQuickRead.service.js'
import { aetherSchedulerService, DISCOVERY_DEFAULTS } from '../../services/aetherScheduler.service.js'
import { streamAgentResponse, sseAgentCallbacks }    from '../_shared/sse.util.js'
import { routeFields }                               from '../../services/routing.util.js'
import { parseChatMessages }                         from '../_shared/parse.util.js'
import { makeHandle }                                from '../_shared/handle.util.js'
import { httpError }                                 from '../../services/httpError.util.js'
import { logger }                                    from '../../services/logger.service.js'

const LOG    = '[aetherCtrl]'
const handle = makeHandle(LOG)

export async function streamAether(req, res) {
    const { messages: rawMessages, model } = req.body ?? {}
    let messages
    if (rawMessages != null) {
        const v = parseChatMessages(rawMessages)
        if (v.error) return res.status(400).json({ error: v.error })
        messages = v.messages
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
            // route / routeSymbol / opening: the user asked to be sent to another desk (routing.util).
            return { reply: result.reply, ...routeFields(result, req.user.role) }
        },
    })
}

// ─── The candidate list — a house-layer broadcast ─────────────────────────────

export const getCandidates = handle('getCandidates', async (req, res) => {
    const days           = Math.min(Number(req.query.days) || 30, 180)
    const includeDropped = req.query.includeDropped === 'true'
    res.json(await getEventCandidates({ days, includeDropped }))
})

/**
 * Every event that has reached one ticker — the "why is this name here" read.
 *
 * 404 rather than an empty object when the engine has never named it: the caller asked
 * about a specific company, and "no such candidate" is a different answer from "here is a
 * candidate with nothing in it".
 */
export const getCandidatesByTicker = handle('getCandidatesByTicker', async (req, res) => {
    // Dropped appearances are included unless explicitly excluded — see the service.
    // A name the reader already has in mind deserves "named and dropped, because…"
    // rather than silence.
    const days = tickerWindowDays(req.query.days)
    const row  = await getCandidatesForTicker(req.params.ticker, {
        days,
        includeDropped: req.query.includeDropped !== 'false',
    })
    if (!row) throw httpError(404, 'No Aether candidate for that ticker')
    res.json(row)
})

/**
 * The scorecard — what the names did, graded at expiry by the engine's nightly refresh.
 * Broadcast like the list it grades. 404 when the engine has never written one, which is
 * "the nightly has not run" and not "the card is empty".
 */
export const getScorecardRead = handle('getScorecard', async (req, res) => {
    const card = await getScorecard()
    if (!card) throw httpError(404, 'No scorecard yet — the nightly refresh has not run')
    res.json(card)
})

/**
 * Prometheus's quick read on one name from one event. Any signed-in user — it is their model
 * call, under their budget, and the result is a broadcast annotation like the list it sits on.
 * Returns the stored read when one exists; a second press mid-run joins the first. The service's
 * refusals (a bad ticker, no such candidate) are minted as 400/404; a model failure is a 500.
 */
export const postQuickRead = handle('postQuickRead', async (req, res) => {
    const { run_id: runId, ticker } = req.body ?? {}
    // The presser's AI-menu model, when the client sends one — the service validates and gates it.
    const model = typeof req.body?.model === 'string' ? req.body.model : null
    res.json(await quickRead({ runId, ticker, userId: req.user?._id, model }))
})

// ── discovery, on demand (admin) ──────────────────────────────────────────────
//
// The engine's expensive leg is not on the schedule. scheduler.py keeps the news queue
// fresh and stops there; turning a queue into named companies costs an Opus call with web
// search per event plus several hundred SEC requests, and whether today held an event
// worth that is a judgement a cron cannot make. So an admin presses it.

/**
 * Start a run. Returns 202 the moment the process is up — a run takes minutes, so the
 * response says it STARTED, never that it finished. Watch the backend log, or poll
 * GET /discover for the outcome.
 *
 * A run already in flight is the caller's answer, not a server fault — runDiscovery mints a 409 so
 * a double-click reads as "already going"; no engine on this host is its 503. A throw with no
 * minted status is a real fault and answers as one.
 */
export const startDiscovery = handle('startDiscovery', async (req, res) => {
    // Clamped, because this is the spend dial. --max-runs is a per-event multiplier on
    // both the model cost and the SEC traffic; a fat-fingered 200 is a very expensive
    // afternoon.
    const maxRuns = Math.min(Math.max(Number(req.body?.maxRuns) || DISCOVERY_DEFAULTS.maxRuns, 1), 10)
    // `hours` is an AGE CEILING on unseen queue rows, not a window: the engine reads
    // every headline the selector has not yet been shown, and this only stops a
    // long gap between presses from dumping a month into one pass. A week.
    const hours   = Math.min(Math.max(Number(req.body?.hours)   || DISCOVERY_DEFAULTS.hours, 1), 168)
    const top     = Math.min(Math.max(Number(req.body?.top)     || DISCOVERY_DEFAULTS.top, 1), 20)

    const started = aetherSchedulerService.runDiscovery({ maxRuns, hours, top })
    logger.info(LOG, `discovery requested by ${req.user?.username ?? 'admin'}`)
    res.status(202).json({ started: true, ...started })
})

/** Whether a run is going, and how the last one ended. */
export async function getDiscoveryStatus(req, res) {
    res.json(aetherSchedulerService.discoveryStatus())
}
