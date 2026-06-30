import { getDb }                             from '../providers/mongodb.provider.js'
import { brokerService }                     from '../api/broker/broker.service.js'
import { getEarningsCalendarRaw, getSectorRaw } from '../providers/fmp.provider.js'
import { logger }                            from './logger.service.js'

const LOG = '[portfolioState]'

const LIVE_STATUSES    = new Set(['long', 'short'])
const PENDING_STATUSES = new Set(['looking', 'waiting', 'resting', 'hit'])

// ── Short-TTL snapshot cache ──────────────────────────────────────────────
// A review conversation sends several follow-up turns. Recomputing the state
// each turn repeats broker getPositions + FMP calls AND re-sends a freshly
// timestamped block that can never be prompt-cached. Snapshotting for a few
// minutes both kills the repeated round-trips and makes the dynamic context
// byte-identical across turns so it can sit behind a cache_control breakpoint.
const STATE_TTL_MS = 5 * 60 * 1000
const _stateCache  = new Map()   // `${portfolioId}|${userId}` → { state, expiresAt }

/**
 * Cached wrapper around computePortfolioState. Returns the same snapshot for up
 * to ttlMs so review follow-ups reuse it (prices frozen for the window).
 */
export async function getPortfolioStateCached(portfolioId, userId, { ttlMs = STATE_TTL_MS } = {}) {
    const key = `${portfolioId}|${userId}`
    const hit = _stateCache.get(key)
    if (hit && hit.expiresAt > Date.now()) {
        logger.info(LOG, 'snapshot cache hit', { portfolioId })
        return hit.state
    }
    const state = await computePortfolioState(portfolioId, userId)
    _stateCache.set(key, { state, expiresAt: Date.now() + ttlMs })
    return state
}

/** Drop a cached snapshot — call when the portfolio changes out-of-band. */
export function invalidatePortfolioState(portfolioId, userId) {
    _stateCache.delete(`${portfolioId}|${userId}`)
}

/**
 * Compute the live state of a portfolio: actual weights, drift vs target,
 * unrealized P&L, thesis age, and upcoming earnings per holding.
 *
 * Live ideas (long/short) are matched to open broker positions.
 * Pending ideas (looking/waiting/resting/hit) are included with what is known.
 *
 * Returns null when no ideas exist for the given portfolioId.
 *
 * @param {string} portfolioId
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function computePortfolioState(portfolioId, userId) {
    const db    = await getDb()
    const ideas = await db.collection('ideas')
        .find({ portfolioId, userId })
        .project({ id: 1, asset: 1, direction: 1, allocationRatio: 1, conviction: 1, notes: 1, status: 1, type: 1, activatedAt: 1, brokerOrders: 1, portfolioName: 1 })
        .toArray()

    if (!ideas.length) return null

    const liveIdeas    = ideas.filter(i => LIVE_STATUSES.has(i.status))
    const pendingIdeas = ideas.filter(i => PENDING_STATUSES.has(i.status))
    const portfolioName = ideas[0]?.portfolioName ?? null

    // ── Fetch broker positions (one call per broker, spans all accounts) ───────
    const brokersNeeded = new Set()
    for (const idea of liveIdeas) {
        for (const link of (idea.brokerOrders ?? [])) {
            if (link.positionId && link.broker) brokersNeeded.add(link.broker)
        }
    }

    const positionsByBroker = {}
    await Promise.all([...brokersNeeded].map(async broker => {
        try {
            positionsByBroker[broker] = await brokerService.getPositions(broker, userId)
        } catch (err) {
            logger.warn(LOG, `getPositions failed broker=${broker}`, err.message)
            positionsByBroker[broker] = []
        }
    }))

    // ── Match positions → ideas, accumulate notional and P&L ──────────────────
    let totalNotional = 0
    let totalPnl      = 0

    const liveStates = liveIdeas.map(idea => {
        let notional        = 0
        let pnlSum          = 0
        let entryPriceSum   = 0
        let currentPriceSum = 0
        let matched         = 0

        for (const link of (idea.brokerOrders ?? [])) {
            if (!link.positionId || !link.broker) continue
            const pos = (positionsByBroker[link.broker] ?? []).find(
                p => String(p.id) === String(link.positionId) &&
                     String(p.accountId) === String(link.accountId)
            )
            if (!pos) continue

            const vol = pos.volume ?? 0
            const cur = pos.currentPrice ?? pos.entryPrice ?? 0
            notional        += vol * cur
            pnlSum          += pos.pnl ?? 0
            entryPriceSum   += pos.entryPrice ?? 0
            currentPriceSum += cur
            matched++
        }

        const avgEntry   = matched > 0 ? entryPriceSum   / matched : null
        const avgCurrent = matched > 0 ? currentPriceSum / matched : null
        const pnlPct = (avgEntry && avgCurrent)
            ? ((avgCurrent - avgEntry) / avgEntry * 100) * (idea.direction === 'short' ? -1 : 1)
            : null

        totalNotional += notional
        totalPnl      += pnlSum

        return {
            _notional:       notional,
            ideaId:          idea.id,
            asset:           idea.asset,
            direction:       idea.direction,
            status:          idea.status,
            type:            idea.type ?? null,
            allocationRatio: idea.allocationRatio ?? null,
            actualWeight:    null,
            drift:           null,
            pnl:             matched > 0 ? pnlSum : null,
            pnlPct,
            thesisAgeDays:   idea.activatedAt ? Math.floor((Date.now() - idea.activatedAt) / 86400000) : null,
            conviction:      idea.conviction ?? null,
            convictionPrev:  _lastConviction(idea),
            notes:           idea.notes ?? null,
            upcomingEarnings: null,
        }
    })

    // Back-fill actual weights and drift once totalNotional is settled.
    // Normalize drift against live-only allocation so pending positions don't
    // make live ones appear overweight (pending have no notional in totalNotional).
    const liveAllocTotal = liveIdeas.reduce((sum, i) => sum + (i.allocationRatio ?? 0), 0)
    for (const s of liveStates) {
        if (totalNotional > 0) {
            s.actualWeight = s._notional / totalNotional
            s.drift = (s.allocationRatio != null && liveAllocTotal > 0)
                ? s.actualWeight - (s.allocationRatio / liveAllocTotal)
                : null
        }
        delete s._notional
    }

    const pendingStates = pendingIdeas.map(idea => ({
        ideaId:          idea.id,
        asset:           idea.asset,
        direction:       idea.direction,
        status:          idea.status,
        type:            idea.type ?? null,
        allocationRatio: idea.allocationRatio ?? null,
        actualWeight:    null,
        drift:           null,
        pnl:             null,
        pnlPct:          null,
        thesisAgeDays:   idea.activatedAt ? Math.floor((Date.now() - idea.activatedAt) / 86400000) : null,
        conviction:      idea.conviction ?? null,
        convictionPrev:  _lastConviction(idea),
        notes:           idea.notes ?? null,
        upcomingEarnings: null,
    }))

    const allStates = [...liveStates, ...pendingStates]

    // ── Sector lookup for all tickers (cached 24h via FMP) ───────────────────
    const tickers = [...new Set(allStates.map(s => s.asset).filter(Boolean))]
    const sectorResults = await Promise.all(
        tickers.map(async asset => {
            const raw = await getSectorRaw(asset).catch(() => null)
            return { asset: asset.toUpperCase(), sector: raw?.sector ?? null }
        })
    )
    const sectorByAsset = Object.fromEntries(sectorResults.map(r => [r.asset, r.sector]))
    for (const s of allStates) {
        s.sector = sectorByAsset[String(s.asset ?? '').toUpperCase()] ?? null
    }

    // ── Sector weight aggregates ──────────────────────────────────────────────
    // Use live positions only (actualWeight != null) so pending ideas don't
    // inflate targets and make deployed sectors look underweight.
    const sectorTargets = {}
    const sectorActuals = {}
    for (const s of allStates) {
        if (!s.sector || s.actualWeight == null) continue
        if (s.allocationRatio != null && liveAllocTotal > 0)
            sectorTargets[s.sector] = (sectorTargets[s.sector] ?? 0) + (s.allocationRatio / liveAllocTotal)
        sectorActuals[s.sector] = (sectorActuals[s.sector] ?? 0) + s.actualWeight
    }
    const sectors = [...new Set([...Object.keys(sectorTargets), ...Object.keys(sectorActuals)])].map(sector => ({
        sector,
        targetWeight: sectorTargets[sector] ?? null,
        actualWeight: sectorActuals[sector] ?? null,
        drift:        (sectorTargets[sector] != null && sectorActuals[sector] != null)
                          ? sectorActuals[sector] - sectorTargets[sector]
                          : null,
    })).sort((a, b) => (b.targetWeight ?? 0) - (a.targetWeight ?? 0))

    // ── Upcoming earnings for all tickers (next 30 days) ──────────────────────
    const now  = new Date()
    const from = now.toISOString().slice(0, 10)
    const to   = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10)

    try {
        const rows = await getEarningsCalendarRaw(from, to, tickers)
        const earningsMap = {}
        for (const r of rows) {
            const sym = String(r.symbol ?? '').toUpperCase()
            if (sym && !earningsMap[sym]) {
                earningsMap[sym] = { date: r.date, epsEstimate: r.epsEstimated ?? null }
            }
        }
        for (const s of allStates) {
            s.upcomingEarnings = earningsMap[String(s.asset ?? '').toUpperCase()] ?? null
        }
    } catch (err) {
        logger.warn(LOG, 'earnings fetch failed', err.message)
    }

    // P&L % relative to cost basis (totalNotional - totalPnl = cost basis)
    const costBasis = totalNotional - totalPnl
    const totalPnlPct = costBasis > 0 ? (totalPnl / costBasis) * 100 : 0

    logger.info(LOG, 'computed', { portfolioId, live: liveStates.length, pending: pendingStates.length, totalNotional })

    return {
        portfolioId,
        portfolioName,
        computedAt:    Date.now(),
        totalNotional,
        totalPnl,
        totalPnlPct,
        ideas:         allStates,
        sectors,
    }
}

// Most recent conviction snapshot taken at a prior review (for the trajectory shown
// in the review state). Snapshots are appended to idea.conviction_history on review.
function _lastConviction(idea) {
    const h = idea.conviction_history
    return (Array.isArray(h) && h.length) ? h[h.length - 1] : null
}
