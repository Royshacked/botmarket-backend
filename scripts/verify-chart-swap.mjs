/**
 * Phase 2 verify — the drop-in swap: cachedChartImage() (what agents + the monitor call) now
 * routes through the own-chart renderer, caches, and would fall back to chart-img on failure.
 * Also checks the concurrency pool: N charts render overlapping (wall-clock << sum of each).
 */
import 'dotenv/config'
import { buildStudies } from '../monitoring/evaluators/chart.evaluator.js'
import { cachedChartImage } from '../services/chartImgCache.service.js'
import { renderChartImage, closeRenderer } from '../services/chartRender/klineRender.provider.js'

async function main() {
    const studies = buildStudies('ema(20), rsi(14)', { fillDefaults: false })

    const t0 = Date.now()
    const a = await cachedChartImage('AAPL', 'day', studies)
    console.log(`1st call: ${a.length} b64 chars in ${Date.now() - t0}ms (own-render + fetch)`)

    const t1 = Date.now()
    const b = await cachedChartImage('AAPL', 'day', studies)
    console.log(`2nd call: ${b.length} b64 chars in ${Date.now() - t1}ms (should be cache hit, ~0ms)`)
    console.log(a === b ? '✓ cache returned identical PNG' : '✗ cache MISS (unexpected)')

    // #1 cache-key: different EMA period must NOT collide with the cached ema(20) chart.
    const s50 = buildStudies('ema(50)', { fillDefaults: false })
    const s20 = buildStudies('ema(20)', { fillDefaults: false })
    const c50 = await cachedChartImage('MSFT', 'day', s50)
    const c20 = await cachedChartImage('MSFT', 'day', s20)
    console.log(c50 !== c20 ? '✓ ema(20) vs ema(50) do NOT collide in cache' : '✗ CACHE COLLISION')

    // #3 pool: 4 distinct renders should overlap (warm browser). Sum of solo ~4×; pooled << that.
    const symbols = ['NVDA', 'TSLA', 'AMD', 'GOOGL']
    const t2 = Date.now()
    await Promise.all(symbols.map(s => renderChartImage(s, 'day', studies)))
    console.log(`4 concurrent renders in ${Date.now() - t2}ms (pool=${process.env.OWN_CHART_RENDER_CONCURRENCY || 3})`)

    await closeRenderer()
}
main().catch(async (e) => { console.error('VERIFY FAILED:', e); await closeRenderer(); process.exit(1) })
