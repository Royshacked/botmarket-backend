import { logger }       from '../../services/logger.service.js'
import { sendReason }   from '../_shared/reason.util.js'
import { makeEntityController } from '../_shared/entityController.util.js'
import { setupService } from './setups.service.js'

const LOG = '[setups:controller]'

// Setup-OWNED reasons. Everything cross-kind (not_found / forbidden / in_position /
// closed_is_terminal / invalid_status / nothing_to_patch) is answered by the shared table, so this
// route can no longer disagree with the idea and call routes about what a refusal means.
//
// What's left is the Generate gate: `missing_*` says the draft isn't finished and `cannot_arm_*`
// says re-running that gate at Arm time failed (the broker disconnected after Generate). Both are
// "fix it in the chat" — a 400 carrying the slug, never a 500.
const SETUP_REASONS = {
    invalid_setup: [400, 'The draft is not a usable setup'],
    invalid_zone:  [400, 'A zone is inverted or not numeric'],
    no_venue:      [400, 'Mark a trading account before generating'],
}
const setupReason = (reason) =>
    (reason?.startsWith('missing_') || reason?.startsWith('cannot_arm_'))
        ? [400, reason]
        : SETUP_REASONS[reason] ?? null

// list / get / patch / delete are the shared HTTP tier — the same moves every kind makes, over the
// same crud. Arming IS a patch (`{status:'looking'}`); the gate it re-runs lives in the service,
// which is where the judgment belongs.
const crud = makeEntityController({
    log: LOG, noun: 'setup', overrides: setupReason,
    service: {
        // `?status=looking` — the Arm-state filter the setups list uses. It is a LIST option, not
        // a body, which is why the shell hands the request through.
        list:   (userId, req)      => setupService.listSetups(userId, { status: req.query?.status ?? null }),
        get:    (id, userId)       => setupService.getSetup(id, userId),
        patch:  (id, body, userId) => setupService.patchSetup(id, body, userId),
        remove: (id, userId)       => setupService.deleteSetup(id, userId),
    },
})

export const listSetups  = crud.list
export const getSetup    = crud.get
/** Status transitions (arm / disarm) and chat-state saves. Plan rewrites go through generate. */
export const patchSetup  = crud.patch
export const deleteSetup = crud.remove

// ── Generate: the one move that isn't CRUD ────────────────────────────────────
// It binds the venue, runs the readiness gate and can re-route to an in-place edit, so it stays
// hand-written — a shared shell has no business knowing any of that.

/** Generate: persist a drafted setup (or update one in place when `updateId` is present). */
export async function generateSetup(req, res) {
    try {
        const { setup, accounts, mainAccountId, updateId, chat_state } = req.body ?? {}
        if (!setup || typeof setup !== 'object' || Array.isArray(setup)) {
            return res.status(400).send({ error: 'setup must be an object' })
        }

        const result = await setupService.generateSetup(setup, {
            userId:   req.user._id,
            accounts: Array.isArray(accounts) ? accounts : [],
            mainAccountId,
            updateId: updateId ?? null,
            chatState: chat_state,
        })
        if (!result.ok) return sendReason(res, result.reason, { overrides: setupReason, fallback: 500 })

        res.send(result.doc)
    } catch (err) {
        logger.error(LOG, 'Failed to generate setup', err)
        res.status(500).send({ error: 'generate_failed' })
    }
}
