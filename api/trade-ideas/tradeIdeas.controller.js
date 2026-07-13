import { ideaService } from './tradeIdeas.service.js'
import { confirmManualEntry, confirmManualExit, activateManualPortfolio, requestManualPortfolioExit } from './manualIdea.service.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[tradeIdeas:controller]'

// ─── Manual (broker-less) confirmations ───────────────────────────────────────
// The two user confirmations that drive manual mode: report the real entry fill
// (price + size) and the real exit price. See docs/architecture/manual-mode.md.

const _manualErr = {
    not_found:          [404, 'Idea not found'],
    forbidden:          [403, 'Forbidden'],
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
    const [code, msg] = _manualErr[result.reason] ?? [500, 'Manual action failed']
    return res.status(code).send({ error: msg })
}

export async function confirmManualEntryOrder(req, res) {
    try {
        const { id } = req.params
        if (!id) return res.status(400).send({ error: 'Missing id' })
        const { price, quantity } = req.body ?? {}
        const result = await confirmManualEntry(id, { price, quantity }, req.user._id, req.user.isAdmin)
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
        const { price } = req.body ?? {}
        const result = await confirmManualExit(id, { price }, req.user._id, req.user.isAdmin)
        _sendManual(res, result, r => ({ idea: r.idea }))
    } catch (err) {
        logger.error(LOG, 'confirmManualExitOrder failed', err)
        res.status(500).send({ error: 'Failed to confirm manual exit' })
    }
}

export async function activateManualPortfolioOrders(req, res) {
    try {
        const { portfolioId } = req.params
        if (!portfolioId) return res.status(400).send({ error: 'Missing portfolioId' })
        const result = await activateManualPortfolio(portfolioId, req.user._id, req.user.isAdmin)
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
        const result = await requestManualPortfolioExit(portfolioId, req.user._id, req.user.isAdmin)
        _sendManual(res, result, r => ({ legs: r.legs }))
    } catch (err) {
        logger.error(LOG, 'requestManualPortfolioExitOrders failed', err)
        res.status(500).send({ error: 'Failed to request manual portfolio exit' })
    }
}

export async function getTradeIdea(req, res) {
    try {
        const { id } = req.params
        if (!id) return res.status(400).send({ error: 'Missing id' })
        const result = await ideaService.getIdeaById(id, req.user._id, req.user.isAdmin)
        if (!result.ok) {
            if (result.reason === 'not_found') return res.status(404).send({ error: 'Idea not found' })
            if (result.reason === 'forbidden') return res.status(403).send({ error: 'Forbidden' })
            return res.status(500).send({ error: 'Failed to get idea' })
        }
        res.send({ idea: result.idea })
    } catch (err) {
        logger.error(LOG, 'getTradeIdea failed', err)
        res.status(500).send({ error: 'Failed to get trade idea' })
    }
}

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

export async function getTradeIdeas(req, res) {
    try {
        const ideas = await ideaService.getIdeas(req.user._id, req.user.isAdmin)
        res.send({ ideas })
    } catch (err) {
        logger.error(LOG, 'getTradeIdeas failed', err)
        res.status(500).send({ error: 'Failed to get trade ideas' })
    }
}

export async function deleteTradeIdea(req, res) {
    try {
        const { id } = req.params
        if (!id) return res.status(400).send({ error: 'Missing id' })

        const result = await ideaService.deleteIdea(id, req.user._id, req.user.isAdmin)
        if (!result.ok) {
            if (result.reason === 'not_found')   return res.status(404).send({ error: 'Idea not found' })
            if (result.reason === 'forbidden')   return res.status(403).send({ error: 'Forbidden' })
            if (result.reason === 'in_position') return res.status(409).send({ error: 'Idea is live on the broker — close the position first', reason: 'in_position' })
            return res.status(500).send({ error: 'Failed to delete idea' })
        }

        res.send({ ok: true })
    } catch (err) {
        logger.error(LOG, 'deleteTradeIdea failed', err)
        res.status(500).send({ error: 'Failed to delete trade idea' })
    }
}

export async function createBatchIdeas(req, res) {
    try {
        const { plan, accounts = [], mainAccountId = null, portfolioId = null } = req.body ?? {}
        if (!plan?.ideas?.length) return res.status(400).send({ error: 'Missing plan.ideas' })

        const result = await ideaService.saveBatchIdeas(plan, req.user._id, accounts, mainAccountId, portfolioId)
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
        const result = await ideaService.placeOrdersForIdea(id, orders, req.user._id, req.user.isAdmin)
        if (!result.ok) {
            if (result.reason === 'not_found')      return res.status(404).send({ error: 'Idea not found' })
            if (result.reason === 'forbidden')      return res.status(403).send({ error: 'Forbidden' })
            if (result.reason === 'no_orders')      return res.status(400).send({ error: 'No orders provided' })
            if (result.reason === 'not_hit')        return res.status(400).send({ error: 'Idea is not awaiting confirmation' })
            if (result.reason === 'already_placed') return res.status(409).send({ error: 'Orders already placed' })
            if (result.reason === 'all_failed')     return res.status(502).send({ error: 'All broker orders failed', results: result.results })
            return res.status(500).send({ error: 'Failed to place orders' })
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

        const result = await ideaService.triggerEntryNow(id, req.user._id, req.user.isAdmin)
        if (!result.ok) {
            if (result.reason === 'not_found')   return res.status(404).send({ error: 'Idea not found' })
            if (result.reason === 'forbidden')   return res.status(403).send({ error: 'Forbidden' })
            if (result.reason === 'not_looking') return res.status(409).send({ error: 'Idea is not armed (looking)' })
            return res.status(500).send({ error: 'Failed to trigger entry' })
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
            'notes', 'invalidation', 'accounts', 'mainAccountId',
            'immediate', 'resetWindow', 'resetPreEntry',
        ]

        const body  = req.body ?? {}
        const patch = {}
        for (const f of EDITABLE_FIELDS) if (body[f] !== undefined) patch[f] = body[f]

        if (Object.keys(patch).length === 0) {
            return res.status(400).send({ error: 'Nothing to update' })
        }

        const result = await ideaService.updateIdea(id, patch, req.user._id, req.user.isAdmin)
        if (!result.ok) {
            if (result.reason === 'not_found')      return res.status(404).send({ error: 'Idea not found' })
            if (result.reason === 'forbidden')      return res.status(403).send({ error: 'Forbidden' })
            if (result.reason === 'invalid_status') return res.status(400).send({ error: 'Invalid status value' })
            if (result.reason === 'already_closed')  return res.status(409).send({ error: 'Idea is closed', reason: 'already_closed' })
            // Resting (broker-native stop-market) entry activation failures
            if (result.reason === 'not_resting')      return res.status(400).send({ error: 'Idea is not a resting entry' })
            if (result.reason === 'already_placed')   return res.status(409).send({ error: 'Order already placed' })
            if (result.reason === 'no_trigger_price') return res.status(400).send({ error: 'Entry is not a single price level' })
            if (result.reason === 'no_accounts')      return res.status(400).send({ error: 'No broker accounts on this idea' })
            if (result.reason === 'all_failed')       return res.status(502).send({ error: 'Broker rejected the resting order', results: result.results })
            return res.status(500).send({ error: 'Failed to update idea' })
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
