/**
 * Phase A smoke test — cache miss/hit, NEWS_TOOLS, orchestrator lane params.
 * Run: node scripts/verify-phase-a.mjs
 */
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

dotenv.config()

const { NEWS_TOOLS, newsService } = await import('../services/news.service.js')

const LANE = {
    kind: 'company',
    subject: 'SMOKE_AAPL',
    ttl: '1h',
    query: 'AAPL stock',
}
const LANE_FILE = path.resolve(
    `./data/news/lanes/${LANE.kind}/${LANE.subject}_${LANE.ttl}.json`
)

function assert(cond, msg) {
    if (!cond) throw new Error(`FAIL: ${msg}`)
    console.log(`OK: ${msg}`)
}

function orchestratorLaneParams(intent) {
    const { target, ticker } = intent
    const query =
        target === 'market' || target === 'global'
            ? 'stock market'
            : [ticker, 'stock'].filter(Boolean).join(' ')
    const kind =
        target === 'market' || target === 'global' ? 'market' : 'company'
    const subject = ticker ?? (target === 'market' ? 'MARKET' : 'GENERAL')
    const ttl = kind === 'market' ? '15m' : '1h'
    return { kind, subject, ttl, query }
}

async function main() {
    if (!process.env.GNEWS_API_KEY?.trim()) {
        throw new Error('GNEWS_API_KEY missing in .env — cannot smoke-test API fetch')
    }

    // NEWS_TOOLS.buildCacheKey
    const keyResult = await NEWS_TOOLS.buildCacheKey.handler(LANE)
    assert(
        keyResult.cacheKey === 'news:company:SMOKE_AAPL:1h',
        'NEWS_TOOLS.buildCacheKey'
    )

    // Cold: remove lane file if present
    if (fs.existsSync(LANE_FILE)) {
        fs.unlinkSync(LANE_FILE)
    }
    assert(!fs.existsSync(LANE_FILE), 'lane file removed for cold start')

    const cold = await NEWS_TOOLS.getOrFetchLane.handler(LANE)
    assert(cold.meta.cached === false, 'cold fetch meta.cached === false')
    assert(cold.articles.length > 0, 'cold fetch returned articles')
    assert(fs.existsSync(LANE_FILE), 'lane file written after cold fetch')

    const warm = await newsService.getOrFetchLane(LANE)
    assert(warm.meta.cached === true, 'warm fetch meta.cached === true')
    assert(warm.articles.length >= cold.articles.length, 'warm fetch has articles')

    // Orchestrator-equivalent lane params (company)
    const companyParams = orchestratorLaneParams({
        target: 'company',
        ticker: 'AAPL',
    })
    assert(companyParams.kind === 'company', 'orchestrator company kind')
    assert(companyParams.subject === 'AAPL', 'orchestrator company subject')
    assert(companyParams.ttl === '1h', 'orchestrator company ttl')
    assert(companyParams.query.includes('AAPL'), 'orchestrator company query')

    const marketParams = orchestratorLaneParams({ target: 'market' })
    assert(marketParams.kind === 'market', 'orchestrator market kind')
    assert(marketParams.subject === 'MARKET', 'orchestrator market subject')
    assert(marketParams.ttl === '15m', 'orchestrator market ttl')

    // Orchestrator uses same API as NEWS_TOOLS — re-use warm smoke lane (no extra API call)
    const orchHandler = await NEWS_TOOLS.getOrFetchLane.handler(LANE)
    assert(orchHandler.meta.cached === true, 'NEWS_TOOLS.getOrFetchLane.handler warm cache hit')

    const { orchestratorService } = await import('../api/orchestrator/orchestrator.service.js')
    assert(typeof orchestratorService.runOrchestration === 'function', 'orchestrator module loads')

    const { finnhubNewsService } = await import('../services/news.finnhub.service.js')
    assert(
        typeof finnhubNewsService.queryRelevantFeed === 'function',
        'finnhubNewsService for newsFeed poller'
    )

    // Clean up smoke lane only
    if (fs.existsSync(LANE_FILE)) {
        fs.unlinkSync(LANE_FILE)
    }

    console.log('\nPhase A smoke test passed.')
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
