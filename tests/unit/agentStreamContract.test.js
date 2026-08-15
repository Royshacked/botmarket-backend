import { test } from 'node:test'
import assert from 'node:assert/strict'

import { analystAgentService }   from '../../services/agents/analyst.agent.service.js'
import { axlAgentService }       from '../../services/agents/axl.agent.service.js'
import { kairosAgentService }    from '../../services/agents/kairos.agent.service.js'
import { mentorAgentService }    from '../../services/agents/mentor.agent.service.js'
import { portfolioAgentService } from '../../services/agents/portfolio.agent.service.js'
import { scannerAgentService }   from '../../services/agents/scanner.agent.service.js'
import { CONSULT_TOOL }         from '../../services/deepThink.service.js'

// The agent-stream contract — ONE assertion body for EVERY streaming agent.
//
// The prelude a chatStream runs before runAgentStream (build the system prompt, pick the tools,
// wire the tag captures) is the one stretch of agent code nothing else covers: the parser tests
// start from a raw reply that this code never got to produce. A bad reference there throws before
// the first token, streamAgentResponse catches it, and the client is told only "Streaming failed".
// That is exactly how the analyst shipped broken — it passed `tools, toolHandlers` naming locals
// that don't exist — and how the Idea agent logged an undeclared `model`/`provider`.
//
// Each agent supplies only its own minimal valid input (the judgment); the assertions below are
// shared (the pipe). A new agent joins by adding one row + the `_run` seam.

const AGENTS = [
    { name: 'analyst  (Prometheus)', chatStream: analystAgentService.chatStream,   args: { userPrompt: 'pitch me NVDA' } },
    { name: 'axl',                   chatStream: axlAgentService.chatStream,       args: { messages: [{ role: 'user', content: 'what can you do' }] } },
    { name: 'kairos',                chatStream: kairosAgentService.chatStream,    args: { userPrompt: 'build me a TSLA long' } },
    { name: 'mentor',                chatStream: mentorAgentService.chatStream,    args: { userPrompt: 'walk me through AAPL' } },
    { name: 'portfolio (Atlas)',     chatStream: portfolioAgentService.chatStream, args: { messages: [{ role: 'user', content: 'build me a portfolio' }] } },
    { name: 'scanner   (Argus)',     chatStream: scannerAgentService.chatStream,   args: { messages: [{ role: 'user', content: 'find me momentum names' }] } },
]

// Stand in for runAgentStream: capture the bag the agent built, hand back a plain reply.
function capture(reply = 'ok') {
    const seen = {}
    return { seen, _run: async (bag) => { Object.assign(seen, bag); return reply } }
}

for (const { name, chatStream, args } of AGENTS) {
    test(`${name}: reaches the provider with a well-formed argument bag`, async () => {
        const { seen, _run } = capture()
        const result = await chatStream({ ...args, _run })

        assert.equal(typeof result?.reply, 'string', 'the turn returns a reply')

        // messages + system prompt — a turn with neither is a turn the model can't answer.
        assert.ok(Array.isArray(seen.messages), 'messages is an array')
        const promptText = Array.isArray(seen.systemPrompt)
            ? seen.systemPrompt.map(b => b.text).join('')
            : seen.systemPrompt
        assert.equal(typeof promptText, 'string')
        assert.ok(promptText.length, 'the system prompt is non-empty')

        // tools + handlers — the analyst bug: `tools` resolved to nothing at all.
        assert.ok(Array.isArray(seen.tools), 'tools is an array, not undefined')
        assert.equal(typeof seen.toolHandlers, 'object')
        assert.ok(seen.toolHandlers, 'toolHandlers is not null')
        for (const t of seen.tools) {
            assert.equal(typeof t.name, 'string', 'every tool is named')
            // Server-side tools (web_search) are run by the provider and carry no local handler.
            if (t.type) continue
            // The reasoning sidecar is the other tool a desk deliberately does NOT handle: the
            // handler is mechanism, identical everywhere, and is built inside runAgentStream — which
            // this test replaces with `_run`, so it is below the seam by design. That a declared
            // `consult` gets its handler there is asserted in agentIO.test.js; a desk wiring its own
            // here would be the plaster this arrangement exists to prevent.
            if (t.name === CONSULT_TOOL) continue
            assert.equal(typeof seen.toolHandlers[t.name], 'function', `${name}: handler for ${t.name}`)
        }

        assert.equal(typeof seen.log, 'string', 'the agent tags its log lines')
    })

    test(`${name}: forwards the client's stream wiring (Stop, tokens, chips)`, async () => {
        const { seen, _run } = capture()
        const signal = new AbortController().signal
        const onToken = () => {}
        await chatStream({ ...args, signal, onToken, reasoningEffort: 'low', _run })

        // Stop is wired end-to-end through this bag — a dropped signal means Stop stops nothing
        // client-side while the turn keeps burning model calls and tool rounds server-side.
        assert.equal(seen.signal, signal, 'the abort signal reaches the provider')
        assert.equal(seen.onToken, onToken, 'the token callback reaches the provider')
        assert.equal(seen.reasoningEffort, 'low', 'the reasoning knob reaches the provider')
    })
}
