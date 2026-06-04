/**
 * Phase B smoke test — tool registry, session clarify/resume, optional live agent parity.
 * Run: node scripts/verify-phase-b.mjs
 * Live (OpenAI agent + Groq analysis): VERIFY_PHASE_B_LIVE=1 node scripts/verify-phase-b.mjs
 */
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

dotenv.config()

const ROOT = path.resolve(import.meta.dirname, '..')

function assert(cond, msg) {
    if (!cond) throw new Error(`FAIL: ${msg}`)
    console.log(`OK: ${msg}`)
}

function loadJson(relPath) {
    const file = path.join(ROOT, relPath)
    assert(fs.existsSync(file), `fixture exists: ${relPath}`)
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** Phase A lane params (old orchestrator) — parity reference */
function phaseALaneParams(intent) {
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

function assertAnalysisFields(analysis, label) {
    assert(analysis && typeof analysis === 'object', `${label} is an object`)
    assert(typeof analysis.summary === 'string' && analysis.summary.length > 0, `${label}.summary`)
    assert(typeof analysis.sentiment === 'string' && analysis.sentiment.length > 0, `${label}.sentiment`)
}

function assertComposedShape(data, { news, technical }) {
    assert(data && typeof data === 'object', 'composed data is object')
    if (news && technical) {
        assert(data.news && data.technical, 'both → { news, technical }')
        assertAnalysisFields(data.news, 'news')
        assertAnalysisFields(data.technical, 'technical')
        return
    }
    if (news) {
        assert(!data.technical, 'news-only has no technical sibling')
        assertAnalysisFields(data, 'news-only root')
        return
    }
    if (technical) {
        assert(!data.news, 'technical-only has no news sibling')
        assertAnalysisFields(data, 'technical-only root')
    }
}

async function testToolRegistry() {
    const {
        ORCHESTRATOR_TOOL_ALLOWLIST,
        listToolsForAgent,
        executeTool,
        getOrchestratorTool,
    } = await import('../services/orchestrator.toolRegistry.js')

    assert(ORCHESTRATOR_TOOL_ALLOWLIST.length === 6, 'allowlist has 6 tools')
    const defs = listToolsForAgent()
    assert(defs.length === 6, 'listToolsForAgent returns 6 definitions')
    const openAiNamePattern = /^[a-zA-Z0-9_-]+$/
    assert(
        defs.every((d) => d.type === 'function' && d.name && openAiNamePattern.test(d.name)),
        'tool defs are Responses API functions with API-safe names'
    )
    for (const id of ORCHESTRATOR_TOOL_ALLOWLIST) {
        const agentName = id.replace(/\./g, '_')
        const def = defs.find((d) => d.name === agentName)
        assert(def != null, `listToolsForAgent exposes ${agentName} for ${id}`)
    }
    assert(openAiNamePattern.test('orchestrator_submit_terminal'), 'terminal agent tool name')

    for (const id of ORCHESTRATOR_TOOL_ALLOWLIST) {
        assert(getOrchestratorTool(id) != null, `registry has ${id}`)
    }

    const missingQuery = await executeTool('news.get_or_fetch_lane', {
        kind: 'company',
        subject: 'AAPL',
        ttl: '1h',
    })
    assert(!missingQuery.ok && /query/i.test(missingQuery.error), 'validates missing query')

    const keyOut = await executeTool('news.build_cache_key', {
        kind: 'company',
        subject: 'AAPL',
        ttl: '1h',
    })
    assert(keyOut.ok && keyOut.result.cacheKey === 'news:company:AAPL:1h', 'news.build_cache_key')

    const laneOut = await executeTool('news.get_or_fetch_lane', {
        kind: 'company',
        subject: 'AAPL',
        ttl: '1h',
        query: 'AAPL stock',
    })
    assert(laneOut.ok, 'news.get_or_fetch_lane ok')
    assert(laneOut.result.articles?.length > 0, 'news.get_or_fetch_lane articles')

    const resolveOut = await executeTool('price.resolve_candle_opts', {
        timeSpan: 'minute',
        multiplier: 15,
        lookbackDays: 3,
        priceAnalysis: { timeSpan: 'minute', multiplier: 15, lookbackDays: 3 },
    })
    assert(resolveOut.ok && resolveOut.result.timeSpan === 'minute', 'price.resolve_candle_opts')

    const candlesOut = await executeTool('price.get_candles', {
        ticker: 'NVDA',
        timeSpan: 'minute',
        multiplier: 15,
        refresh: false,
    })
    assert(candlesOut.ok, 'price.get_candles ok')
    assert(candlesOut.result.candles?.length > 0, 'price.get_candles rows')
    assert(
        typeof candlesOut.result.meta?.cached === 'boolean',
        'price.get_candles meta.cached'
    )

    const articles = laneOut.result.articles
    const newsAnalysisOut = await executeTool('news.get_analysis', {
        ticker: 'AAPL',
        analysisGoal: 'Phase B smoke — AAPL news',
        articles,
        refresh: false,
    })
    assert(newsAnalysisOut.ok, 'news.get_analysis ok')
    assert(newsAnalysisOut.result.analysis, 'news.get_analysis returns analysis')
    assertAnalysisFields(newsAnalysisOut.result.analysis, 'news.get_analysis')

    const barSpec = { timeSpan: 'minute', multiplier: 15 }
    const priceAnalysisOut = await executeTool('price.get_analysis', {
        ticker: 'NVDA',
        analysisGoal: 'Phase B smoke — NVDA technical',
        candles: candlesOut.result.candles,
        barSpec,
        barLimit: resolveOut.result.barLimit,
        refresh: false,
    })
    assert(priceAnalysisOut.ok, 'price.get_analysis ok')
    assert(priceAnalysisOut.result.analysis, 'price.get_analysis returns analysis')
    assertAnalysisFields(priceAnalysisOut.result.analysis, 'price.get_analysis')
}

async function testSearchQueryParity() {
    const { buildSearchQueryFromIntent } = await import(
        '../services/orchestrator.agent.service.js'
    )

    const cases = [
        { intent: { target: 'market' }, expected: 'stock market' },
        { intent: { target: 'company', ticker: 'AAPL' }, expected: 'AAPL stock' },
        { intent: { target: 'earnings', ticker: 'NVDA' }, expected: 'NVDA earnings' },
        {
            intent: { target: 'sector', targetName: 'semiconductors' },
            expected: 'semiconductors finance news',
        },
    ]

    for (const { intent, expected } of cases) {
        const query = buildSearchQueryFromIntent(intent)
        assert(query === expected, `search query: ${expected}`)
        const lane = phaseALaneParams(intent)
        if (intent.target === 'market') {
            assert(lane.kind === 'market' && lane.ttl === '15m', 'market lane ttl')
        }
        if (intent.ticker === 'AAPL') {
            assert(lane.kind === 'company' && lane.subject === 'AAPL', 'AAPL lane subject')
        }
    }
}

async function testSessionClarifyResume() {
    const { orchestratorSessionService } = await import(
        '../services/orchestrator.session.service.js'
    )

    const session = orchestratorSessionService.createSession({
        lastUserPrompt: 'analyze something',
    })
    const sid = session.sessionId
    assert(typeof sid === 'string' && sid.length > 0, 'sessionId generated')

    orchestratorSessionService.appendMessage(sid, { role: 'user', content: 'analyze something' })
    orchestratorSessionService.setIntent(sid, {
        target: 'company',
        ticker: 'AAPL',
        analysisType: 'news',
        analysisGoal: 'news smoke',
    })

    const question = 'Which ticker do you want news for?'
    orchestratorSessionService.setAwaitingClarification(sid, question)

    const awaiting = orchestratorSessionService.getSession(sid)
    assert(awaiting.status === 'awaiting_clarification', 'status awaiting_clarification')
    assert(awaiting.clarifyQuestion === question, 'clarifyQuestion stored')
    assert(
        awaiting.messages.some((m) => m.role === 'assistant' && m.content === question),
        'assistant clarify message appended'
    )

    const resumed = orchestratorSessionService.resumeSession(sid, 'AAPL news please')
    assert(!('err' in resumed), 'resumeSession succeeds')
    assert(resumed.session.status === 'looking', 'resume sets status looking')
    assert(
        resumed.session.messages.filter((m) => m.role === 'user').length >= 2,
        'resume appends user follow-up'
    )

    orchestratorSessionService.completeSession(sid, {
        analysis: { summary: 'smoke', sentiment: 'neutral' },
    })
    const done = orchestratorSessionService.getSession(sid)
    assert(done.status === 'completed', 'session completed')

    const blocked = orchestratorSessionService.resumeSession(sid, 'more')
    assert('err' in blocked && blocked.status === 400, 'cannot resume completed session')
}

async function testOrchestratorModuleLoads() {
    const { orchestratorService } = await import('../api/orchestrator/orchestrator.service.js')
    const { oldOrchestratorService } = await import(
        '../api/orchestrator/oldOrchestrator.service.js'
    )
    assert(typeof orchestratorService.runOrchestration === 'function', 'phase B orchestrator loads')
    assert(typeof oldOrchestratorService.runOrchestration === 'function', 'archived phase A loads')
}

function liveKeysPresent() {
    return Boolean(
        process.env.OPENAI_API_KEY?.trim() &&
            process.env.GROQ_API_KEY?.trim() &&
            (process.env.GNEWS_API_KEY?.trim() || fs.existsSync(path.join(ROOT, 'data/news/lanes/company/AAPL_1h.json'))) &&
            (process.env.MASSIVE_API_KEY?.trim() ||
                fs.existsSync(path.join(ROOT, 'data/candles/NVDA/minute/15M.json')))
    )
}

async function runLiveParityCase(label, userPrompt, shape) {
    const { orchestratorService } = await import('../api/orchestrator/orchestrator.service.js')
    const { oldOrchestratorService } = await import(
        '../api/orchestrator/oldOrchestrator.service.js'
    )

    console.log(`\n[live] ${label} — phase A`)
    const phaseA = await oldOrchestratorService.runOrchestration(userPrompt)
    if (phaseA.ok) {
        assertComposedShape(phaseA.data, shape)
        assert(
            phaseA.intent?.analysisType === shape.expectedType ||
                (shape.expectedType === 'both' && phaseA.intent?.analysisType === 'both'),
            `${label}: phase A intent.analysisType`
        )
        console.log(`OK: ${label}: phase A ok`)
    } else {
        console.warn(
            `[live] ${label}: phase A skipped (${phaseA.err ?? 'failed'}) — continuing with phase B`
        )
    }

    console.log(`[live] ${label} — phase B agent`)
    const phaseB = await orchestratorService.runOrchestration({ userPrompt })
    assert(phaseB.ok, `${label}: phase B ok`)
    assert(phaseB.sessionId, `${label}: phase B sessionId`)
    assert(phaseB.status === 'completed', `${label}: phase B completed`)
    assertComposedShape(phaseB.data, shape)
    assert(
        phaseB.intent?.analysisType === shape.expectedType ||
            (shape.expectedType === 'both' && phaseB.intent?.analysisType === 'both'),
        `${label}: phase B intent.analysisType`
    )
}

async function testLiveClarifyResume() {
    const { orchestratorService } = await import('../api/orchestrator/orchestrator.service.js')

    console.log('\n[live] clarify — vague prompt')
    const first = await orchestratorService.runOrchestration({
        userPrompt: 'Can you analyze this for me?',
    })
    assert(!first.ok && first.status === 'awaiting_clarification', 'clarify: not ok')
    assert(first.sessionId, 'clarify: sessionId')
    assert(first.clarify?.question?.length > 0, 'clarify: question')
    assert(first.intent?.analysisType === 'unclear', 'clarify: intent unclear')

    console.log('[live] clarify — resume with AAPL news')
    const second = await orchestratorService.runOrchestration({
        userPrompt: 'News analysis for AAPL stock please',
        sessionId: first.sessionId,
    })
    assert(second.ok, 'resume: completed')
    assert(second.status === 'completed', 'resume: status completed')
    assert(second.sessionId === first.sessionId, 'resume: same sessionId')
    assertComposedShape(second.data, { news: true, technical: false })
    assert(
        second.intent?.analysisType === 'news' || second.intent?.ticker === 'AAPL',
        'resume: news intent or AAPL ticker'
    )
}

async function testLiveParity() {
    if (!liveKeysPresent()) {
        throw new Error(
            'VERIFY_PHASE_B_LIVE=1 requires OPENAI_API_KEY and GROQ_API_KEY; cached news/candles or GNEWS/MASSIVE keys for cold paths'
        )
    }

    await runLiveParityCase(
        'AAPL news',
        'What is the latest news on Apple (AAPL)?',
        { news: true, technical: false, expectedType: 'news' }
    )
    await runLiveParityCase(
        'market news',
        'How is the overall stock market doing today?',
        { news: true, technical: false, expectedType: 'news' }
    )
    await runLiveParityCase(
        'NVDA technical',
        'Give me a 15-minute technical chart analysis for NVDA',
        { news: false, technical: true, expectedType: 'technical' }
    )
    await runLiveParityCase(
        'AAPL both',
        'Full analysis on AAPL — latest news and 1-minute chart technicals',
        { news: true, technical: true, expectedType: 'both' }
    )

    await testLiveClarifyResume()
}

async function main() {
    console.log('Phase B — offline checks\n')

    loadJson('data/news/lanes/company/AAPL_1h.json')
    loadJson('data/candles/NVDA/minute/15M.json')

    await testOrchestratorModuleLoads()
    await testSearchQueryParity()
    await testSessionClarifyResume()
    await testToolRegistry()

    const runLive = process.env.VERIFY_PHASE_B_LIVE === '1'
    if (runLive) {
        console.log('\nPhase B — live agent parity (VERIFY_PHASE_B_LIVE=1)\n')
        await testLiveParity()
    } else {
        console.log(
            '\nSkipped live parity (set VERIFY_PHASE_B_LIVE=1 with API keys to run AAPL/market/NVDA/both + clarify resume).'
        )
    }

    console.log('\nPhase B smoke test passed.')
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
