import { forgetIfDeleted } from '../../services/agentContext.service.js'
import { sendReason }   from '../_shared/reason.util.js'
import { makeHandle }   from '../_shared/handle.util.js'
import { makeEntityController } from '../_shared/entityController.util.js'
import { setupService } from './setups.service.js'
import { setupReason } from './setupReasons.js'
import { shareSetup as shareSetupService } from './setupShare.service.js'
import { talosHandoffService } from '../../services/talos.handoff.service.js'
import { normalizeSetup, setupReadiness, TRADE_MODES, TF_RUNGS, isFetchableRung } from '../../services/setup.schema.js'
import { TRADE_HORIZONS } from '../../services/entity/vocabulary.js'
import { hydrateBlueprint as hydrateDraft, blueprintProblems } from '../../services/setup.blueprint.js'
import { draftVerdict } from '../../services/setupVerdict.js'

const LOG     = '[setups:controller]'
const _handle = makeHandle(LOG)

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
        remove: async (id, userId) => forgetIfDeleted('setup', id, await setupService.deleteSetup(id, userId)),
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
export const actOnSetup = _handle('actOnSetup', async (req, res) => {
    const { id }     = req.params
    const { action } = req.body ?? {}
    const userId     = req.user._id

    const result = action === 'dismiss'
        ? await talosHandoffService.dismissSetupCard(id, userId)
        : await talosHandoffService.manageSetup(id, userId, action)

    if (!result.ok) return sendReason(res, result.reason, { overrides: setupReason, fallbackMessage: 'action_failed' })
    res.send(result)
})

/**
 * Cancel a pending limit order and return the setup to 'waiting'. The fast path for a user who
 * wants to pull the order immediately rather than waiting for the next Talos wake.
 */
export const disarmSetupEntry = _handle('disarmSetupEntry', async (req, res) => {
    const result = await talosHandoffService.disarmSetup(req.params.id, req.user._id)
    if (!result.ok) return sendReason(res, result.reason, { overrides: setupReason, fallbackMessage: 'action_failed' })
    res.send(result)
})

/** GET /:id/journal?before=<iso>&limit=50 — one page of Talos's journal, newest first. */
export const getSetupJournal = _handle('getSetupJournal', async (req, res) => {
    const { before = null, limit = 50 } = req.query ?? {}
    const result = await setupService.getSetupJournal(req.params.id, req.user._id, { before, limit: Number(limit) })
    if (!result.ok) return sendReason(res, result.reason, { overrides: setupReason, fallbackMessage: 'journal_failed' })
    res.send(result.rows)
})

/** Status transitions (arm / disarm) and chat-state saves. Plan rewrites go through generate. */
export const patchSetup  = crud.patch
export const deleteSetup = crud.remove

/**
 * POST /:id/share { conversationId, note? } — send this setup to another user as a card in a DM
 * the sender is part of. Answers the posted chat message, so the client appends it exactly as it
 * appends a text send. The judgment (what travels) is setupShare.service's.
 */
export const shareSetup = _handle('shareSetup', async (req, res) => {
    const { conversationId, note = null } = req.body ?? {}
    const result = await shareSetupService(req.params.id, req.user._id, { conversationId, note })
    if (!result.ok) return sendReason(res, result.reason, { overrides: setupReason, fallbackMessage: 'share_failed' })
    res.send(result.message)
})

// ── Generate: the one move that isn't CRUD ────────────────────────────────────
// It binds the venue, runs the readiness gate and can re-route to an in-place edit, so it stays
// hand-written — a shared shell has no business knowing any of that.

// Generate / Generate-all were routes here for Mentor's panel (they took the client's `chat_state`). Mentor's session
// actions commit through setupCommit / setupService directly (services/desks/actions/mentor.actions.js), and the routes
// went with the panel in phase 9 (2026-10-20).

// ── Blueprint: opening a plan nobody has sized yet ─────────────────────────────

/**
 * THE FORM'S DROPDOWNS, and that is the point rather than a convenience. These four vocabularies
 * are each already defined once on this side — the horizon list, the lens list, the rung ladder. A
 * client that hardcoded them would be the copy that silently refuses a lens the rest of the app has
 * gained, or offers a timeframe the providers cannot serve. Sent, not assumed.
 *
 * Frozen and shared by BOTH read-only routes: a form that opened on one bag and revalidated against
 * another would be a form whose choices changed while you were looking at it.
 */
const FORM_VOCABULARY = Object.freeze({
    directions: ['long', 'short'],
    horizons:   TRADE_HORIZONS,
    modes:      TRADE_MODES,
    // Coarse → fine, and only the rungs that can actually be FETCHED. A setup authored on a rung
    // with no candles behind it is one whose monitor reads "no data" at the end it looks at first
    // (see FINEST_RUNG in setup.schema).
    timeframes: TF_RUNGS.filter(isFetchableRung),
})

/**
 * Hydrate a setup BLUEPRINT into a draft a surface can render.
 *
 * THE RECIPIENT'S "OPEN IN MENTOR". Its first consumer was the express setup form, deleted
 * 2026-08-21 when a user arriving with a finished plan started being interviewed for it instead;
 * since 2026-09-21 it is the door a setup SHARED by another user comes through (the `setup_shared`
 * card → this → the recipient's Mentor worksheet). See services/setup.blueprint.js for the note.
 *
 * It reads the plan the one way: hydrate → the SAME `normalizeSetup` a Mentor emit goes through →
 * the SAME readiness gate the save path uses.
 *
 * Answers the shape a Mentor turn's `done` already answers with — `{ setup, readiness }` — so the
 * panel's existing apply path handles it with no second branch, plus `problems`: what was sent and
 * did not survive the read (see blueprintProblems). A hydrate NEVER writes; nothing exists until
 * the user sizes it and presses Generate.
 */
export const hydrateBlueprint = _handle('hydrateBlueprint', async (req, res) => {
    const { blueprint = null, accounts } = req.body ?? {}
    if (blueprint != null && (typeof blueprint !== 'object' || Array.isArray(blueprint))) {
        return res.status(400).send({ error: 'blueprint must be an object' })
    }

    const setup    = normalizeSetup(hydrateDraft(blueprint))
    const problems = blueprintProblems(blueprint, setup)
    if (!setup) return res.status(400).send({ error: 'invalid_blueprint', problems })

    // `hasAccount` mirrors Generate's own question rather than re-deriving one: the marked
    // account lives in client state during authoring and is not bound until the save.
    const readiness = setupReadiness(setup, Array.isArray(accounts) && accounts.length > 0)

    res.send({
        setup,
        readiness,
        problems,
        // Envelope metadata, never folded into the setup: whose plan this was and when it was
        // drawn are things the FORM says out loud, not things the monitor watches.
        drawn_at: blueprint?.drawn_at ?? null,
        from:     blueprint?.from ?? null,
        vocabulary: FORM_VOCABULARY,
    })
})

/**
 * Re-run the readiness gate on a live draft. Reads nothing, writes nothing.
 *
 * FOR A SURFACE THAT HAS NO TURNS. In the build conversation `readiness` arrives with every `done`,
 * so it is never more than one reply stale; anything that lets the user edit a plan OUTSIDE a turn
 * — the deleted express form, and the shared-setup surface it is kept for — would otherwise leave
 * them staring at a dark Generate button last told anything before they typed a single number.
 *
 * A CLIENT-SIDE COPY OF THE GATE WAS THE OTHER OPTION AND IS THE WRONG ONE. `setupReadiness` exists
 * so the agent's claim, the button and the save path cannot disagree about what a finished setup is
 * (see its own header); a fourth implementation in JSX would disagree first and be believed longest.
 * This is pure — normalise, ask, answer — so the round trip costs a request and nothing else.
 *
 * Returns the normalised setup too, but callers driving it from a keystroke should use only
 * `readiness`: adopting the normalised copy mid-type would re-sort the band under the cursor.
 */
export const validateDraft = _handle('validateDraft', async (req, res) => {
    const { setup: raw, accounts } = req.body ?? {}
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return res.status(400).send({ error: 'setup must be an object' })
    }
    // A REOPENED conversation used to land with no verdict and no gate at all — Generate dark with nothing
    // said, and no entries table to press — until the user sent another message. One ask answers both, from
    // the same functions a turn uses (services/setupVerdict.js, shared with Mentor's session edit).
    const verdict = draftVerdict(raw, Array.isArray(accounts) && accounts.length > 0)
    if (!verdict) return res.status(400).send({ error: 'invalid_setup' })
    const { setup, readiness, gate } = verdict

    res.send({
        setup,
        readiness,
        ...(gate ? { gate } : {}),
        // Carried here too so the form can open straight onto a live draft (no blueprint to
        // hydrate) and still render its dropdowns from the server's vocabulary.
        vocabulary: FORM_VOCABULARY,
    })
})
