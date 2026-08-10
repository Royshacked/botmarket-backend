import { ideaService } from './tradeIdeas.service.js'
import { confirmManualEntry, confirmManualExit, confirmManualAdd, activateManualPortfolio, requestManualPortfolioExit } from './manualIdea.service.js'
import { sendReason } from '../_shared/reason.util.js'
import { makeEntityController } from '../_shared/entityController.util.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[tradeIdeas:controller]'

// Every table below holds ONLY reasons this route owns. The cross-kind ones — not_found,
// forbidden, in_position, already_placed, already_closed, invalid_status — come from the shared
// map (reason.util.js), which is what stops this route and the call/setup routes from answering
// the same refusal with different statuses.

// ─── Manual (broker-less) confirmations ───────────────────────────────────────
// The two user confirmations that drive manual mode: report the real entry fill
// (price + size) and the real exit price. See docs/architecture/manual-mode.md.
//
// `already_placed` is deliberately re-worded here — in manual mode it means the FILL was already
// reported, not that broker orders went out — but it keeps the shared 409.

const _manualErr = {
    not_manual:         [400, 'Not a manual idea'],
    already_placed:     [409, 'Already filled'],
    not_awaiting_fill:  [409, 'Idea is not awaiting a manual fill'],
    not_in_position:    [409, 'Idea is not in a position'],
    no_account:         [400, 'No account bound'],
    no_position:        [409, 'No open position to close'],
    bad_price:          [400, 'A valid fill price is required'],
    bad_quantity:       [400, 'A valid quantity is required'],
    nothing_to_activate:[409, 'No manual legs to activate'],
    nothing_open:       [409, 'No open manual legs to exit'],
}

function _sendManual(res, result, onOk) {
    if (result.ok) return res.send(onOk(result))
    return sendReason(res, result.reason, { overrides: _manualErr, fallback: 500, fallbackMessage: 'Manual action failed' })
}

export async function confirmManualEntryOrder(req, res) {
    try {
        const { id } = req.params
        if (!id) return res.status(400).send({ error: 'Missing id' })
        const { price, quantity } = req.body ?? {}
        const result = await confirmManualEntry(id, { price, quantity }, req.user._id)
        _sendManual(res, result, r => ({ idea: r.idea }))
    } catch (err) {
        logger.error(LOG, 'confirmManualEntryOrder failed', err)
        res.status(500).send({ error: 'Failed to confirm manual entry' })
    }
}

export async function confirmManualExitOrder(req, res) {
    try {
        const { id } = req.params
        if (!id) return res.status(400).send({ error: 'Missing id' })
        const { price, quantity } = req.body ?? {}
        const result = await confirmManualExit(id, { price, quantity }, req.user._id)
        _sendManual(res, result, r => ({ idea: r.idea }))
    } catch (err) {
        logger.error(LOG, 'confirmManualExitOrder failed', err)
        res.status(500).send({ error: 'Failed to confirm manual exit' })
    }
}

export async function confirmManualAddOrder(req, res) {
    try {
        const { id } = req.params
        if (!id) return res.status(400).send({ error: 'Missing id' })
        const { price, quantity } = req.body ?? {}
        const result = await confirmManualAdd(id, { price, quantity }, req.user._id)
        _sendManual(res, result, r => ({ idea: r.idea }))
    } catch (err) {
        logger.error(LOG, 'confirmManualAddOrder failed', err)
        res.status(500).send({ error: 'Failed to confirm manual add' })
    }
}

export async function activateManualPortfolioOrders(req, res) {
    try {
        const { portfolioId } = req.params
        if (!portfolioId) return res.status(400).send({ error: 'Missing portfolioId' })
        const result = await activateManualPortfolio(portfolioId, req.user._id)
        _sendManual(res, result, r => ({ legs: r.legs }))
    } catch (err) {
        logger.error(LOG, 'activateManualPortfolioOrders failed', err)
        res.status(500).send({ error: 'Failed to activate manual portfolio' })
    }
}

export async function requestManualPortfolioExitOrders(req, res) {
    try {
        const { portfolioId } = req.params
        if (!portfolioId) return res.status(400).send({ error: 'Missing portfolioId' })
        const result = await requestManualPortfolioExit(portfolioId, req.user._id)
        _sendManual(res, result, r => ({ legs: r.legs }))
    } catch (err) {
        logger.error(LOG, 'requestManualPortfolioExitOrders failed', err)
        res.status(500).send({ error: 'Failed to request manual portfolio exit' })
    }
}

// list / get / delete are the shared HTTP tier. What this route keeps that the newer ones don't is
// its BODY SHAPE: it answers `{ idea }` / `{ ideas }` where /api/setups and /api/kairos answer the
// bare document. That's a transport difference the clients already depend on (the frontend's
// makeEntityApi carries the mirror of it as `listKey`), so it is configured, not re-implemented.
const crud = makeEntityController({
    log: LOG, noun: 'idea', envelope: { one: 'idea', many: 'ideas' },
    service: {
        list:   (userId)     => ideaService.getIdeas(userId),
        get:    (id, userId) => ideaService.getIdeaById(id, userId),
        remove: (id, userId) => ideaService.deleteIdea(id, userId),
    },
})

export const getTradeIdea     = crud.get
export const getTradeIdeas    = crud.list
export const deleteTradeIdea  = crud.remove

export async function createTradeIdea(req, res) {
    try {
        const body = req.body ?? {}
        if (!body.asset && !body.ticker) return res.status(400).send({ error: 'Missing asset' })

        const result = await ideaService.saveIdea(body, req.user._id)
        if (!result.ok) {
            if (result.reason === 'no_venue') {
                return res.status(422).send({ error: result.error?.message ?? 'No trading venue', reason: 'no_venue' })
            }
            return res.status(500).send({ error: 'Failed to save idea' })
        }

        // `idea` = primary child (back-compat); `ideas` = all children when a
        // multi-broker idea was forked into independent single-broker children.
        res.status(201).send({ idea: result.idea, ideas: result.ideas ?? [result.idea] })
    } catch (err) {
        logger.error(LOG, 'createTradeIdea failed', err)
        res.status(500).send({ error: 'Failed to create trade idea' })
    }
}

export async function createBatchIdeas(req, res) {
    try {
        const { plan, accounts = [], mainAccountId = null, portfolioId = null } = req.body ?? {}
        if (!plan?.ideas?.length) return res.status(400).send({ error: 'Missing plan.ideas' })

        // Construction stays LENIENT about a failed leg (`result.failed`): the book is a proposal the
        // user is about to review, where a missing line is visible and fixable. Adoption reads the
        // same field and refuses — see adoptBook.service.
        const result = await ideaService.saveBatchIdeas(plan, req.user._id, { accounts, mainAccountId, portfolioId })
        if (!result.ok) return res.status(500).send({ error: 'Failed to save batch' })

        res.status(201).send({ ideas: result.ideas, portfolioId: result.portfolioId })
    } catch (err) {
        logger.error(LOG, 'createBatchIdeas failed', err)
        res.status(500).send({ error: 'Failed to create batch ideas' })
    }
}

export async function placeTradeIdeaOrders(req, res) {
    try {
        const { id } = req.params
        if (!id) return res.status(400).send({ error: 'Missing id' })

        const { orders } = req.body ?? {}
        const result = await ideaService.placeOrdersForIdea(id, orders, req.user._id)
        if (!result.ok) {
            // `all_failed` is the one refusal that isn't the client's fault or the entity's state:
            // the request was fine and every broker rejected it — 502, with the per-order results.
            const PLACE = {
                no_orders:  [400, 'No orders provided'],
                not_hit:    [400, 'Idea is not awaiting confirmation'],
                all_failed: [502, 'All broker orders failed'],
                // Not a rejection: the simulated venue prices off our own feed, and the feed was
                // briefly unavailable. 503 (+ the symbol) so the client can say "try again in a
                // moment" rather than implying a venue turned the trade down.
                no_price:   [503, 'No live price right now — try again in a moment'],
            }
            return sendReason(res, result.reason, {
                overrides: PLACE, fallback: 500, fallbackMessage: 'Failed to place orders',
                extra: ['all_failed', 'no_price'].includes(result.reason)
                    ? { results: result.results, ...(result.symbol && { symbol: result.symbol }) }
                    : null,
            })
        }

        res.send({ idea: result.idea, results: result.results })
    } catch (err) {
        logger.error(LOG, 'placeTradeIdeaOrders failed', err)
        res.status(500).send({ error: 'Failed to place orders' })
    }
}

// "Buy now" from the arm-time pre-flight prompt: force-trigger a 'looking' idea's
// entry (→ 'hit' + built plan) so the normal order-confirm dialog appears.
export async function triggerTradeIdeaEntry(req, res) {
    try {
        const { id } = req.params
        if (!id) return res.status(400).send({ error: 'Missing id' })

        const result = await ideaService.triggerEntryNow(id, req.user._id)
        if (!result.ok) {
            return sendReason(res, result.reason, {
                overrides: { not_looking: [409, 'Idea is not armed (looking)'] },
                fallback: 500, fallbackMessage: 'Failed to trigger entry',
            })
        }

        res.send({ idea: result.idea })
    } catch (err) {
        logger.error(LOG, 'triggerTradeIdeaEntry failed', err)
        res.status(500).send({ error: 'Failed to trigger entry' })
    }
}

export async function updateTradeIdea(req, res) {
    try {
        const { id } = req.params
        if (!id) return res.status(400).send({ error: 'Missing id' })

        // One whitelist drives both the patch and the "nothing to update" guard, so adding
        // a field is a single-line change that can't silently drop (the old dual-list trap).
        // Notes on select fields: `invalidation` re-arms the watcher (service normalizes +
        // resets the latch); `accounts`/`mainAccountId` attach broker accounts to a
        // re-activated idea; `immediate` market-enters a pending idea; `resetWindow`/
        // `resetPreEntry` are control flags stripped in the service before write.
        const EDITABLE_FIELDS = [
            'status', 'type', 'quantity', 'additional_entries',
            'timeframe', 'entry_timeframe', 'stop_timeframe', 'tp_timeframe',
            'chat_state',
            'entry_conditions', 'entry_logic', 'entry_condition_tree',
            'stop_conditions',  'stop_logic',  'stop_condition_tree',
            'tp_conditions',    'tp_logic',    'tp_condition_tree',
            // The bare-price form of the same three legs. The ticket states a level as a NUMBER
            // and nothing else — the service expands it into the `touch` leaf (applyPriceLevels)
            // — so if these aren't editable the patch arrives empty and the whole request is
            // refused as "Nothing to update", which is what a ticket stop/target used to hit.
            'entry_price', 'stop_price', 'tp_price',
            'notes', 'invalidation', 'accounts', 'mainAccountId',
            'immediate', 'resetWindow', 'resetPreEntry',
        ]

        const body  = req.body ?? {}
        const patch = {}
        for (const f of EDITABLE_FIELDS) if (body[f] !== undefined) patch[f] = body[f]

        if (Object.keys(patch).length === 0) {
            return res.status(400).send({ error: 'Nothing to update' })
        }

        const result = await ideaService.updateIdea(id, patch, req.user._id)
        if (!result.ok) {
            // Resting (broker-native stop-market) entry activation failures — all idea-only.
            const UPDATE = {
                not_resting:      [400, 'Idea is not a resting entry'],
                no_trigger_price: [400, 'Entry is not a single price level'],
                no_accounts:      [400, 'No broker accounts on this idea'],
                all_failed:       [502, 'Broker rejected the resting order'],
            }
            return sendReason(res, result.reason, {
                overrides: UPDATE, fallback: 500, fallbackMessage: 'Failed to update idea',
                extra: result.reason === 'all_failed' ? { results: result.results } : null,
            })
        }

        res.send({
            idea: result.idea,
            ...(result.results  && { results:  result.results }),
            ...(result.preEntry && { preEntry: result.preEntry }),
        })
    } catch (err) {
        logger.error(LOG, 'updateTradeIdea failed', err)
        res.status(500).send({ error: 'Failed to update trade idea' })
    }
}
