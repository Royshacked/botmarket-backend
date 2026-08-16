import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { TOOL_SCHEMAS, TOOL_NAMES, toolsFor } from '../../services/agentTools.registry.js'
import { TOOLS as PORTFOLIO_TOOLS } from '../../services/agents/portfolio.agent.service.js'
import { TOOLS as SCANNER_TOOLS }   from '../../services/agents/scanner.agent.service.js'
import { TOOLS as ANALYST_TOOLS }   from '../../services/agents/analyst.agent.service.js'
import { TOOLS as AXL_TOOLS }       from '../../services/agents/axl.agent.service.js'
import { TOOLS as STRATEGY_TOOLS } from '../../services/agents/strategy.agent.service.js'
import { KAIROS_TOOLS }             from '../../services/tools/kairos.tools.js'
import { MENTOR_TOOLS }             from '../../services/agents/mentor.agent.service.js'
import { SMC_TOOLS }                from '../../services/tools/smc.tools.js'
import { VALUATION_TOOLS }          from '../../services/tools/valuation.tools.js'

// EQUIVALENCE HARNESS for the tool-registry consolidation.
//
// 87 tool declarations across 5 agents collapsed to 34 schemas. The snapshot fixture holds what
// every agent sent to the model BEFORE the refactor; these tests assert the registry reproduces it.
//
// What must match EXACTLY:
//   • the tool list — same names, same ORDER (prompt caching keys off the array prefix)
//   • the top-level `description` — that string is the instruction the model reads, and it is
//     deliberately tuned per desk. Rewriting it would silently change an agent's behaviour.
//   • the structure — properties, types, enums, required, and cache_control placement
//
// What is allowed to differ: the human prose INSIDE a parameter (one agent's ticker example read
// "e.g. GME, TSLA, AAPL" and another's "e.g. TSLA, GME, AAPL"). Canonicalising that noise is the
// entire point; keeping it per-agent would defeat the consolidation.
//
// Past the refactor it keeps earning its keep as a CHANGE DETECTOR: a tool list, description or
// schema never drifts by accident. A DELIBERATE change (Atlas gaining get_chart) is appended to
// the fixture in the same commit — the point is that it can't happen silently.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT  = JSON.parse(fs.readFileSync(join(__dirname, '../fixtures/agentTools.snapshot.json'), 'utf8'))

// Axl joined late and had no row here at all — it picked up get_trading_context and
// check_broker_symbol in c06842c while every other agent's tool list was change-detected and its
// wasn't. Its tools are now covered like everyone else's, which is also what stops save_objective
// reading as an orphan schema below.
// Mentor had the same gap Axl did, for the same reason: it borrowed KAIROS_TOOLS wholesale, so it
// was covered only transitively and its own list was never change-detected. It has its own array
// now (Kairos's kit + the `consult` sidecar), which is also what stops `consult` reading as an
// orphan schema below.
const LIVE = {
    strategy:  STRATEGY_TOOLS,
    portfolio: PORTFOLIO_TOOLS,
    scanner:   SCANNER_TOOLS,
    analyst:   ANALYST_TOOLS,
    kairos:    KAIROS_TOOLS,
    mentor:    MENTOR_TOOLS,
    axl:       AXL_TOOLS,
}

/** Structure only — everything a model can ACT on, with human prose stripped out. */
function structure(tool) {
    if (tool.type) return { type: tool.type, name: tool.name }
    const props = {}
    for (const [k, v] of Object.entries(tool.input_schema?.properties ?? {})) {
        props[k] = {
            type:     v.type,
            enum:     v.enum ?? null,
            items:    v.items ?? null,
            required: v.required ?? null,
            // A nested object param (get_cycle_analysis.calendar_window) has its own properties.
            props:    v.properties ? Object.keys(v.properties).sort() : null,
        }
    }
    return {
        name:     tool.name,
        props,
        required: (tool.input_schema?.required ?? []).slice().sort(),
        cached:   !!tool.cache_control,
    }
}

for (const [agent, live] of Object.entries(LIVE)) {
    test(`${agent}: same tools, in the same order`, () => {
        assert.deepEqual(live.map(t => t.name), SNAPSHOT[agent].map(t => t.name))
    })

    test(`${agent}: every description is preserved verbatim (judgment is not rewritten)`, () => {
        for (const [i, before] of SNAPSHOT[agent].entries()) {
            assert.equal(live[i].description, before.description, `${agent}.${before.name}`)
        }
    })

    test(`${agent}: structure is unchanged — params, types, enums, required, cache_control`, () => {
        for (const [i, before] of SNAPSHOT[agent].entries()) {
            assert.deepEqual(structure(live[i]), structure(before), `${agent}.${before.name}`)
        }
    })
}

// ─── The registry itself ──────────────────────────────────────────────────────

// Tools owned by a dedicated shared module already have exactly one home, so they stay there —
// copying them into the registry would recreate the duplication this whole change removes. Agents
// spread those arrays in directly.
const MODULE_OWNED = new Set([...SMC_TOOLS, ...VALUATION_TOOLS].map(t => t.name))

test('every tool an agent uses has exactly one home — registry or a shared module', () => {
    const used = new Set(Object.values(LIVE).flat().map(t => t.name))
    for (const name of used) {
        assert.ok(TOOL_NAMES.includes(name) || MODULE_OWNED.has(name), `homeless schema: ${name}`)
    }
})

test('no tool is declared in BOTH the registry and a shared module', () => {
    // Two homes is worse than one bad home: they drift silently and neither is authoritative.
    for (const name of MODULE_OWNED) {
        assert.ok(!TOOL_NAMES.includes(name), `${name} is owned by a shared module AND the registry`)
    }
})

test('the registry has no orphans — every schema is used by some agent', () => {
    // An unused schema is dead weight that will drift out of sync with reality unnoticed.
    const used = new Set(Object.values(LIVE).flat().map(t => t.name))
    for (const name of TOOL_NAMES) assert.ok(used.has(name), `orphan schema: ${name}`)
})

// ─── The reasoning sidecar, across desks ──────────────────────────────────────

// The five AUTHORING desks carry `consult` (services/deepThink.service.js). The two exclusions are
// deliberate and each has its own reason, which is why they are listed rather than omitted:
//   • kairos — the call builder is asleep (CLAUDE.md). In-flight calls still run there, but nothing
//     new is built at that desk, so it does not gain a tool. If it wakes, this row is the reminder.
//   • axl    — reception authors nothing, and its clause would have ruled out routing/explaining,
//     i.e. nearly everything it does. A declaration read on every turn and reached for almost never
//     loses money. See the note at the foot of axl.agent.service.js's TOOLS.
const CONSULTS = new Set(['strategy', 'portfolio', 'scanner', 'analyst', 'mentor'])

for (const [agent, live] of Object.entries(LIVE)) {
    test(`${agent}: ${CONSULTS.has(agent) ? 'declares' : 'does not declare'} the reasoning sidecar`, () => {
        const has = live.some(t => t.name === 'consult')
        assert.equal(has, CONSULTS.has(agent))
        // Declaring it is the WHOLE opt-in — runAgentStream builds the handler off the declaration
        // (services/agentIO.js), so a desk that declares it has already wired it.
        if (has) assert.equal(live[live.length - 1].name, 'consult',
            'the sidecar is APPENDED last — anywhere earlier re-writes that desk\'s tool cache')
    })
}

test('every desk names its OWN decisions — the sidecar description is not copy-pasted', () => {
    // The failure this catches is a desk inheriting another's when-clause, which reads as plausible
    // and is silently wrong: Argus told to consult on "final sizing" would consult on nothing it
    // ever does. The shared mechanism paragraphs are IDENTICAL by construction (consultDescription);
    // only the middle may differ, and it must.
    const middles = [...CONSULTS].map(agent => {
        const desc = LIVE[agent].find(t => t.name === 'consult').description
        const parts = desc.split('\n\n')
        // First paragraph is the shared what-it-is, last is the shared restraint.
        assert.ok(parts.length >= 3, `${agent}: no when-clause between the shared halves`)
        return parts.slice(1, -1).join('\n\n')
    })
    assert.equal(new Set(middles).size, middles.length, 'two desks share a when-clause')
})

test('the shared halves of the sidecar description are byte-identical across desks', () => {
    const halves = [...CONSULTS].map(agent => {
        const parts = LIVE[agent].find(t => t.name === 'consult').description.split('\n\n')
        return JSON.stringify([parts[0], parts[parts.length - 1]])
    })
    assert.equal(new Set(halves).size, 1, 'a desk has grown its own copy of the mechanism text')
})

test('an unknown tool fails loudly rather than silently producing a broken definition', () => {
    // A typo'd name must not reach the model as `{ name, description, input_schema: undefined }`.
    assert.throws(() => toolsFor({ get_nonexistent: 'x' }), /unknown tool "get_nonexistent"/)
})

test('omit drops a parameter AND its required entry', () => {
    // Argus gets no show_to_user: scanner charts are deliberately never surfaced to the user.
    const [tool] = toolsFor({ get_chart: { description: 'd', omit: ['show_to_user', 'timeframe'] } })
    assert.ok(!('show_to_user' in tool.input_schema.properties))
    assert.ok(!('timeframe' in tool.input_schema.properties))
    assert.deepEqual(tool.input_schema.required, ['ticker'], 'an omitted param must leave `required` too')
})

test('omit never mutates the shared schema — the next agent must see it intact', () => {
    toolsFor({ get_chart: { description: 'd', omit: ['show_to_user'] } })
    assert.ok('show_to_user' in TOOL_SCHEMAS.get_chart.properties, 'registry was mutated by a caller')
    const [again] = toolsFor({ get_chart: 'd' })
    assert.ok('show_to_user' in again.input_schema.properties)
})

test('cache_control is opt-in per spec entry, because it marks a POSITION not a tool', () => {
    const [plain] = toolsFor({ get_quote: 'd' })
    const [cached] = toolsFor({ get_quote: { description: 'd', cache: true } })
    assert.equal(plain.cache_control, undefined)
    assert.deepEqual(cached.cache_control, { type: 'ephemeral' })
})

test('a server-side tool passes through by type, with no input_schema', () => {
    const [ws] = toolsFor({ web_search: '' })
    assert.deepEqual(ws, { type: 'web_search_20250305', name: 'web_search' })
})

test('spec order is preserved — prompt caching keys off the array prefix', () => {
    const names = toolsFor({ get_candles: 'a', get_quote: 'b', get_chart: 'c' }).map(t => t.name)
    assert.deepEqual(names, ['get_candles', 'get_quote', 'get_chart'])
})
