import { getDb } from '../providers/mongodb.provider.js'
import { ENTITIES } from './entity/entityCollection.js'
import { brokerService } from '../api/broker/broker.service.js'
import { logger } from './logger.service.js'

/**
 * THE HANDS of in-position management — one mechanism, every desk.
 *
 * A monitor proposes a change to a live position (tighten the stop, bank a third, get flat) and the
 * user accepts it. What happens next is pure mechanism: find the broker position on every account
 * the entity is placed on, amend or close, keep our tracked exit order in step, then write the
 * result down. NOTHING in here knows which desk asked. Hermes proposes for a Kairos `call`, Talos
 * for a Mentor `setup`, and both arrive at the same three broker calls.
 *
 * This lived inside kairos.handoff.service until a setup needed it too. It moved rather than being
 * copied — a second copy is how a partial ends up capped on one desk and uncapped on the other.
 *
 * WHAT STAYS WITH THE DESK (see the data-vs-judgment rule in CLAUDE.md):
 *   • the verdict vocabulary its monitor emits, and its own proposal shape. Hermes says
 *     `{ new_stop }`, Talos says `{ stop, why }` — each desk translates its own into the execution
 *     contract below before calling in. Translating them HERE would make this the place that knows
 *     every desk's dialect, which is precisely what it must not know.
 *   • ownership, status guards, manual-mode notification, and what the card says.
 *
 * THE EXECUTION CONTRACT (what a caller must normalize its proposal into):
 *   move_stop     { new_stop:number, ref?:string }
 *   take_partial  { size_pct:number }                     — a share of the ORIGINAL position
 *   let_run       { new_tp:number } | { cancel_tp:true }
 *   exit_now      {}                                       — full close
 *
 * ENTITY vs HOLDER. `entity` is the doc that owns `position_state` and declares the accounts; it is
 * also what gets the write. `holder` is the doc carrying `brokerOrders` / `exitOrders` — the broker
 * linkage. For a setup they are the SAME doc (execution writes onto the setup). For a call they are
 * not: the call materializes an idea at confirm, and the position hangs off that idea.
 */

const LOG = '[positionManage]'

/** The verbs this executes. `hold` is not one — a monitor that holds proposes nothing. */
export const MANAGE_VERBS = new Set(['move_stop', 'take_partial', 'exit_now', 'let_run'])

export const _deps = {
    getDb,
    findOpenPosition: (broker, userId, acct, positionId)      => brokerService.findOpenPosition(broker, userId, acct, positionId),
    closePosition:    (broker, userId, acct, positionId, opts)=> brokerService.closePosition(broker, userId, acct, positionId, opts),
    amendOrder:       (broker, userId, acct, orderId, fields) => brokerService.amendOrder(broker, userId, acct, orderId, fields),
    cancelOrder:      (broker, userId, acct, orderId)         => brokerService.cancelOrder(broker, userId, acct, orderId),
    // Keep the tracked native exit in step with a broker amend/cancel so the reconciler's resize
    // (on a later partial) doesn't cancel-and-replace it at the STALE price/id.
    syncExit:         async (holderId, accountId, leg, patch) => {
        const set = {}
        if (patch?.price   != null) set['exitOrders.$[e].price']   = patch.price
        if (patch?.orderId != null) set['exitOrders.$[e].orderId'] = String(patch.orderId)
        if (patch?.status  != null) set['exitOrders.$[e].status']  = patch.status
        if (!Object.keys(set).length) return
        const db = await getDb()
        await db.collection(ENTITIES).updateOne({ id: holderId }, { $set: set },
            { arrayFilters: [{ 'e.accountId': String(accountId), 'e.leg': leg, 'e.status': 'working' }] })
    },
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * EVERY account's open-position linkage — an entity is placed one-position-per-account, so a
 * management action fans out across ALL of them, not just the main. Scoped to the entity's declared
 * accounts when present; falls back to all open-position slots (so a live position is never left
 * unmanaged).
 */
export function resolveAllLinks(holder, entity) {
    const links  = (Array.isArray(holder?.brokerOrders) ? holder.brokerOrders : []).filter(b => b?.positionId != null)
    const accts  = Array.isArray(entity?.accounts) ? entity.accounts.map(String) : []
    const scoped = accts.length ? links.filter(b => accts.includes(String(b.accountId))) : links
    const chosen = scoped.length ? scoped : links   // never manage NONE while positions are open
    return chosen.map(slot => ({ broker: slot.broker, accountId: slot.accountId, positionId: slot.positionId, quantity: Number(slot.quantity) || 0 }))
}

/** The still-working native exit order for a leg on an account (the one to amend/cancel). */
export function workingExit(holder, accountId, leg) {
    return (holder?.exitOrders ?? []).find(o =>
        o?.leg === leg && o?.status === 'working' && o?.orderId != null && String(o.accountId) === String(accountId)) ?? null
}

/** Entity-unit quantity for a percentage partial, capped at what's live. */
export function partialQty(remaining, sizePct) {
    const rem = Number(remaining)
    const pct = Number(sizePct)
    if (!(rem > 0) || !(pct > 0)) return 0
    return Math.min(rem, Math.round(rem * Math.min(100, pct) / 100 * 10000) / 10000)
}

export function phaseAfterStop(newStop, entry, isLong) {
    if (!Number.isFinite(newStop) || !Number.isFinite(entry)) return 'trailing'
    const atBreakeven = isLong ? newStop >= entry : newStop <= entry
    return atBreakeven ? 'breakeven' : 'trailing'
}

/**
 * The persisted change after an executed action: $set (stop/phase, clear pending) + $push (taken
 * ledger for a partial, always the journal). `extra.qty` is the executed partial size.
 */
export function manageAppliedUpdate(verb, proposal, ps, extra, nowMs) {
    const at     = new Date(nowMs).toISOString()
    const isLong = (ps?.entry?.direction ?? 'long') !== 'short'
    const entry  = ps?.entry?.fill_price ?? ps?.entry?.intended ?? null
    const set  = { 'position_state.pending_action': null }
    const push = {}

    let note
    if (verb === 'move_stop') {
        set['position_state.stop.current'] = proposal?.new_stop ?? ps?.stop?.current ?? null
        set['position_state.stop.ref']     = proposal?.ref ?? null
        set['position_state.phase']        = phaseAfterStop(proposal?.new_stop, entry, isLong)
        note = `Moved my stop to ${proposal?.new_stop} — ${set['position_state.phase'] === 'breakeven' ? 'locking in breakeven' : 'tightening protection'}.`
    } else if (verb === 'let_run') {
        set['position_state.phase'] = 'runner'
        note = proposal?.cancel_tp ? 'Cancelled the take-profit — letting this run.' : `Raised the take-profit to ${proposal?.new_tp} — letting it run.`
    } else if (verb === 'take_partial') {
        push['position_state.taken'] = { at, size: extra?.qty ?? null, price: null, r_multiple: null, kind: 'partial' }
        note = `Banked ${proposal?.size_pct}% here — taking money off the table.`
    } else if (verb === 'exit_now') {
        note = 'Flattening the rest now — the trade is done for me.'
    }

    push['monitor_state.timeline'] = { $each: [{ at, reason: 'in_position', phase: 'in_position', price: null, verdict: verb, note, next_check_at: null }], $slice: -80 }
    return { $set: set, $push: push }
}

// ── The broker calls ──────────────────────────────────────────────────────────

/**
 * Execute the resolved proposal against ONE account's position. Returns { qty } (executed partial
 * size) for the applied-update. Throws on a broker failure (caller maps to execution_failed).
 */
export async function executeManage(verb, proposal, holder, link, open, userId, deps = _deps) {
    const { broker, accountId, positionId } = link
    if (verb === 'move_stop' || verb === 'let_run') {
        const leg = verb === 'move_stop' ? 'stop' : 'tp'
        const ord = workingExit(holder, accountId, leg)
        if (!ord) throw new Error(`no working ${leg} order to amend`)
        if (verb === 'let_run' && proposal?.cancel_tp) {
            await deps.cancelOrder(broker, userId, accountId, ord.orderId)
            await deps.syncExit(holder.id, accountId, leg, { status: 'cancelled' })
            return {}
        }
        const level  = verb === 'move_stop' ? Number(proposal.new_stop) : Number(proposal.new_tp)
        const fields = verb === 'move_stop' ? { stopPrice: level } : { limitPrice: level }
        const res    = await deps.amendOrder(broker, userId, accountId, ord.orderId, fields)
        await deps.syncExit(holder.id, accountId, leg, { price: level, orderId: res?.orderId ?? null })
        return {}
    }
    if (verb === 'take_partial') {
        const remaining = Number(open?.volume) || link.quantity
        const qty = partialQty(remaining, proposal?.size_pct)
        if (!(qty > 0)) throw new Error('partial size resolved to 0')
        await deps.closePosition(broker, userId, accountId, positionId, { quantity: qty })
        return { qty }
    }
    // exit_now → full close
    await deps.closePosition(broker, userId, accountId, positionId)
    return {}
}

/**
 * Fan the accepted action out across EVERY account the entity is placed on, then write the result.
 *
 * Each account is checked broker-authoritatively (skip if already flat) and applied independently —
 * a partial failure on one account doesn't strand the others. The aggregate position_state (new stop
 * level / total partial qty summed across accounts) is written once, after all accounts have run.
 *
 * Returns the same { ok, reason?, accounts? } shape the desk handoffs return to their controllers.
 */
export async function applyManage({ entity, holder, verb, proposal, userId, nowMs = Date.now(), deps = _deps }) {
    const db    = await deps.getDb()
    const ps    = entity.position_state ?? {}
    const links = resolveAllLinks(holder, entity)
    if (!links.length) return { ok: false, reason: 'no_position_link' }

    const perAccount = []
    let anyReachable = false, anyOpen = false, anyApplied = false, totalQty = 0
    for (const link of links) {
        let open
        try { open = await deps.findOpenPosition(link.broker, userId, link.accountId, link.positionId); anyReachable = true }
        catch { perAccount.push({ accountId: link.accountId, reason: 'broker_unreachable' }); continue }
        if (open === null) { perAccount.push({ accountId: link.accountId, alreadyFlat: true }); continue }
        anyOpen = true
        try {
            const applied = await executeManage(verb, proposal, holder, link, open, userId, deps)
            anyApplied = true
            totalQty += Number(applied?.qty) || 0
            perAccount.push({ accountId: link.accountId, ok: true })
        } catch (e) {
            logger.error(LOG, `manage ${verb} failed for ${entity.id} acct ${link.accountId}:`, e.message)
            perAccount.push({ accountId: link.accountId, reason: 'execution_failed' })
        }
    }

    if (!anyReachable) return { ok: false, reason: 'broker_unreachable', accounts: perAccount }
    if (!anyOpen) {   // every account already flat → clear the card, let the reconciler close it out
        await db.collection(ENTITIES).updateOne({ id: entity.id }, { $set: { 'position_state.pending_action': null } })
        return { ok: true, alreadyFlat: true }
    }
    if (!anyApplied) return { ok: false, reason: 'execution_failed', accounts: perAccount }   // every open account errored

    await db.collection(ENTITIES).updateOne({ id: entity.id }, manageAppliedUpdate(verb, proposal, ps, { qty: totalQty }, nowMs))
    logger.info(LOG, `${entity.id} managed → ${verb} across ${links.length} account(s)`)
    return { ok: true, verb, accounts: perAccount }
}

/**
 * Resolve WHICH proposal an accept executes: the pending card's (the verb must match what was
 * proposed), or an empty one for a bare user-initiated exit_now. Shared because "you can always
 * choose to get flat, but you can only accept the change that was actually offered" is one rule,
 * not a per-desk preference. Returns { proposal } or { err }.
 */
export function resolveProposal(pending, verb, normalize = (p) => p ?? {}) {
    if (pending && pending.verdict === verb) return { proposal: normalize(pending.proposal) }
    if (verb === 'exit_now')                 return { proposal: {} }
    return { err: 'no_pending_action' }
}

export const positionManageService = { applyManage, executeManage, resolveProposal, resolveAllLinks, workingExit, partialQty, manageAppliedUpdate, MANAGE_VERBS }
