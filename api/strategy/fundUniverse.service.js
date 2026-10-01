// The FUND UNIVERSE the channel betas are fitted on — published from the one place it is defined.
//
// `BUCKET_PROXY` (services/entity/vocabulary.js) decides which fund grades which bucket, and the
// Python engine has to fit a beta for every one of those funds (design: pythia-industries-and-
// channels.md §4, "fit the ETF, not the constituents"). The engine runs as its own Render job and
// cannot import this repo, and a second copy of the list in Python would be the mapping layer that
// drifts. So the backend WRITES the list, on every boot, and the engine READS it.
//
// Funds still held by OPEN stances are not listed here — the engine reads those straight off the
// `tilt` collection, because a stance keeps the fund it was published on after the map moves.
//
// Written at boot rather than on change because the map only changes with a deploy, and a deploy
// is a boot.

import { getDb }  from '../../providers/mongodb.provider.js'
import { logger } from '../../services/logger.service.js'
import { BUCKET_PROXY, BENCHMARK_PROXY, SECTORS, INDUSTRY_SECTOR } from '../../services/entity/vocabulary.js'

const LOG = '[fundUniverse]'
export const FUND_UNIVERSE_COLLECTION = 'pythia_fund_universe'

/**
 * { funds: [{ symbol, buckets, weighting }], market, industry_sector } — PURE, one entry per fund,
 * buckets sorted. `industry_sector` is the whole vocabulary map (all 155 industries): the engine's
 * industry reads need it to score a SECTOR fund on the companies of every industry inside it, and it
 * is defined here, so it is published from here rather than copied into Python.
 */
export function fundUniverse(proxyMap = BUCKET_PROXY) {
    const bySymbol = new Map()
    for (const [bucket, meta] of Object.entries(proxyMap)) {
        if (!meta?.symbol) continue
        const f = bySymbol.get(meta.symbol) ?? { symbol: meta.symbol, buckets: [], weighting: meta.weighting ?? null }
        f.buckets.push({ bucket, grain: SECTORS.includes(bucket) ? 'sector' : 'industry', exact: meta.exact ?? null })
        bySymbol.set(meta.symbol, f)
    }
    const funds = [...bySymbol.values()]
        .map(f => ({ ...f, buckets: f.buckets.sort((a, b) => a.bucket.localeCompare(b.bucket)) }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
    return { funds, market: BENCHMARK_PROXY.SPX, industry_sector: { ...INDUSTRY_SECTOR } }
}

const _io = {
    write: async (doc) => (await getDb()).collection(FUND_UNIVERSE_COLLECTION)
        .replaceOne({ _id: 'current' }, doc, { upsert: true }),
}
export function _setFundUniverseIO(io) { Object.assign(_io, io) }

/** Boot-time write. Never throws — a failed publish costs the engine a stale list, not the server. */
export async function publishFundUniverse(now = new Date()) {
    try {
        const u = fundUniverse()
        await _io.write({ _id: 'current', ...u, written_at: now })
        logger.info(LOG, `published ${u.funds.length} funds`)
        return u
    } catch (err) {
        logger.error(LOG, 'could not publish the fund universe', err.message)
        return null
    }
}
