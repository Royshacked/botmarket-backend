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
import { TOOLS as SCANNER_TOOLS } from '../../services/agents/scanner.agent.service.js'
import { TOOLS as PROTEUS_TOOLS } from '../../services/agents/proteus.agent.service.js'
import { MENTOR_TOOLS }             from '../../services/agents/mentor.agent.service.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../prompts/')

// A prompt may reference a tool it does not own when it is explaining ANOTHER desk's job —
// Atlas describing what Argus runs, say. Those are prose, not instructions; list them here so the
// exemption is a deliberate line in a file rather than a hole in the check.
const DESKS = [
    { prompt: 'portfolio_system_prompt.md',       tools: PORTFOLIO_TOOLS },
    { prompt: 'analyst_system_prompt.md',         tools: ANALYST_TOOLS },
    { prompt: 'axl_system_prompt.md',             tools: AXL_TOOLS },
    { prompt: 'scanner_system_prompt.md',         tools: SCANNER_TOOLS },
    { prompt: 'proteus_system_prompt.md',         tools: PROTEUS_TOOLS },
    // Mentor's guided build names a tool at nearly every rung, so it is the prompt most likely to
    // outrun its kit — it was missing from this list until the ladder was written.
    { prompt: 'mentor_system_prompt.md',          tools: MENTOR_TOOLS },
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

// ── the cost rung ─────────────────────────────────────────────────────────────
// A funnel is only cheap-first if the prompt says which tools are expensive, and the spine named ONLY
// get_chart. get_orderblocks and get_false_breaks cost exactly the same — a chart render plus a vision
// read each — and were introduced one line earlier as "reach for these when the angle is structure",
// with no cost warning at all. So a structure-angle scan was invited to spend the two most expensive
// tools in the kit across a whole pool.
// Argus's one prompt since 2026-11-11 (argus-rework.md) still carries the three vision tools until Proteus takes the
// chart: so it still has to say which of them bill per use, and point at the cheap numbers instead.
test('the scanner prompt marks all THREE vision tools as the per-use spend, not just get_chart', () => {
    const spine = readFileSync(join(ROOT, 'scanner_system_prompt.md'), 'utf8')
    const at = spine.indexOf('BILL PER USE')
    assert.ok(at > 0, 'the prompt must say which tools bill per use')
    const claim = spine.slice(Math.max(0, at - 200), at + 300)
    for (const t of ['get_chart', 'get_orderblocks', 'get_false_breaks']) {
        assert.match(claim, new RegExp(t), `${t} must be named as a per-use spend`)
    }
    assert.match(claim, /never across a list/)
    assert.match(claim, /get_candles/)
    assert.match(claim, /get_indicators/)
})
