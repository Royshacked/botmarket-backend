import { ideaService } from './tradeIdeas.service.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[tradeIdeas:controller]'

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
        if (!result.ok) return res.status(500).send({ error: 'Failed to save idea' })

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

export async function updateTradeIdea(req, res) {
    try {
        const { id } = req.params
        if (!id) return res.status(400).send({ error: 'Missing id' })

        const {
            status, type, quantity, additional_entries, timeframe,
            entry_timeframe, stop_timeframe, tp_timeframe,
            chat_state,
            entry_conditions, entry_logic, entry_condition_tree,
            stop_conditions,  stop_logic,  stop_condition_tree,
            tp_conditions,    tp_logic,    tp_condition_tree,
            notes, invalidation,
            accounts, mainAccountId,
            resetWindow,
        } = req.body ?? {}

        if (!status && type === undefined && quantity === undefined && timeframe === undefined &&
            entry_timeframe === undefined && stop_timeframe === undefined && tp_timeframe === undefined &&
            additional_entries === undefined && chat_state === undefined &&
            entry_conditions === undefined && stop_conditions === undefined && tp_conditions === undefined &&
            entry_logic === undefined && stop_logic === undefined && tp_logic === undefined &&
            entry_condition_tree === undefined && stop_condition_tree === undefined && tp_condition_tree === undefined &&
            accounts === undefined && mainAccountId === undefined &&
            invalidation === undefined && resetWindow === undefined &&
            notes === undefined) {
            return res.status(400).send({ error: 'Nothing to update' })
        }

        const patch = {}
        if (status !== undefined)              patch.status = status
        if (type !== undefined)                patch.type = type
        if (quantity !== undefined)            patch.quantity = quantity
        if (additional_entries !== undefined)  patch.additional_entries = additional_entries
        if (timeframe !== undefined)             patch.timeframe = timeframe
        if (entry_timeframe !== undefined)       patch.entry_timeframe = entry_timeframe
        if (stop_timeframe !== undefined)        patch.stop_timeframe = stop_timeframe
        if (tp_timeframe !== undefined)          patch.tp_timeframe = tp_timeframe
        if (chat_state !== undefined)            patch.chat_state = chat_state
        if (entry_conditions !== undefined)      patch.entry_conditions = entry_conditions
        if (entry_logic !== undefined)           patch.entry_logic = entry_logic
        if (entry_condition_tree !== undefined)  patch.entry_condition_tree = entry_condition_tree
        if (stop_conditions !== undefined)       patch.stop_conditions = stop_conditions
        if (stop_logic !== undefined)            patch.stop_logic = stop_logic
        if (stop_condition_tree !== undefined)   patch.stop_condition_tree = stop_condition_tree
        if (tp_conditions !== undefined)         patch.tp_conditions = tp_conditions
        if (tp_logic !== undefined)              patch.tp_logic = tp_logic
        if (tp_condition_tree !== undefined)     patch.tp_condition_tree = tp_condition_tree
        if (notes !== undefined)                 patch.notes = notes
        // Editable invalidation range (the edit-link path re-arms the watcher):
        // the service normalizes it and resets the invalidation_* latch fields.
        if (invalidation !== undefined)          patch.invalidation = invalidation
        // Broker accounts attached to the idea (e.g. attaching an account after the
        // fact so a re-activated idea can actually place orders). Without these the
        // monitor flips the idea to 'hit' but builds no order plan (alert-only).
        if (accounts !== undefined)              patch.accounts = accounts
        if (mainAccountId !== undefined)         patch.mainAccountId = mainAccountId
        // Control flag (not persisted): distinguishes "reset window" from a plain
        // dismiss on a hit→waiting transition. Stripped in the service before write.
        if (resetWindow !== undefined)           patch.resetWindow = resetWindow

        const result = await ideaService.updateIdea(id, patch, req.user._id, req.user.isAdmin)
        if (!result.ok) {
            if (result.reason === 'not_found')      return res.status(404).send({ error: 'Idea not found' })
            if (result.reason === 'forbidden')      return res.status(403).send({ error: 'Forbidden' })
            if (result.reason === 'invalid_status') return res.status(400).send({ error: 'Invalid status value' })
            // Resting (broker-native stop-market) entry activation failures
            if (result.reason === 'not_resting')      return res.status(400).send({ error: 'Idea is not a resting entry' })
            if (result.reason === 'already_placed')   return res.status(409).send({ error: 'Order already placed' })
            if (result.reason === 'no_trigger_price') return res.status(400).send({ error: 'Entry is not a single price level' })
            if (result.reason === 'no_accounts')      return res.status(400).send({ error: 'No broker accounts on this idea' })
            if (result.reason === 'all_failed')       return res.status(502).send({ error: 'Broker rejected the resting order', results: result.results })
            return res.status(500).send({ error: 'Failed to update idea' })
        }

        res.send({ idea: result.idea, ...(result.results && { results: result.results }) })
    } catch (err) {
        logger.error(LOG, 'updateTradeIdea failed', err)
        res.status(500).send({ error: 'Failed to update trade idea' })
    }
}
