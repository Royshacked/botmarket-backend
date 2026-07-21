// Deterministic Smart-Money-Concepts primitives over OHLCV bars (K2, KAIROS_MODES.md).
// PURE functions — input `bars` oldest→newest, each { open, high, low, close, volume, timestamp }.
// This is the SHARED engine: the Kairos SMC mode's tools consume it, and it's reusable by Argus/Hermes
// (DRY). It yields EXACT monitorable levels (vs today's vision estimates) that flow into entry_zones /
// reference_levels so any discretionary monitor can gate on them.
//
// HONEST LIMIT: no L2 / order-flow / volume-at-price → this is STRUCTURE-based smart-money ("SMC-lite"),
// which is ~90% of retail SMC. Don't over-claim tape reading.

/**
 * Swing points via a symmetric fractal: bar[i] is a swing HIGH if its high strictly exceeds the
 * `lookback` bars on each side (swing LOW symmetric). Returns swings in time order.
 * @returns {Array<{type:'high'|'low', i:number, price:number, at:number}>}
 */
export function swings(bars, lookback = 2) {
    const out = []
    for (let i = lookback; i < bars.length - lookback; i++) {
        let isHigh = true, isLow = true
        for (let j = i - lookback; j <= i + lookback; j++) {
            if (j === i) continue
            if (bars[j].high >= bars[i].high) isHigh = false
            if (bars[j].low  <= bars[i].low)  isLow  = false
        }
        if (isHigh) out.push({ type: 'high', i, price: bars[i].high, at: bars[i].timestamp })
        if (isLow)  out.push({ type: 'low',  i, price: bars[i].low,  at: bars[i].timestamp })
    }
    return out
}

/**
 * Fair-value gaps (3-candle imbalance). Bullish: low[i+1] > high[i-1] (gap left by an up-impulse);
 * bearish: high[i+1] < low[i-1]. `mitigated` = a later bar traded back INTO the gap. Most-recent first.
 * @returns {Array<{type:'bullish'|'bearish', top:number, bottom:number, at:number, mitigated:boolean}>}
 */
export function detectFVG(bars) {
    const gaps = []
    for (let i = 1; i < bars.length - 1; i++) {
        const prev = bars[i - 1], next = bars[i + 1]
        if (next.low > prev.high) {
            const bottom = prev.high, top = next.low
            const mitigated = bars.slice(i + 2).some(b => b.low <= top)
            gaps.push({ type: 'bullish', top, bottom, at: bars[i].timestamp, mitigated })
        } else if (next.high < prev.low) {
            const top = prev.low, bottom = next.high
            const mitigated = bars.slice(i + 2).some(b => b.high >= bottom)
            gaps.push({ type: 'bearish', top, bottom, at: bars[i].timestamp, mitigated })
        }
    }
    return gaps.reverse()
}

/**
 * Liquidity pools = clusters of ≥2 near-equal swing highs (buy-side, above) / lows (sell-side, below),
 * within `tolPct`. Stops rest there → prime sweep targets. Prices are the cluster average.
 * @returns {{ buyside: Array<{price:number,count:number}>, sellside: Array<{price:number,count:number}> }}
 */
export function detectLiquidity(bars, { lookback = 2, tolPct = 0.001 } = {}) {
    const sw = swings(bars, lookback)
    const cluster = (points) => {
        const pools = []
        for (const p of points) {
            const hit = pools.find(pool => Math.abs(pool.price - p.price) / pool.price <= tolPct)
            if (hit) { hit.price = (hit.price * hit.count + p.price) / (hit.count + 1); hit.count++ }
            else pools.push({ price: p.price, count: 1 })
        }
        return pools.filter(pool => pool.count >= 2)   // "equal" needs ≥2 touches
    }
    return {
        buyside:  cluster(sw.filter(s => s.type === 'high')),
        sellside: cluster(sw.filter(s => s.type === 'low')),
    }
}

/**
 * Market structure: the trend + the last BOS (continuation) / CHoCH (reversal). Trend from the last
 * two swing highs + lows (HH+HL → up, LH+LL → down). A last close beyond the PRIOR swing high/low is a
 * break — BOS if with the trend, CHoCH if against it.
 * @returns {{ trend:'up'|'down'|'range', swings:Array, event:object|null, lastSwingHigh:number|null, lastSwingLow:number|null }}
 */
export function detectStructure(bars, { lookback = 2 } = {}) {
    const sw    = swings(bars, lookback)
    const highs = sw.filter(s => s.type === 'high')
    const lows  = sw.filter(s => s.type === 'low')
    const lastH = highs.at(-1), prevH = highs.at(-2), lastL = lows.at(-1), prevL = lows.at(-2)

    let trend = 'range'
    if (lastH && prevH && lastL && prevL) {
        if (lastH.price > prevH.price && lastL.price > prevL.price) trend = 'up'
        else if (lastH.price < prevH.price && lastL.price < prevL.price) trend = 'down'
    }

    // A break of the MOST-RECENT confirmed swing high/low: BOS if with the trend, CHoCH if against it.
    const lastClose = bars.at(-1)?.close ?? null
    let event = null
    if (lastClose != null && lastH && lastClose > lastH.price) {
        event = { type: trend === 'down' ? 'CHoCH' : 'BOS', direction: 'up', level: lastH.price, at: bars.at(-1).timestamp }
    } else if (lastClose != null && lastL && lastClose < lastL.price) {
        event = { type: trend === 'up' ? 'CHoCH' : 'BOS', direction: 'down', level: lastL.price, at: bars.at(-1).timestamp }
    }
    return { trend, swings: sw, event, lastSwingHigh: lastH?.price ?? null, lastSwingLow: lastL?.price ?? null }
}

/**
 * Premium/discount: the dealing range (last swing high ↔ low) split at equilibrium (50%). Price above
 * eq = PREMIUM (favor shorts), below = DISCOUNT (favor longs). Null when there's no clean range.
 * @returns {{ high:number, low:number, equilibrium:number, price:number|null, zone:'premium'|'discount'|null }|null}
 */
export function premiumDiscount(bars, { lookback = 2 } = {}) {
    const { lastSwingHigh, lastSwingLow } = detectStructure(bars, { lookback })
    if (lastSwingHigh == null || lastSwingLow == null || lastSwingHigh <= lastSwingLow) return null
    const equilibrium = (lastSwingHigh + lastSwingLow) / 2
    const price = bars.at(-1)?.close ?? null
    const zone  = price == null ? null : price >= equilibrium ? 'premium' : 'discount'
    return { high: lastSwingHigh, low: lastSwingLow, equilibrium, price, zone }
}
