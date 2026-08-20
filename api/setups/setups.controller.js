import { logger }       from '../../services/logger.service.js'
import { sendReason }   from '../_shared/reason.util.js'
import { makeEntityController } from '../_shared/entityController.util.js'
import { setupService } from './setups.service.js'
import { resolveCardsFor } from '../chat/chat.service.js'
import { talosHandoffService } from '../../services/talos.handoff.service.js'
import { normalizeSetup, setupReadiness, TRADE_MODES, TF_RUNGS, isFetchableRung } from '../../services/setup.schema.js'
import { TRADE_HORIZONS } from '../../services/entity/vocabulary.js'
import { hydrateBlueprint as hydrateDraft, blueprintProblems } from '../../services/setup.blueprint.js'

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

/**
 * Generate: persist a drafted setup (or update one in place when `updateId` is present).
 *
 * THE RE-DRAW IS THE WORK LANDING. An in-place update is the one write that answers "your setup
 * needs re-drawing" — and it does not come through the shared PATCH door, so the card lifecycle has
 * to be closed from here or not at all. It used to be not at all: the plan rewrite resolved nothing
 * while a mid-edit chat save resolved everything, so the card that asked for a re-draw outlived the
 * re-draw and died to a question instead.
 *
 * Only on `updateId`. A NEW setup satisfies no outstanding ask — nothing was pending about a
 * document that did not exist a moment ago.
 */
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

        // After the write, never before — a refused update has satisfied nothing. Non-fatal by
        // contract (resolveCardsFor swallows its own failures).
        if (updateId) await resolveCardsFor({ kind: 'setup', id: updateId }, { outcome: 'completed' })

        res.send(result.doc)
    } catch (err) {
        logger.error(LOG, 'Failed to generate setup', err)
        res.status(500).send({ error: 'generate_failed' })
    }
}

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
 * Hydrate a setup BLUEPRINT into a draft the express form can render.
 *
 * The one door for every way a pre-drawn plan reaches the form — the "I have the exact setup"
 * button (blueprint absent → the blank skeleton), an agent handing one over, and later a setup
 * shared by another user. They differ only in the payload, so they cannot drift in how the plan is
 * read: hydrate → the SAME `normalizeSetup` a Mentor emit goes through → the SAME readiness gate
 * the button and the save path use.
 *
 * Answers the shape a Mentor turn's `done` already answers with — `{ setup, readiness }` — so the
 * panel's existing apply path handles it with no second branch, plus `problems`: what was sent and
 * did not survive the read (see blueprintProblems). A hydrate NEVER writes; nothing exists until
 * the user sizes it and presses Generate.
 */
export async function hydrateBlueprint(req, res) {
    try {
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
    } catch (err) {
        logger.error(LOG, 'Failed to hydrate blueprint', err)
        res.status(500).send({ error: 'hydrate_failed' })
    }
}

/**
 * Re-run the readiness gate on a live draft. Reads nothing, writes nothing.
 *
 * The express form has no turns. In the build conversation `readiness` arrives with every `done`,
 * so it is never more than one reply stale; a user typing their own plan into a form would
 * otherwise stare at a dark Generate button that had last been told anything at hydrate time —
 * before they had entered a single number.
 *
 * A CLIENT-SIDE COPY OF THE GATE WAS THE OTHER OPTION AND IS THE WRONG ONE. `setupReadiness` exists
 * so the agent's claim, the button and the save path cannot disagree about what a finished setup is
 * (see its own header); a fourth implementation in JSX would disagree first and be believed longest.
 * This is pure — normalise, ask, answer — so the round trip costs a request and nothing else.
 *
 * Returns the normalised setup too, but callers driving it from a keystroke should use only
 * `readiness`: adopting the normalised copy mid-type would re-sort the band under the cursor.
 */
export async function validateDraft(req, res) {
    try {
        const { setup: raw, accounts } = req.body ?? {}
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return res.status(400).send({ error: 'setup must be an object' })
        }
        const setup = normalizeSetup(raw)
        if (!setup) return res.status(400).send({ error: 'invalid_setup' })

        res.send({
            setup,
            readiness:  setupReadiness(setup, Array.isArray(accounts) && accounts.length > 0),
            // Carried here too so the form can open straight onto a live draft (no blueprint to
            // hydrate) and still render its dropdowns from the server's vocabulary.
            vocabulary: FORM_VOCABULARY,
        })
    } catch (err) {
        logger.error(LOG, 'Failed to validate setup', err)
        res.status(500).send({ error: 'validate_failed' })
    }
}
