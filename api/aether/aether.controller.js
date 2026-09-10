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
import { getEventCandidates, getCandidatesForTicker, tickerWindowDays } from './aether.service.js'
import { aetherSchedulerService }                    from '../../services/aetherScheduler.service.js'
import { streamAgentResponse, sseAgentCallbacks }    from '../_shared/sse.util.js'
import { parseChatMessages }                         from '../_shared/parse.util.js'
import { logger }                                    from '../../services/logger.service.js'

const LOG = '[aetherCtrl]'

export async function streamAether(req, res) {
    const { messages, model } = req.body ?? {}
    if (messages !== undefined && messages !== null) {
        const v = parseChatMessages(messages)
        if (v.error) return res.status(400).json({ error: v.error })
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
            return { reply: result.reply }
        },
    })
}

// ─── The candidate list — a house-layer broadcast ─────────────────────────────



export async function getCandidates(req, res) {
    try {
        const days           = Math.min(Number(req.query.days) || 30, 180)
        const includeDropped = req.query.includeDropped === 'true'
        const runs = await getEventCandidates({ days, includeDropped })
        res.json(runs)
    } catch (err) {
        logger.error(LOG, 'getCandidates failed', err.message)
        res.status(500).json({ error: 'Could not read event candidates' })
    }
}

/**
 * Every event that has reached one ticker — the "why is this name here" read.
 *
 * 404 rather than an empty object when the engine has never named it: the caller asked
 * about a specific company, and "no such candidate" is a different answer from "here is a
 * candidate with nothing in it".
 */
export async function getCandidatesByTicker(req, res) {
    try {
        // Dropped appearances are included unless explicitly excluded — see the service.
        // A name the reader already has in mind deserves "named and dropped, because…"
        // rather than silence.
        const days = tickerWindowDays(req.query.days)
        const row  = await getCandidatesForTicker(req.params.ticker, {
            days,
            includeDropped: req.query.includeDropped !== 'false',
        })
        if (!row) return res.status(404).json({ error: 'No Aether candidate for that ticker' })
        res.json(row)
    } catch (err) {
        logger.error(LOG, 'getCandidatesByTicker failed', err.message)
        res.status(500).json({ error: 'Could not read the candidate' })
    }
}

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
 */
export async function startDiscovery(req, res) {
    try {
        // Clamped, because this is the spend dial. --max-runs is a per-event multiplier on
        // both the model cost and the SEC traffic; a fat-fingered 200 is a very expensive
        // afternoon.
        const maxRuns = Math.min(Math.max(Number(req.body?.maxRuns) || 2, 1), 10)
        const hours   = Math.min(Math.max(Number(req.body?.hours)   || 36, 1), 168)
        const top     = Math.min(Math.max(Number(req.body?.top)     || 5, 1), 20)

        const started = aetherSchedulerService.runDiscovery({ maxRuns, hours, top })
        logger.info(LOG, `discovery requested by ${req.user?.username ?? 'admin'}`)
        res.status(202).json({ started: true, ...started })
    } catch (err) {
        // A run already in flight is the caller's answer, not a server fault — 409 so a
        // double-click reads as "already going" rather than as a failure.
        const conflict = /already in flight/.test(err.message)
        logger.warn(LOG, 'startDiscovery refused', err.message)
        res.status(conflict ? 409 : 503).json({ started: false, error: err.message })
    }
}

/** Whether a run is going, and how the last one ended. */
export async function getDiscoveryStatus(req, res) {
    res.json(aetherSchedulerService.discoveryStatus())
}
