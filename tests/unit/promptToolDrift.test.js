// Every tool a prompt tells an agent to call must be a tool that agent actually has.
// Node's built-in harness:  node --test tests/unit/promptToolDrift.test.js
//
// The failure this catches is silent and total: the prompt says `get_price_action`, the agent's kit
// doesn't contain it, and the model simply cannot make the call. No error, no warning — the step just
// never happens, and the output looks like a judgement call rather than a missing tool. It was found
// by hand while adding the TREND horizon to Atlas, which is exactly the kind of edit that causes it:
// prompts are written from what the desk SHOULD do, tool kits from what was wired.
//
// The tool arrays are IMPORTED, not parsed — half of them arrive by spread (VALUATION_TOOLS,
// MARKET_HOURS_TOOL_SPEC, …) and a source-text scan reports those as missing when they are present.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { TOOLS as PORTFOLIO_TOOLS } from '../../services/agents/portfolio.agent.service.js'
import { TOOLS as ANALYST_TOOLS }   from '../../services/agents/analyst.agent.service.js'
import { TOOLS as AXL_TOOLS }       from '../../services/agents/axl.agent.service.js'
import { TOOLS as SCANNER_TOOLS, SCANNER_TOOLS_FOR_PROFILE } from '../../services/agents/scanner.agent.service.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../prompts/')

// A prompt may reference a tool it does not own when it is explaining ANOTHER desk's job —
// Atlas describing what Argus runs, say. Those are prose, not instructions; list them here so the
// exemption is a deliberate line in a file rather than a hole in the check.
const DESKS = [
    { prompt: 'portfolio_system_prompt.md',       tools: PORTFOLIO_TOOLS },
    { prompt: 'analyst_system_prompt.md',         tools: ANALYST_TOOLS },
    { prompt: 'axl_system_prompt.md',             tools: AXL_TOOLS },
    { prompt: 'scanner_system_prompt.md',         tools: SCANNER_TOOLS },
    // The investing profile runs a SUBSET — checking it against the full kit would wave through a
    // tool Argus loses the moment it screens for a portfolio.
    { prompt: 'scanner_profile_investing.md',     tools: SCANNER_TOOLS_FOR_PROFILE('investing') },
]

for (const { prompt, tools } of DESKS) {
    test(`${prompt}: every tool it names is one the desk actually carries`, () => {
        const text  = readFileSync(join(ROOT, prompt), 'utf8')
        const named = [...new Set([...text.matchAll(/`(get_[a-z_]+|web_search|screen_candidates|compute_valuation|check_broker_symbol)`/g)].map(m => m[1]))]
        const owned = new Set(tools.map(t => t.name).filter(Boolean))
        assert.ok(named.length >= 3, `${prompt} names ${named.length} tools — the scan stopped working`)
        for (const name of named) {
            assert.ok(owned.has(name), `${prompt} tells the desk to call \`${name}\`, which is not in its tool kit`)
        }
    })
}

test('the investing profile is a real subset — the check above is not tautological', () => {
    const full = new Set(SCANNER_TOOLS.map(t => t.name))
    const inv  = SCANNER_TOOLS_FOR_PROFILE('investing').map(t => t.name)
    assert.ok(inv.length < full.size, 'investing should drop the technical kit')
    assert.ok(!inv.includes('get_candles'), 'investing screens fundamentals, not charts')
})
