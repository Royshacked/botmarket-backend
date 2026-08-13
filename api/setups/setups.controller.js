import { logger }       from '../../services/logger.service.js'
import { sendReason }   from '../_shared/reason.util.js'
import { makeEntityController } from '../_shared/entityController.util.js'
import { setupService } from './setups.service.js'
import { talosHandoffService } from '../../services/talos.handoff.service.js'

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
    // Management refusals. `confirm_order` is not an error the user caused: a printing second leg is
    // placed by confirming its order, so the client is being told WHERE the action lives.
    confirm_order:     [409, 'That leg is placed by confirming its order, not from here'],
    no_pending_action: [409, 'Talos has not proposed that'],
    bad_proposal:      [422, 'The proposal is missing the level it needs'],
    no_position_link:  [409, 'No broker position is linked to this setup'],
}
// Named reasons win over the prefix rules — `invalid_setup` / `invalid_zone` have their own copy and
// must not be swallowed by the generic `invalid_*` passthrough below them.
const setupReason = (reason) =>
    SETUP_REASONS[reason]
    ?? ((reason?.startsWith('missing_') || reason?.startsWith('cannot_arm_') || reason?.startsWith('invalid_'))
        ? [400, reason]
        : null)

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

/**
 * Act on a setup's in-position management card: accept the pending proposal, or dismiss the card
 * and keep the position. The Mentor twin of `POST /api/kairos/:id/action` — same verb names, same
 * refusal vocabulary, so a client that can drive one can drive the other.
 *
 * `add_leg` is deliberately NOT here: Talos parks that leg as a pending ORDER, so it is taken by
 * confirming the order. Asking for it returns `confirm_order` rather than a flat 400 — the client
 * needs to know it should route, not that it made a bad request.
 */
export async function actOnSetup(req, res) {
    try {
        const { id }     = req.params
        const { action } = req.body ?? {}
        const userId     = req.user._id

        const result = action === 'dismiss'
            ? await talosHandoffService.dismissSetupCard(id, userId)
            : await talosHandoffService.manageSetup(id, userId, action)

        if (!result.ok) return sendReason(res, result.reason, { overrides: setupReason, fallbackMessage: 'action_failed' })
        res.send(result)
    } catch (err) {
        logger.error(LOG, 'actOnSetup failed:', err.message)
        res.status(500).send({ error: 'action_failed' })
    }
}
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
