// PROTEUS v2's tool for the trader (docs/design/proteus-v2.md §3, P3 — Roy 2026-11-21: "if the user says he wants r:r 3:1,
// Mentor should ask Proteus where the stop and the TP go with this ratio"). The levels are measured; the trade is Mentor's.

import { makeToolHandler } from '../agentUtils.js'
import { levelsFor } from '../stockProfile.service.js'
import { levelsBrief } from '../stockProfile.format.js'

const LOG = '[stockProfile.tools]'

export const LEVELS_FOR_DESCRIPTION = `Where the stop and the target go on THIS stock for a reward : risk the USER asked for ("I want 3:1") — measured from its own candles on the trade's scale (the horizon picks it). The stop sits past a normal pullback (the same multiple of the stock's σ over the horizon on every stock — a tighter stop is shaken out by its ordinary counter-moves), the target is the ratio × the stop; with the prices from the last close, how often that pair's target came first on its last 3 years, how long it took and how often it did not finish within the horizon's hold, and the target that FITS the horizon's time. Call it when the user names a ratio; say what the ratio COSTS on this stock in one line (e.g. "3:1 on a KO swing is a ~26% target — in the last 3 years it came first in ~2%, and 88% did not finish within the 3 months a swing holds; the target that fits a swing is ~4%"). It does not refuse a ratio and it is a description, not an edge: the stop and the target stay your judgement against the chart.`

export function makeStockProfileHandlers({ levels = levelsFor } = {}) {
    return {
        get_levels_for: makeToolHandler('get_levels_for', async ({ ticker, ratio, horizon = 'swing', side = 'long' } = {}) => {
            const sym = String(ticker ?? '').trim().toUpperCase()
            if (!sym) return 'A ticker is required.'
            const r = Number(ratio)
            if (!(r > 0)) return 'The ratio must be a positive number — reward per 1 of risk (3 for 3:1).'
            return levelsBrief(await levels(sym, r, { horizon, side }))
        }, (err) => `Could not measure the levels just now: ${err.message}`, LOG),
    }
}

export const STOCK_PROFILE_HANDLERS = makeStockProfileHandlers()
