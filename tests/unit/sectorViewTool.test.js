import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { formatSectorView, makeSectorViewHandlers, SECTOR_VIEW_TOOL_SPEC } from '../../services/tools/sectorView.tools.js'
import { TOOLS as AXL_TOOLS } from '../../services/agents/axl.agent.service.js'
import { isToolError, toolErrorText } from '../../services/toolResult.util.js'

// Axl's READ of the house view. Reporting a published view is Axl's half of the line; authoring or
// changing one is Pythia's and gets a <route>.

const row = (over = {}) => ({
    sector: 'Healthcare', stance: 'over', active_bp: 150, horizon: '6m',
    contribution_bp: 9, rationale: 'Defensive earnings into a slowing tape.', ...over,
})
const doc = (over = {}) => ({
    benchmark: 'SPX', balanced: true, net_bp: 0, created_at: '2026-08-06T00:00:00.000Z',
    regime: { name: 'late-cycle disinflation', thesis: 'Growth slows.', kill_criteria: ['core CPI above 3.5% twice'] },
    tilts: [row()], ...over,
})

test('the formatted view carries the regime, its falsifiers and each stance', () => {
    const out = formatSectorView(doc())
    assert.match(out, /Regime: late-cycle disinflation/)
    assert.match(out, /What would break this read/)
    assert.match(out, /core CPI above 3.5% twice/)
    assert.match(out, /Healthcare\s+overweight\s+\+150bp/)
    assert.match(out, /\+9bp so far/)
})

test('an UNPRICED stance says so — never 0bp', () => {
    // Handing the model "0bp" would give it a result the desk does not have, and it would report it.
    const out = formatSectorView(doc({ tilts: [row({ contribution_bp: null })] }))
    assert.match(out, /not yet priced/)
    assert.doesNotMatch(out, /0bp so far/)
})

test('the model is told a stance is RELATIVE — else it reports "healthcare goes up"', () => {
    assert.match(formatSectorView(doc()), /BEATS the benchmark, not that it rises/)
})

test('an unbalanced table is disclosed to the model', () => {
    assert.match(formatSectorView(doc({ balanced: false, net_bp: 400 })), /net to \+400bp/)
})

test('NO published view tells the model to say so, not to invent one', () => {
    const out = formatSectorView(null)
    assert.match(out, /No house sector view has been published/)
    assert.match(out, /do not substitute your own read/)
    assert.match(out, /Pythia is the desk that sets it/)
})

test('the handler is UNBOUND — Axl mounts it with no userId at all', async () => {
    const handlers = makeSectorViewHandlers({ current: async () => doc() })
    assert.match(String(await handlers.get_sector_view({})), /HOUSE SECTOR VIEW/)

    // The structural guarantee, checked where it actually lives: the mount site passes nothing.
    // A handler that cannot see a user cannot leak one into a broadcast — the same reason the
    // market brief is mounted the same way, on the line above it.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../services/agents/axl.agent.service.js'), 'utf-8')
    assert.match(src, /\.\.\._sectorViewHandlers\(\),/, 'must be mounted UNBOUND, like _marketBriefHandlers()')
})

test('a failed read becomes a toolError the model can act on, never a throw into the turn', async () => {
    const handlers = makeSectorViewHandlers({ current: async () => { throw new Error('mongo down') } })
    const out = await handlers.get_sector_view({})
    assert.ok(isToolError(out))
    assert.match(toolErrorText(out), /Could not read the house sector view/)
})

test('Axl carries the read tool and does NOT carry Pythia authoring tools', () => {
    const names = AXL_TOOLS.map(t => t.name)
    assert.ok(names.includes('get_sector_view'))
    assert.ok(names.includes('get_market_brief'), 'the brief stays — "read the market" is answered here')
    // Axl is read-only: the desk's inputs would invite him to form a view of his own.
    for (const t of ['get_priced_in', 'get_coverage_by_sector', 'get_sector_snapshot']) {
        assert.ok(!names.includes(t), `${t} belongs to Pythia`)
    }
})

test('the tool description separates SHOWING a view from AUTHORING one', () => {
    const d = SECTOR_VIEW_TOOL_SPEC.get_sector_view
    assert.match(d, /READ-ONLY/)
    assert.match(d, /NEW or CHANGED view, that is Pythia/)
    assert.match(d, /knows NOTHING about this user/)
})

// ── the prompt line that keeps "read the market" out of the desk ─────────────
// The prompt is hard-wrapped prose, so asserting a phrase that happens to straddle a line break
// fails for a reason that has nothing to do with the rule. Collapse whitespace first and assert on
// the sentence, not on its typography.
const promptText = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../axl_system_prompt.md'), 'utf-8')
    .replace(/\s+/g, ' ')

test('Axl is told the BRIEF and the VIEW are different, in both directions', () => {
    const prompt = promptText()

    // The collision that motivated this: "read the market" sounds like a strategy desk and is not.
    assert.match(prompt, /"Read the market".*the BRIEF/, 'read-the-market must be answered by the brief')
    assert.match(prompt, /"Read the market" is this/, 'the brief section claims the phrase explicitly')

    // Showing a view is Axl's; authoring one is a route.
    assert.match(prompt, /get_sector_view/)
    assert.match(prompt, /<route>strategy<\/route>/)
    assert.match(prompt, /The report IS the whole answer/)

    // And with no view published he must not invent one — the answer that would be mistaken for the
    // house's.
    assert.match(prompt, /[Dd]o NOT fill the gap with your own read of the sectors/)
})

test('SHOWING the view is terminal — the prompt forbids routing off a read turn', () => {
    // The regression: Axl showed the forecast and then routed to Pythia anyway. Two general
    // instructions pull that way ("report the facts, then route", and taking the user in the same
    // turn), so the exception has to be stated outright rather than implied by a soft clause.
    const prompt = promptText()
    assert.match(prompt, /Showing the view NEVER routes/)
    assert.match(prompt, /Do not append `<route>strategy<\/route>` to a turn that just reported it/)
    // ...and the route list itself repeats the condition, because that is the other place the model looks.
    assert.match(prompt, /Only on an ask to CHANGE it — showing the current view is yours and ends the turn/)
})

test('Axl KNOWS Pythia exists — an agent missing from the roster is one he cannot describe', () => {
    const prompt = promptText()
    assert.match(prompt, /\*\*Pythia\*\*/)
    assert.match(prompt, /six specialist agents/, 'the count must track the roster it introduces')
})

test('the strategy route is registered as a desk key the hub can resolve', () => {
    // `<route>strategy</route>` only works if a DESK with that key exists on the client. The FE
    // registry is the other half; this pins our side of the contract.
    const prompt = promptText()
    const routes = [...prompt.matchAll(/<route>([a-z]+)<\/route>/g)].map(m => m[1])
    assert.ok(routes.includes('strategy'))
    for (const k of ['trade', 'portfolio', 'scan', 'research', 'assist']) assert.ok(routes.includes(k), `${k} route lost`)
})
