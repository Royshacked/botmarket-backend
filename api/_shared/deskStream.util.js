// The streaming desk turn over HTTP — ONE scaffold for every desk's `POST /api/<desk>/stream`.
//
// Every desk controller used to write the same thing out: validate the body, 400 on a bad one, open
// the SSE stream, read the user's experience level, call its agent with the shared callback bag,
// then return the reply with the routing fields validated for this user. Seven copies, three ways of
// parsing the body, and a field added to one was a field forgotten in the others.
//
// The desk itself is a DEFINITION (services/desks/<agent>.desk.js) that knows nothing about HTTP, so
// the same one also serves the session turn (services/desks/sessionTurn.js). What it supplies:
//   parse(body, turn, user)   the body → { state, input }, or { error } — the desk's working state
//                             (today's chatState / mode flags) and this turn's input (a seed, accounts)
//   run({ user, state, input, signal, emit, common })
//                             its agent call and any post-turn work that belongs to the desk; returns
//                             the agent's RESULT (or null when the user stopped the turn)
//   done(result, ctx)         the `done` payload: what of the result reaches the client
//
// `common` is the argument bag every agent takes (services/desks/common.js). The routing fields
// (routeFields — route / routeSymbol / edit / show / opening) are appended to every `done` payload
// here, validated for the user's role, so no desk can forget the gate. A desk that needs them while
// building its own payload (Axl's adopt flag) reads `ctx.routing`.

import { streamAgentResponse } from './sse.util.js'
import { parseDeskTurn } from './parse.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'
import { routeFields } from '../../services/routing.util.js'
import { deskCommon } from '../../services/desks/common.js'

/**
 * @param {{ log: string, parse?: Function, run: Function, done: Function }} desk
 * @param {{ experience?: Function }} [deps]  test seam for the experience-level read
 * @returns {(req: object, res: object, next?: Function) => Promise<void>}  the Express handler
 */
export function makeDeskStream({ log, parse = null, run, done }, { experience = getExperienceLevel } = {}) {
    return async function deskStream(req, res, next) {
        const turn = parseDeskTurn(req.body)
        if (turn.error) return res.status(400).json({ error: turn.error })

        // The experience level is read ALONGSIDE the desk's parse rather than after it, so it never
        // adds a round trip in front of the model call. It answers null on a failed read; the catch is
        // only so a rejection while the parse is still running can never go unhandled.
        const audience = experience(req.user._id).catch(() => null)

        // Body validation that may 400 has to finish BEFORE the stream opens — once the SSE headers
        // are out, a status code can no longer be sent. A desk's parse may read the database (the
        // house labels); a throw there goes to the global error handler, never into the void —
        // Express 4 does not see an async rejection, and the request would hang.
        let parsed
        try {
            parsed = parse ? await parse(req.body ?? {}, turn, req.user) : {}
        } catch (err) {
            return next ? next(err) : res.status(500).json({ error: 'Could not start the turn' })
        }
        if (parsed?.error) return res.status(400).json({ error: parsed.error })
        const { state = null, input = {} } = parsed ?? {}

        await streamAgentResponse(req, res, {
            log,
            handler: async ({ sendEvent, signal }) => {
                const common = deskCommon({
                    messages: turn.messages, model: turn.model, user: req.user,
                    audience: await audience, signal, emit: sendEvent,
                })
                const result = await run({ user: req.user, state, input, signal, emit: sendEvent, common })
                if (!result) return undefined
                const routing = routeFields(result, req.user.role)
                return { ...done(result, { routing }), ...routing }
            },
        })
    }
}
