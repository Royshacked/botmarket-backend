import { sealing } from '../../services/desks/seal.js'
import { ideaService } from './tradeIdeas.service.js'
import { confirmManualEntry, confirmManualExit, confirmManualAdd, activateManualPortfolio, requestManualPortfolioExit } from './manualIdea.service.js'
import { sendReason } from '../_shared/reason.util.js'
import { makeEntityController } from '../_shared/entityController.util.js'
import { makeHandle } from '../_shared/handle.util.js'
import { industriesFor, limitAddByRatio } from '../../services/industryLimits.service.js'
import { listPortfolioItems } from '../../services/portfolioState.service.js'
import { portfolioChatService } from '../portfolio/portfolioChat.service.js'
import { portfolioCommit } from '../portfolio/portfolioCommit.service.js'
import { TERMINAL } from '../../services/entity/vocabulary.js'

const LOG     = '[tradeIdeas:controller]'
const _handle = makeHandle(LOG)

// Every table below holds ONLY reasons this route owns. The cross-kind ones — not_found,
// forbidden, in_position, already_placed, already_closed, invalid_status, nothing_to_patch — come
// from the shared map (reason.util.js), which is what stops this route and the call/setup routes
// from answering the same refusal with different statuses.
//
// ERROR SHAPE. Every handler is wrapped in `_handle` (api/_shared/handle.util): a throw is logged
// with its route and formatted by the one global error handler. The services here already catch
// their own failures and answer `{ ok:false, error }`, so the wrapper is the backstop for a
// programming error, not the normal refusal path — that is `sendReason`.

/** `:id` is required on every entity route; a missing one is the client's mistake, not ours. */
function _requireId(req, res, name = 'id') {
    if (req.params?.[name]) return req.params[name]
    res.status(400).send({ error: `Missing ${name}` })
    return null
}

// ─── Manual (broker-less) confirmations ───────────────────────────────────────
// The two user confirmations that drive manual mode: report the real entry fill
// (price + size) and the real exit price. See docs/architecture/virtual-venue.md.
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

/** The three per-idea fill confirmations share one shape: `:id` + `{ price, quantity }` → `{ idea }`. */
const _manualIdeaAction = (label, fn) => _handle(label, async (req, res) => {
    const id = _requireId(req, res)
    if (!id) return
    const { price, quantity } = req.body ?? {}
    _sendManual(res, await fn(id, { price, quantity }, req.user._id), r => ({ idea: r.idea }))
})

export const confirmManualEntryOrder = _manualIdeaAction('confirmManualEntryOrder', confirmManualEntry)
export const confirmManualExitOrder  = _manualIdeaAction('confirmManualExitOrder',  confirmManualExit)
export const confirmManualAddOrder   = _manualIdeaAction('confirmManualAddOrder',   confirmManualAdd)   // scale INTO a live manual position

/** The two per-portfolio manual actions: `:portfolioId` → `{ legs }`. */
const _manualPortfolioAction = (label, fn) => _handle(label, async (req, res) => {
    const portfolioId = _requireId(req, res, 'portfolioId')
    if (!portfolioId) return
    _sendManual(res, await fn(portfolioId, req.user._id), r => ({ legs: r.legs }))
})

export const activateManualPortfolioOrders    = _manualPortfolioAction('activateManualPortfolioOrders',    activateManualPortfolio)
export const requestManualPortfolioExitOrders = _manualPortfolioAction('requestManualPortfolioExitOrders', requestManualPortfolioExit)

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

/**
 * The house's industry limits on ONE idea added to a BOOK by weight — an edit-mode add (code review 2026-10-11: those
 * reached this route and skipped every limit). The book's open ideas carry ratios; the mandate decides the single-
 * industry exception. Read failures do not block (industriesFor logs them). Injectable for tests.
 */
const _bookDeps = {
    siblings: (portfolioId, userId) => listPortfolioItems(portfolioId, userId, { projection: { _id: 0, asset: 1, allocationRatio: 1, status: 1 } }),
    mandate:  (portfolioId, userId) => portfolioChatService.getMandate(portfolioId, userId),
    views:    (symbols) => industriesFor(symbols),
}
export function _setBookDeps(d) { Object.assign(_bookDeps, d) }

export async function _bookAddGate(body, userId, deps = _bookDeps) {
    const siblings = (await deps.siblings(body.portfolioId, userId).catch(() => [])).filter(s => !TERMINAL.includes(s.status))
    const [views, mandate] = await Promise.all([
        deps.views([body.asset ?? body.ticker, ...siblings.map(s => s.asset)]),
        deps.mandate(body.portfolioId, userId).catch(() => null),
    ])
    return limitAddByRatio({ asset: body.asset ?? body.ticker, allocationRatio: body.allocationRatio }, siblings, views, { mandate, avoidOk: body.avoid_ok })
}

export const createTradeIdea = _handle('createTradeIdea', async (req, res) => {
    let body = req.body ?? {}
    if (!body.asset && !body.ticker) return res.status(400).send({ error: 'Missing asset' })

    if (body.portfolioId) {
        const gate = await _bookAddGate(body, req.user._id)
        if (!gate.ok) return res.status(409).send({ error: gate.reason, outcome: gate.reason, detail: gate.detail, ...(gate.avoid ? { avoid: gate.avoid } : {}) })
        const { avoid_ok, ...rest } = body   // eslint-disable-line no-unused-vars -- the OK is a request flag, not part of the idea
        body = { ...rest, ...(gate.allocationRatio != null ? { allocationRatio: Number(gate.allocationRatio.toFixed(4)) } : {}) }
    }

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
})

export const createBatchIdeas = _handle('createBatchIdeas', async (req, res) => {
    const { plan, accounts = [], mainAccountId = null, portfolioId = null, avoid_ok = [] } = req.body ?? {}
    if (!plan?.ideas?.length) return res.status(400).send({ error: 'Missing plan.ideas' })

    // The AVOID ask and the batch are the book's commit — one service, shared with Atlas's session action.
    const result = await portfolioCommit.createBook(plan, req.user._id, { accounts, mainAccountId, portfolioId, avoidOk: avoid_ok })
    if (result.reason === 'avoid_needs_ok') {
        return res.status(409).send({ error: 'avoid_needs_ok', outcome: 'avoid_needs_ok', avoid: result.avoid })
    }
    if (!result.ok) return res.status(500).send({ error: 'Failed to save batch' })

    // With a sessionId, Atlas's turns move onto the book they produced (unified-chat §6.2). Never fails the save.
    sealing.sealAfterGenerate(req, { kind: 'portfolio', entityIds: [result.portfolioId], name: plan?.portfolioName ? `the ${plan.portfolioName} book` : null })

    res.status(201).send({ ideas: result.ideas, portfolioId: result.portfolioId })
})

export const placeTradeIdeaOrders = _handle('placeTradeIdeaOrders', async (req, res) => {
    const id = _requireId(req, res)
    if (!id) return

    const { orders, acceptPrice } = req.body ?? {}
    const result = await ideaService.placeOrdersForIdea(id, orders, req.user._id, { acceptPrice: acceptPrice === true })
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
            // Not a failure: the market moved off the plan since the read. 409 + the numbers, so the
            // dialog can show them and the user's second press (acceptPrice) places at market.
            price_moved: [409, 'The price has moved off the plan'],
        }
        return sendReason(res, result.reason, {
            overrides: PLACE, fallback: 500, fallbackMessage: 'Failed to place orders',
            extra: ['all_failed', 'no_price'].includes(result.reason)
                ? { results: result.results, ...(result.symbol && { symbol: result.symbol }) }
                : result.reason === 'price_moved' ? { drift: result.drift } : null,
        })
    }

    res.send({ idea: result.idea, results: result.results })
})

// "Buy now" from the arm-time pre-flight prompt: force-trigger a 'looking' idea's
// entry (→ 'hit' + built plan) so the normal order-confirm dialog appears.
export const triggerTradeIdeaEntry = _handle('triggerTradeIdeaEntry', async (req, res) => {
    const id = _requireId(req, res)
    if (!id) return

    const result = await ideaService.triggerEntryNow(id, req.user._id)
    if (!result.ok) {
        return sendReason(res, result.reason, {
            overrides: { not_looking: [409, 'Idea is not armed (looking)'] },
            fallback: 500, fallbackMessage: 'Failed to trigger entry',
        })
    }

    res.send({ idea: result.idea })
})

// The body goes to the service whole: WHICH fields are editable is the model's rule
// (tradeIdeas.service EDITABLE_FIELDS / pickEditable), and it holds for every writer — the Atlas
// update_item path patches the same document without passing through here.
export const updateTradeIdea = _handle('updateTradeIdea', async (req, res) => {
    const id = _requireId(req, res)
    if (!id) return

    const result = await ideaService.updateIdea(id, req.body ?? {}, req.user._id)
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
})
