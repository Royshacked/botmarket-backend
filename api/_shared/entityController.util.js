import { logger }     from '../../services/logger.service.js'
import { sendReason } from './reason.util.js'

// ONE HTTP tier for owner-scoped entities — the controller twin of makeEntityCrud, and the last
// per-kind plumbing on this side.
//
// list / get / patch / delete were the same eleven lines in three controllers: try, call the
// service, branch on `result.ok`, map the reason, log the throw, answer a 500. Reading your own
// setups and reading your own calls is the same HTTP move, exactly as it is the same query one
// layer down.
//
// SHARE THE PIPE, NOT THE JUDGMENT. What a Generate validates, what an action verb means, whether
// a patch arms or disarms — those stay in the kind's own controller and are not expressible here.
// What lives here is: call, unwrap, answer, and never let a throw escape as anything but a 500.
//
// The two things a kind DOES configure are transport shape, not judgment:
//   • `noun`     — the word in a fallback message ("Failed to delete setup")
//   • `envelope` — the legacy /api/trade-ideas route answers `{ idea }` / `{ ideas }` while the
//                  newer routes answer the bare document. Same difference the frontend's
//                  makeEntityApi carries as `listKey`.
//
// Services handed to this factory answer in the crud's own shape: `{ ok:true, doc }` /
// `{ ok:true }` / `{ ok:false, reason }`. Anything richer than a document (a performance
// aggregate, a place-orders result) is not a CRUD move and keeps its own handler.

/**
 * @param {Object} cfg
 * @param {string} cfg.log                     log tag, so a failure still reads as the caller's
 * @param {string} cfg.noun                    'setup' | 'call' | 'idea' — fallback message wording
 * @param {Object} cfg.service
 * @param {Function} [cfg.service.list]        (userId) => Promise<object[]>
 * @param {Function} [cfg.service.get]         (id, userId) => Promise<{ok, doc}>
 * @param {Function} [cfg.service.patch]       (id, body, userId) => Promise<{ok, doc}>
 * @param {Function} [cfg.service.remove]      (id, userId) => Promise<{ok}>
 * @param {{one?:string, many?:string}} [cfg.envelope]  wrap the body under a key
 * @param {Object|Function} [cfg.overrides]    route-owned reasons (see reason.util)
 * @returns {{list:Function, get:Function, patch:Function, remove:Function}} express handlers
 */
export function makeEntityController({ log, noun, service, envelope = null, overrides = null }) {
    const one  = (doc)  => (envelope?.one  ? { [envelope.one]: doc }   : doc)
    const many = (docs) => (envelope?.many ? { [envelope.many]: docs } : docs)

    // A thrown error is not a refusal: the service never got to decide, so it is always a 500 and
    // always logged. Refusals (`{ok:false, reason}`) are answered by the shared reason map — the
    // fallback is 500 for the same reason it is in the service: an unclaimed reason means the
    // route broke, not that the request was bad.
    const guard = (what, run) => async (req, res) => {
        try {
            return await run(req, res)
        } catch (err) {
            logger.error(log, `Failed to ${what} ${noun}`, err)
            return res.status(500).send({ error: `Failed to ${what} ${noun}` })
        }
    }
    const fail = (res, reason, what) =>
        sendReason(res, reason, { overrides, fallback: 500, fallbackMessage: `Failed to ${what} ${noun}` })

    return {
        list: guard('list', async (req, res) => {
            res.send(many(await service.list(req.user._id, req)))
        }),

        get: guard('get', async (req, res) => {
            const result = await service.get(req.params.id, req.user._id)
            if (!result.ok) return fail(res, result.reason, 'get')
            res.send(one(result.doc))
        }),

        patch: guard('patch', async (req, res) => {
            const result = await service.patch(req.params.id, req.body ?? {}, req.user._id)
            if (!result.ok) return fail(res, result.reason, 'patch')
            res.send(one(result.doc))
        }),

        remove: guard('delete', async (req, res) => {
            const result = await service.remove(req.params.id, req.user._id)
            if (!result.ok) return fail(res, result.reason, 'delete')
            res.send({ ok: true })
        }),
    }
}
