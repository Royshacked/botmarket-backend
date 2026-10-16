// The streaming desk turn — ONE scaffold for every desk's `POST /api/<desk>/stream`.
//
// Every desk controller used to write the same thing out: validate the body, 400 on a bad one, open
// the SSE stream, read the user's experience level, call its agent with the shared callback bag,
// then return the reply with the routing fields validated for this user. Seven copies, three ways of
// parsing the body, and a field added to one was a field forgotten in the others.
//
// What stays with each desk is what is genuinely its own:
//   parse(req, turn)            its extra body fields (a seed, a mode flag) → an object, or { error }
//   run({ req, turn, extras,    its agent call — and any post-turn work that belongs to the desk —
//         signal, sendEvent,    returning the agent's RESULT (or null when the user stopped the turn
//         common })             and nothing should reach the client)
//   done(result, ctx)           the `done` payload: what of the result reaches the client
//
// `common` is the argument bag every agent takes: the conversation, the model, the user, the abort
// signal, the experience level and the four shared SSE callbacks. A desk spreads it into its agent
// call and adds what only it has.
//
// The routing fields (routeFields — route / routeSymbol / edit / show / opening) are appended to
// every `done` payload here, validated for the user's role, so no desk can forget the gate. A desk
// that needs them while building its own payload (Axl's adopt flag) reads `ctx.routing`.
//
// See docs/design/unified-chat-plan.md phase 2: when the session turn endpoint lands, it calls the
// same per-desk `run` with a session-built conversation — this is the seam.

import { streamAgentResponse, sseAgentCallbacks } from './sse.util.js'
import { parseDeskTurn } from './parse.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'
import { routeFields } from '../../services/routing.util.js'

/**
 * @param {{
 *   log:    string,
 *   parse?: (req: object, turn: object) => (object | Promise<object>),
 *   run:    (ctx: object) => Promise<object|null>,
 *   done:   (result: object, ctx: { req: object, routing: object }) => object,
 * }} desk
 * @param {{ experience?: Function }} [deps]  test seam for the experience-level read
 * @returns {(req: object, res: object) => Promise<void>}  the Express handler
 */
export function makeDeskStream({ log, parse = null, run, done }, { experience = getExperienceLevel } = {}) {
    return async function deskStream(req, res) {
        const turn = parseDeskTurn(req.body)
        if (turn.error) return res.status(400).json({ error: turn.error })

        // Body validation that may 400 has to finish BEFORE the stream opens — once the SSE headers
        // are out, a status code can no longer be sent.
        const extras = parse ? await parse(req, turn) : {}
        if (extras?.error) return res.status(400).json({ error: extras.error })

        await streamAgentResponse(req, res, {
            log,
            handler: async ({ sendEvent, signal }) => {
                const common = {
                    messages: turn.messages,
                    model:    turn.model,
                    userId:   req.user._id,
                    audience: await experience(req.user._id),
                    signal,
                    ...sseAgentCallbacks(sendEvent),
                }
                const result = await run({ req, turn, extras, signal, sendEvent, common })
                if (!result) return undefined
                const routing = routeFields(result, req.user.role)
                return { ...done(result, { req, routing }), ...routing }
            },
        })
    }
}
