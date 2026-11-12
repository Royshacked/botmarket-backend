import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DESKS, AGENT_KEYS, PIPELINE_KEYS, ADMIN_PIPELINE_KEYS, ENTITY_KINDS, agentAtDesk, agentForKind, deskOf, entryOf, handBackOf } from '../../services/desks/registry.js'
import { VALID_PIPELINES, ADMIN_DESKS, ROUTABLE_DESKS, EDIT_KIND_DESKS } from '../../services/routing.util.js'
import { SESSION_AGENTS, CONTEXT_KINDS } from '../../services/session.util.js'

// The one desk registry (services/desks/registry.js). Five hand-kept lists derive from it now; these pin
// that each derived list is EXACTLY what it replaced, so the move changed no route, no gate and no prompt.

test("the pipelines a route may name: the seven it always was, and Proteus's `technicals` (2026-11-12)", () => {
    assert.deepEqual([...VALID_PIPELINES].sort(), ['aether', 'assist', 'portfolio', 'research', 'scan', 'strategy', 'technicals', 'trade'])
    assert.deepEqual([...PIPELINE_KEYS].sort(), [...VALID_PIPELINES].sort())
})

test('admin-only desks are Pythia and Aether', () => {
    assert.deepEqual([...ADMIN_DESKS], ['strategy', 'aether'])
    assert.deepEqual([...ADMIN_PIPELINE_KEYS], ['strategy', 'aether'])
})

test('the routable desks, IN PROMPT ORDER — research, assist, portfolio, scan, technicals (appended)', () => {
    // buildRouteRule lists them in this order inside every desk's prompt; a reorder is a prompt change.
    assert.deepEqual(Object.keys(ROUTABLE_DESKS), ['research', 'assist', 'portfolio', 'scan', 'technicals'])
    assert.deepEqual(Object.values(ROUTABLE_DESKS).map(d => d.agent), ['analyst', 'mentor', 'portfolio', 'scanner', 'proteus'])
    for (const d of Object.values(ROUTABLE_DESKS)) assert.ok(d.brand && d.does, d.agent)
    // Since 2026-11-09 Argus takes the user only from Mentor (his list-building chat is archived); the rest are open.
    assert.deepEqual(Object.fromEntries(Object.entries(ROUTABLE_DESKS).map(([k, d]) => [k, d.routedFrom])),
        { research: null, assist: null, portfolio: null, scan: ['mentor'], technicals: ['axl', 'mentor'] })
})

test('an <edit> reopens the three editable kinds at the desk that owns each — `scan` left with Argus’s lists (2026-11-09)', () => {
    assert.deepEqual({ ...EDIT_KIND_DESKS }, { coverage: 'research', setup: 'assist', portfolio: 'portfolio' })
})

test('the session store speaks for every agent and seals onto every kind a desk produces', () => {
    assert.deepEqual([...SESSION_AGENTS].sort(), ['aether', 'analyst', 'axl', 'mentor', 'portfolio', 'proteus', 'scanner', 'strategy'])
    // `scan` left on 2026-11-09: Argus's single pick rides the chain to Mentor and produces no entity of its own.
    assert.deepEqual([...CONTEXT_KINDS].sort(), ['coverage', 'industry_view', 'portfolio', 'setup'])
    assert.equal(agentForKind('scan'), null)
    assert.deepEqual([...SESSION_AGENTS], [...AGENT_KEYS])
    assert.deepEqual([...CONTEXT_KINDS], [...ENTITY_KINDS])
})

test('history depth per desk is what each agent carried before the move', () => {
    const depth = Object.fromEntries(Object.values(DESKS).map(d => [d.agent, d.maxMessages]))
    assert.deepEqual(depth, { axl: 20, analyst: 8, mentor: 8, portfolio: 10, scanner: 10, strategy: 8, aether: 12, proteus: 10 })
})

test('the admin desks talk in their own scope; everyone else in the one chat', () => {
    for (const d of Object.values(DESKS)) assert.equal(d.scope, d.admin ? d.agent : 'main', d.agent)
})

test('a route lands on the agent its desk enters at — every trade starts at Mentor, `trade` included', () => {
    assert.deepEqual(entryOf('trade'), { agent: 'mentor', state: null })
    assert.deepEqual(entryOf('assist'), { agent: 'mentor', state: null })
    assert.deepEqual(entryOf('scan'), { agent: 'scanner', state: null })
    assert.equal(entryOf('nowhere'), null)
})

test('a hand-back: Mentor sending the user to Argus presets single-pick mode for Mentor; nobody else does', () => {
    assert.deepEqual(handBackOf('mentor', 'scanner'), { handoff: true })
    assert.equal(handBackOf('axl', 'scanner'), null)
    assert.equal(handBackOf('portfolio', 'scanner'), null)
    assert.equal(handBackOf('mentor', 'analyst'), null)
    // A fresh copy each time — a caller merging into it must not change the registry.
    handBackOf('mentor', 'scanner').handoff = false
    assert.equal(handBackOf('mentor', 'scanner').handoff, true)
})

test('lookups: agent at a desk, agent for a kind, entry for an agent', () => {
    assert.equal(agentAtDesk('assist'), 'mentor')
    assert.equal(agentAtDesk('trade'), null)          // a composite names no one agent
    assert.equal(agentForKind('coverage'), 'analyst')
    assert.equal(agentForKind('call'), null)          // deleted 2026-11-10
    assert.equal(deskOf('axl').desk, null)
    assert.equal(deskOf('zeus'), null)
})
