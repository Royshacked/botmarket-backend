/**
 * Adopt a book the app did not build — the user's real portfolio at a bank we can't wire to.
 *
 * See docs/design/adopted-book.md. The one-line shape: **generate derives holdings from intent,
 * adoption derives intent from holdings.** Same objects, opposite direction — so this owns no
 * writer, no arithmetic and no card of its own. It orchestrates the shared ones and owns only the
 * JUDGMENT: what refuses, what terminal state the legs are born in, and the order the lifecycle is
 * stamped in.
 *
 * Two gestures:
 *   • `createDraft` — DIAGNOSIS. Prices what the user typed, reconciles it against what the bank
 *     says the account is worth, and returns the problems so the confirm grid can show them. Never
 *     refuses: showing someone their own mistake is the point.
 *   • `commitDraft` — the GATE. Refuses on any unresolved problem, then writes: account → positions
 *     → entities (born live) → ledger → lifecycle + fingerprint.
 *
 * Plus a repair path (`correctHolding` / `removeHolding`), because the numbers come from a human
 * retyping a bank screen and a live leg is delete-locked everywhere else. A correction is NOT a
 * trim: nothing happened in the market, so no P&L is ever banked.
 */

import { reconcileAccount }      from '../../services/bookValuation.util.js'
import { fxToUsd }               from '../../services/fxRate.service.js'
import { parseHoldings }         from '../../services/holdingsParse.util.js'
import { isNonUsListing }        from '../../services/market.service.js'
import { adoptDraftStore }       from './adoptBook.store.js'
import { paperBrokerService }    from '../broker/paperBroker.service.js'
import { openManualPosition }    from '../broker/manualExecution.service.js'
import { quoteMapForSymbols }    from '../broker/paperExecution.service.js'
import { ideaService }           from '../trade-ideas/tradeIdeas.service.js'
import { entityRepo }            from '../../services/entity/entityRepo.service.js'
import { ENTITIES }              from '../../services/entity/entityCollection.js'
import { LIVE_POSITION }         from '../../services/entity/vocabulary.js'
import { portfolioChatService, CADENCE_MS } from './portfolioChat.service.js'
import { tradeCaptureService }   from '../../services/tradeCapture.service.js'
import { getDb, stripId }        from '../../providers/mongodb.provider.js'
import { toNum }                 from '../../services/format.util.js'
import { logger }                from '../../services/logger.service.js'

const LOG = '[adoptBook]'

// A bank book is bought to be held. Themis falls back to WEEKLY for a book with no cadence, which is
// the wrong clock for buy-and-hold, so adoption states one explicitly rather than inheriting it.
const DEFAULT_CADENCE = 'monthly'

// Injectable IO, so the branching (refusals, retries, partial writes) is testable without a DB,
// a price feed or an LLM — the house pattern (coverageRefresh, themis, talos).
const _deps = {
    quotes:         (symbols)                  => quoteMapForSymbols(symbols),
    fxToUsd:        (currency)                 => fxToUsd(currency),
    createAccount:  (userId, opts)             => paperBrokerService.createAccount(userId, opts),
    openPosition:   (args)                     => openManualPosition(args),
    getPosition:    (userId, positionId)       => paperBrokerService.getPosition(userId, positionId),
    updatePosition: (userId, positionId, set)  => paperBrokerService.updatePosition(userId, positionId, set),
    saveBatch:      (plan, userId, opts)       => ideaService.saveBatchIdeas(plan, userId, opts),
    legsFor:        (portfolioId, userId)      => entityRepo.listByPortfolio(portfolioId, userId),
    getEntity:      (id)                       => entityRepo.getById(id),
    patchEntity:    (id, fields)               => entityRepo.patch(id, fields),
    deleteEntity:   (id, userId)               => _deleteAdoptedEntity(id, userId),
    setMandate:     (pid, userId, mandate)     => portfolioChatService.setMandate(pid, userId, mandate),
    setLifecycle:   (pid, userId, patch)       => portfolioChatService.setPortfolioLifecycle(pid, userId, patch),
    fingerprint:    (pid, userId, reason)      => portfolioChatService.captureFingerprint(pid, userId, reason),
    captureOpen:    (idea, exec)               => tradeCaptureService.captureOpen(idea, exec),
    dropCapture:    (args)                     => tradeCaptureService.dropAdoptedOpen(args),
    store:          adoptDraftStore,
}
export function _setDeps(d) {
    const prev = { ..._deps }
    Object.assign(_deps, d)
    return () => Object.assign(_deps, prev)
}

// ─── Intake ─────────────────────────────────────────────────────────────────────

/** A purchase date can only be in the past. Pure. */
export function _pastOnly(ms, now = Date.now()) {
    if (ms == null) return null
    return ms > now ? now : ms
}

/** One typed line, coerced. `openedAt` is optional — many users won't know when they bought. */
export function normalizeHolding(raw = {}) {
    return {
        symbol:      String(raw.symbol ?? raw.asset ?? raw.ticker ?? '').trim().toUpperCase(),
        asset_class: raw.asset_class ?? null,
        // Long-only for v1, but the field is real: a book that holds a short says so.
        direction:   raw.direction === 'short' ? 'short' : 'long',
        quantity:    toNum(raw.quantity),
        avgCost:     toNum(raw.avgCost ?? raw.avg_cost ?? raw.entryPrice),
        // Clamped to now: a mistyped year would open a position in the FUTURE, which gives a negative
        // holding period and a fill dated after the trade that recorded it.
        openedAt:    _pastOnly(toNum(raw.openedAt)),
        // The user's own reason for holding it — Atlas's A4 question. Rides the existing `notes`
        // channel rather than a parallel field, since that is what a portfolio leg already carries.
        why:         typeof raw.why === 'string' && raw.why.trim() ? raw.why.trim() : null,
    }
}

/**
 * Split what the user stated into the book we can actually manage, and the lines we cannot.
 *
 * A holding is only IN the book if we can value, weight, research and review it — and for a listing
 * outside the US market we can do none of those: no price in USD, no coverage, no market hours, no
 * broker symbol. Carrying such a row would put a number in a book that no gate can ever read.
 *
 * So it is EXCLUDED and NAMED, never silently dropped and never quietly carried: `excluded` travels on
 * the draft with a reason per line, the staged book states it, and Atlas says it out loud.
 *
 * Two reasons, deliberately distinct, because they need different sentences:
 *   • `non_us_listing` — we know what it is and cannot manage it (NESN.SW). Suggest the US line if one
 *     exists (an ADR); otherwise it stays at the bank, untracked.
 *   • `no_price`       — we could not price it at all: a bank fund, a bond, a mis-typed ticker. This
 *     one is often a TYPO, so it is a question, not a verdict.
 * Pure.
 */
export function partitionHoldings(priced) {
    const included = [], excluded = []
    for (const h of priced) {
        if (isNonUsListing(h.symbol))    { excluded.push({ ...h, reason: 'non_us_listing' }); continue }
        if (h.mark == null)              { excluded.push({ ...h, reason: 'no_price' });       continue }
        included.push(h)
    }
    return { included, excluded }
}

/**
 * Stage an adoption: price the lines, reconcile the account, persist the draft.
 *
 * Deliberately does NOT refuse. Every problem it finds — a bad quantity, a total that doesn't add
 * up, a line we can't price — is returned for the confirm grid to render against the offending row.
 * The refusal lives at commit, so the user gets to fix things first.
 */
export async function createDraft({ userId, bank = null, currency = 'USD', statedTotal = null, freeCash = null, holdings = [], paste = null, mandate = null, name = null }) {
    try {
        if (!userId) return { ok: false, reason: 'forbidden' }

        // TWO WAYS IN, one draft. `holdings` is the grid handing back edited cells; `paste` is the raw
        // text the user dropped into the chat. The paste is read by the deterministic parser — the model
        // never extracts a number (holdingsParse.util) — and explicit rows always WIN, because a grid
        // edit is the user correcting exactly what the parser got wrong.
        const parsed = paste ? parseHoldings(paste) : null
        const source = (Array.isArray(holdings) && holdings.length) ? holdings : (parsed?.rows ?? [])
        const rows   = source.map(normalizeHolding)

        // One quote read for the whole book. Unpriceable lines come back null and stay first-class:
        // they are tracked, just not marked (and they force the explicit-cash branch below).
        const symbols = [...new Set(rows.map(r => r.symbol).filter(Boolean))]
        const marks   = symbols.length ? await _deps.quotes(symbols).catch(() => new Map()) : new Map()
        const priced  = rows.map(r => ({ ...r, mark: toNum(marks.get(r.symbol)) }))

        // The account is kept in USD — the unit the price feed speaks, and therefore the unit the
        // holdings are already valued in. A stated total and stated cash given in another currency are
        // converted at SPOT, which is right for cash and is deliberately not applied to cost basis
        // (see fxRate.service). The rate is recorded so the grid can show its own arithmetic back:
        // "you told us ₪650,000, at 0.27 that's $175,500".
        const stated  = String(currency ?? 'USD').trim().toUpperCase() || 'USD'
        const rate    = stated === 'USD' ? 1 : await _deps.fxToUsd(stated).catch(() => null)
        // Only the manageable book is valued. An excluded line is not part of the portfolio, so it is
        // not part of its cost basis or its weights either.
        const { included, excluded } = partitionHoldings(priced)
        const reconciliation = reconcileAccount({
            holdings: included, statedTotal, freeCash, fxToUsd: rate, excluded: excluded.length,
        })
        // The parser's findings ride ALONGSIDE the reconciliation rather than being merged into it: one
        // is "we could not read your paste", the other is "your numbers do not add up", and the grid
        // shows them in different places. Warnings never block (a bank export whose columns we assumed).
        if (parsed?.problems?.length) reconciliation.problems.push(...parsed.problems)

        const draft = await _deps.store.createDraft(userId, {
            bank, name, mandate,
            // What the account is denominated in for us, and what the user actually typed.
            currency:       'USD',
            statedCurrency: stated,
            fxToUsd:        rate,
            fxAt:           rate != null && stated !== 'USD' ? Date.now() : null,
            statedTotal: toNum(statedTotal), freeCash: toNum(freeCash),
            holdings: included, excluded, reconciliation,
            warnings: parsed?.warnings ?? [],
            // Minted here, not at commit, so a retry writes into the SAME book instead of a second one.
            portfolioId: `portfolio_${Date.now()}`,
        })
        return { ok: true, draft: stripId(draft) }
    } catch (err) {
        logger.error(LOG, 'createDraft failed', err)
        return { ok: false, error: err }
    }
}

/**
 * Fold another turn of conversation into an existing draft, and hand the draft back for the model to
 * read (portfolio.controller, adopt mode).
 *
 * Two reasons this is not just `createDraft` again. One: a new draft mints a new `portfolioId`, so a
 * user who pastes the rest of their book in a second message would end up adopting two half-books.
 * Two: the parse must happen on EVERY turn, because that is how a paste arrives — mid-conversation,
 * unannounced — and the model must never be the thing that read the numbers.
 *
 * Rows are MERGED by symbol, last write winning, so "actually TSLA is 60 not 50" corrects one line
 * instead of replacing the table. A turn that parses to nothing (ordinary conversation) leaves the
 * draft untouched and simply returns it.
 */
export async function refreshDraft({ draftId, userId, paste = null, statedTotal = null, freeCash = null, mandate = null }) {
    try {
        const draft = await _deps.store.getDraft(draftId, userId)
        if (!draft)                                                  return { ok: false, reason: 'not_found' }
        if (draft.status === adoptDraftStore.DRAFT_STATUS.COMMITTED) return { ok: false, reason: 'already_committed' }

        const parsed = paste ? parseHoldings(paste) : null
        const fresh  = (parsed?.rows ?? []).map(normalizeHolding).filter(h => h.symbol)

        // Nothing new in this turn — conversation, not a paste. Hand back what we hold.
        if (!fresh.length && statedTotal == null && freeCash == null && !mandate) return { ok: true, draft }

        // Excluded lines stay in the merge pool: a user correcting a typo'd ticker must be able to
        // bring that row back into the book, and one that is genuinely foreign must not silently
        // reappear as manageable either — the partition below decides again, every turn.
        const bySymbol = new Map([...(draft.holdings ?? []), ...(draft.excluded ?? [])].map(h => [h.symbol, h]))
        for (const h of fresh) {
            const prev = bySymbol.get(h.symbol)
            // A correction states a number; it does not un-state the ones it left out. `why` in
            // particular is gathered a phase later and must survive a re-paste of the same row.
            bySymbol.set(h.symbol, prev ? { ...prev, ...h, why: h.why ?? prev.why } : h)
        }
        const merged = [...bySymbol.values()]

        // Re-price and re-reconcile the WHOLE book: a new row changes the market value, which changes
        // the derived cash, which changes the starting balance.
        const symbols = [...new Set(merged.map(h => h.symbol))]
        const marks   = symbols.length ? await _deps.quotes(symbols).catch(() => new Map()) : new Map()
        const priced  = merged.map(h => ({ ...h, mark: toNum(marks.get(h.symbol)) }))

        const total = statedTotal != null ? toNum(statedTotal) : draft.statedTotal
        const cash  = freeCash    != null ? toNum(freeCash)    : draft.freeCash
        const { included, excluded } = partitionHoldings(priced)
        const reconciliation = reconcileAccount({
            holdings: included, statedTotal: total, freeCash: cash, fxToUsd: draft.fxToUsd ?? 1, excluded: excluded.length,
        })
        if (parsed?.problems?.length) reconciliation.problems.push(...parsed.problems)

        const patch = {
            holdings:    included,
            excluded,
            statedTotal: total,
            freeCash:    cash,
            reconciliation,
            warnings:    parsed?.warnings ?? draft.warnings ?? [],
            ...(mandate ? { mandate: { ...(draft.mandate ?? {}), ...mandate } } : {}),
        }
        await _deps.store.patchDraft(draftId, userId, patch)
        return { ok: true, draft: { ...draft, ...patch } }
    } catch (err) {
        logger.error(LOG, `refreshDraft failed (${draftId})`, err)
        return { ok: false, error: err }
    }
}

// ─── Commit ─────────────────────────────────────────────────────────────────────

/**
 * Commit a confirmed draft. Order matters and is not arbitrary:
 *   1. account   — its balance is cost basis + free cash (bookValuation), never market value
 *   2. positions — the entity needs a positionId, so the position exists first
 *   3. entities  — one shared batch write, born LIVE (no activation, no order plan)
 *   4. ledger    — marked `adopted`, so the track record can't claim entries we didn't make
 *   5. lifecycle + fingerprint — LAST, because the fingerprint reads the book it is baselining
 *
 * Re-runnable. Which legs still need writing is read from the ENTITY COLLECTION, not from the
 * draft's bookkeeping, so an interrupted commit can be repeated without duplicating a holding.
 */
export async function commitDraft({ draftId, userId }) {
    try {
        const draft = await _deps.store.getDraft(draftId, userId)
        if (!draft)                                          return { ok: false, reason: 'not_found' }
        if (draft.status === adoptDraftStore.DRAFT_STATUS.COMMITTED) return { ok: false, reason: 'already_committed' }
        if (!draft.holdings?.length)                         return { ok: false, reason: 'no_holdings' }

        const rec = draft.reconciliation ?? {}
        // The reconciliation the user CONFIRMED is the one committed — marks are not re-fetched here.
        // Re-pricing at commit would move the starting balance between the table someone approved and
        // the account that gets opened, which is the one number they can never audit afterwards.
        if (rec.problems?.length || rec.startingBalance == null) {
            return { ok: false, reason: 'unreconciled', problems: rec.problems ?? ['no_account_value'] }
        }

        // Everything above is a read, so it refuses without ever taking the claim — a draft that can't
        // commit must not be locked for the lease. From here the work begins, and only one caller may
        // do it: a double-clicked commit would otherwise open two accounts and two positions per
        // symbol, since the existence check below cannot see a twin that is still mid-flight.
        if (!await _deps.store.claimDraft(draftId, userId)) return { ok: false, reason: 'in_progress' }

        const now         = Date.now()
        const portfolioId = draft.portfolioId

        let accountId = draft.accountId
        if (!accountId) {
            const acct = await _deps.createAccount(userId, {
                mode:            'manual',
                name:            draft.bank || 'Bank account',
                startingBalance: rec.startingBalance,
                currency:        draft.currency || 'USD',
            })
            accountId = acct?.accountId
            if (!accountId) {
                await _deps.store.releaseDraft(draftId, userId)
                return { ok: false, reason: 'account_failed' }
            }
            await _deps.store.recordAccount(draftId, userId, accountId)
        }

        const existing = new Set((await _deps.legsFor(portfolioId, userId) ?? [])
            .map(l => String(l.asset ?? '').toUpperCase()))
        const pending = draft.holdings.filter(h => h.symbol && !existing.has(h.symbol))

        const legs = []
        let failed = []
        for (const h of pending) {
            let positionId = draft.positions?.[h.symbol] ?? null
            if (!positionId) {
                try {
                    positionId = await _deps.openPosition({
                        userId, accountId,
                        symbol:    h.symbol,
                        direction: h.direction,
                        qty:       h.quantity,
                        price:     h.avgCost,
                        openedAt:  h.openedAt ?? null,   // the REAL open date; often years old
                    })
                    await _deps.store.recordPosition(draftId, userId, h.symbol, positionId)
                } catch (err) {
                    logger.warn(LOG, `position failed for ${h.symbol}: ${err.message}`)
                    failed.push({ asset: h.symbol, reason: 'position_failed' })
                    continue
                }
            }
            legs.push({
                asset:       h.symbol,
                asset_class: h.asset_class,
                direction:   h.direction,
                quantity:    h.quantity,
                notes:       h.why,
                adopted:     true,
                adoptedAt:   now,
                fill:        { broker: 'manual', accountId, positionId, quantity: h.quantity, at: h.openedAt ?? now },
            })
        }

        let written = []
        if (legs.length) {
            const res = await _deps.saveBatch(
                { name: draft.name || draft.bank || 'Portfolio', ideas: legs },
                userId,
                { accounts: [accountId], mainAccountId: accountId, portfolioId, born: 'live' },
            )
            written = res?.ideas ?? []
            failed  = failed.concat(res?.failed ?? [])
        }

        // The ledger, over the WHOLE book rather than just the legs written this pass. A first attempt
        // that wrote an entity and then died would otherwise lose that leg's ledger row for good: the
        // retry skips the leg (it exists) and so would skip its capture. `captureOpen` upserts on
        // (accountId, positionId), so re-capturing a leg that already has a row is a no-op.
        // Best-effort by contract (captureOpen never throws) — an analytics row is not worth failing a
        // real holding over.
        const costBySymbol = new Map(draft.holdings.map(h => [h.symbol, h.avgCost]))
        const book = written.length === draft.holdings.length
            ? written
            : (await _deps.legsFor(portfolioId, userId) ?? [])
        for (const leg of book) {
            const link = (leg.brokerOrders ?? []).find(b => b.positionId != null)
            if (!link) continue
            await _deps.captureOpen(leg, {
                broker: 'manual', accountId, positionId: link.positionId,
                direction: leg.direction, quantity: leg.quantity,
                price: costBySymbol.get(String(leg.asset).toUpperCase()) ?? null,
                at: leg.ordersPlacedAt ?? now,
            })
        }

        // A half-written book is NOT a success. The draft stays open so the same call can be repeated
        // — the legs already written are skipped by the existence check above.
        if (failed.length) {
            logger.warn(LOG, `partial adoption of ${portfolioId}: ${written.length} written, ${failed.length} failed`)
            // Handed straight back rather than left to time out: every step above is idempotent, so the
            // user retrying immediately is exactly the right thing and must not be refused.
            await _deps.store.releaseDraft(draftId, userId)
            return { ok: false, reason: 'partial_write', failed, portfolioId, accountId, legs: written.length }
        }

        const cadence = draft.mandate?.reviewCadence ?? DEFAULT_CADENCE
        if (draft.mandate) await _deps.setMandate(portfolioId, userId, draft.mandate)
        await _deps.setLifecycle(portfolioId, userId, {
            reviewCadence: cadence,
            nextReviewAt:  now + (CADENCE_MS[cadence] ?? CADENCE_MS[DEFAULT_CADENCE]),
            benchmark:     draft.mandate?.benchmark ?? null,
            // Where the book is in acquiring a spine: adopted (prices only) → covered (research in)
            // → under_mandate (targets + conviction authored). Drives the nag, and lets Themis ring
            // "coverage is ready" instead of waiting out a cadence.
            spine_state:   'adopted',
            adoptedAt:     now,
        })
        // LAST: the fingerprint is the "then" baseline every later review diffs against, so it has to
        // read a book that already exists. Without it the drawdown/benchmark/regime gates are dead.
        await _deps.fingerprint(portfolioId, userId, 'adoption')

        await _deps.store.setStatus(draftId, userId, adoptDraftStore.DRAFT_STATUS.COMMITTED, { committedAt: now, accountId })
        logger.info(LOG, `adopted ${portfolioId} — ${book.length} holding(s) on ${accountId}`)
        // The BOOK, not just this pass: a resumed commit that found everything already written adopted
        // a full book, and reporting 0 would read as having adopted nothing.
        return { ok: true, portfolioId, accountId, legs: book.length }
    } catch (err) {
        logger.error(LOG, `commitDraft failed (${draftId})`, err)
        // Never leave a claim behind on a thrown error — the retry has to be able to pick it up.
        await _deps.store.releaseDraft(draftId, userId).catch(() => {})
        return { ok: false, error: err }
    }
}

/**
 * Discard a staged book. The confirm grid needs it for "start over", and it is what keeps an edited
 * intake from leaving an orphan behind — the grid re-stages rather than patching, since a changed
 * quantity re-prices the whole reconciliation.
 */
export async function discardDraft({ draftId, userId }) {
    try {
        const ok = await _deps.store.deleteDraft(draftId, userId)
        // Only an unspent draft can be discarded, so a miss is either the wrong id or an already
        // committed book — neither is a deletion.
        return ok ? { ok: true } : { ok: false, reason: 'not_found' }
    } catch (err) {
        logger.error(LOG, `discardDraft failed (${draftId})`, err)
        return { ok: false, error: err }
    }
}

/** The user's still-unspent drafts, so an interrupted intake can be resumed rather than retyped. */
export async function listDrafts({ userId }) {
    try {
        return { ok: true, drafts: await _deps.store.listDrafts(userId) }
    } catch (err) {
        logger.error(LOG, 'listDrafts failed', err)
        return { ok: false, error: err }
    }
}

// ─── Repair ─────────────────────────────────────────────────────────────────────

/**
 * Fix a mis-stated holding: the quantity, the average cost, or both.
 *
 * NOT a trim and NOT a scale-in. Those record something that HAPPENED in the market and bank P&L
 * against it; this records that we were told the wrong number. So no cash moves, no realized P&L is
 * booked, and the position's identity is unchanged — which is exactly why it can't route through
 * reduceManualPosition / addToManualPosition.
 *
 * Only ever touches an ADOPTED leg. A holding the app actually decided is corrected by the market,
 * not by retyping.
 */
export async function correctHolding({ id, userId, quantity = null, avgCost = null }) {
    try {
        const leg = await _deps.getEntity(id)
        if (!leg)                            return { ok: false, reason: 'not_found' }
        if (leg.userId !== userId)            return { ok: false, reason: 'forbidden' }
        if (leg.adopted !== true)             return { ok: false, reason: 'not_adopted' }
        if (!LIVE_POSITION.includes(leg.status)) return { ok: false, reason: 'not_in_position' }

        const qty  = toNum(quantity)
        const cost = toNum(avgCost)
        if (qty == null && cost == null)      return { ok: false, reason: 'nothing_to_correct' }
        if (qty  != null && !(qty  > 0))      return { ok: false, reason: 'bad_quantity' }
        if (cost != null && !(cost > 0))      return { ok: false, reason: 'bad_price' }

        const link = (leg.brokerOrders ?? []).find(b => b.positionId != null)
        if (!link)                            return { ok: false, reason: 'no_position' }

        const posSet = {}
        if (qty  != null) posSet.qty      = qty
        if (cost != null) posSet.avgPrice = cost
        await _deps.updatePosition(userId, link.positionId, posSet)

        const legSet = { correctedAt: Date.now() }
        if (qty != null) {
            legSet.quantity     = qty
            legSet.brokerOrders = (leg.brokerOrders ?? []).map(b =>
                b.positionId === link.positionId ? { ...b, quantity: qty } : b)
        }
        await _deps.patchEntity(id, legSet)

        logger.info(LOG, `corrected ${id} (${leg.asset})${qty != null ? ` qty→${qty}` : ''}${cost != null ? ` cost→${cost}` : ''}`)
        return { ok: true, quantity: qty ?? leg.quantity, avgCost: cost ?? null }
    } catch (err) {
        logger.error(LOG, `correctHolding failed (${id})`, err)
        return { ok: false, error: err }
    }
}

/**
 * Remove a holding that was never really there — a line already sold, or a typo'd ticker.
 *
 * The position is marked `removed`, NOT closed: a close books realized P&L and moves cash, and
 * nothing was sold. `removed` drops it out of every open-position read (equity, marks, the positions
 * view) while leaving the row legible.
 *
 * Deliberately bypasses the CRUD delete-lock, which exists to stop someone deleting a live position
 * out from under a real broker order. Guarded to `adopted: true`, so it can only ever reach a
 * position the app recorded on the user's word — never one it placed.
 */
export async function removeHolding({ id, userId }) {
    try {
        const leg = await _deps.getEntity(id)
        if (!leg)                  return { ok: false, reason: 'not_found' }
        if (leg.userId !== userId) return { ok: false, reason: 'forbidden' }
        if (leg.adopted !== true)  return { ok: false, reason: 'not_adopted' }

        const link = (leg.brokerOrders ?? []).find(b => b.positionId != null)
        if (link) {
            // `removed`, not `closed`: every position read in the app filters positively on
            // status 'open', so this drops out of equity, marks and the positions view without ever
            // pretending a sale happened. (A POSITION word, not an entity status — see the
            // statusLiterals guard.)
            await _deps.updatePosition(userId, link.positionId, {
                status: 'removed', removedAt: Date.now(), removedReason: 'never_held',
            })
            // And withdraw the ledger row, or an `open` trade for a position that no longer exists
            // sits in analytics as a live holding forever.
            await _deps.dropCapture({ accountId: link.accountId, positionId: link.positionId })
        }
        const deleted = await _deps.deleteEntity(id, userId)
        if (!deleted) return { ok: false, reason: 'not_found' }

        logger.info(LOG, `removed adopted holding ${id} (${leg.asset})`)
        return { ok: true, asset: leg.asset }
    } catch (err) {
        logger.error(LOG, `removeHolding failed (${id})`, err)
        return { ok: false, error: err }
    }
}

/** The guarded delete behind `_deps.deleteEntity` — adopted legs only (see removeHolding). */
async function _deleteAdoptedEntity(id, userId) {
    const db  = await getDb()
    const res = await db.collection(ENTITIES).deleteOne({ id, userId, adopted: true })
    return res.deletedCount > 0
}

export const adoptBookService = {
    createDraft, refreshDraft, commitDraft, discardDraft, listDrafts,
    correctHolding, removeHolding, normalizeHolding, partitionHoldings,
}
