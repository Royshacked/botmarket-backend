import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DESKS, AGENT_KEYS, PIPELINE_KEYS, ADMIN_PIPELINE_KEYS, ENTITY_KINDS, agentAtDesk, agentForKind, deskOf, entryOf } from '../../services/desks/registry.js'
import { VALID_PIPELINES, ADMIN_DESKS, ROUTABLE_DESKS, EDIT_KIND_DESKS } from '../../services/routing.util.js'
import { SESSION_AGENTS, CONTEXT_KINDS } from '../../services/session.util.js'

// The one desk registry (services/desks/registry.js). Five hand-kept lists derive from it now; these pin
// that each derived list is EXACTLY what it replaced, so the move changed no route, no gate and no prompt.

test('the pipelines a route may name are the seven it always was', () => {
    assert.deepEqual([...VALID_PIPELINES].sort(), ['aether', 'assist', 'portfolio', 'research', 'scan', 'strategy', 'trade'])
    assert.deepEqual([...PIPELINE_KEYS].sort(), [...VALID_PIPELINES].sort())
})

test('admin-only desks are Pythia and Aether', () => {
    assert.deepEqual([...ADMIN_DESKS], ['strategy', 'aether'])
    assert.deepEqual([...ADMIN_PIPELINE_KEYS], ['strategy', 'aether'])
})

test('the routable desks, IN PROMPT ORDER — research, assist, portfolio, scan', () => {
    // buildRouteRule lists them in this order inside every desk's prompt; a reorder is a prompt change.
    assert.deepEqual(Object.keys(ROUTABLE_DESKS), ['research', 'assist', 'portfolio', 'scan'])
    assert.deepEqual(Object.values(ROUTABLE_DESKS).map(d => d.agent), ['analyst', 'mentor', 'portfolio', 'scanner'])
    for (const d of Object.values(ROUTABLE_DESKS)) assert.ok(d.brand && d.does, d.agent)
})

test('an <edit> reopens the four editable kinds at the desk that owns each', () => {
    assert.deepEqual({ ...EDIT_KIND_DESKS }, { coverage: 'research', setup: 'assist', portfolio: 'portfolio', scan: 'scan' })
})

test('the session store speaks for every agent and seals onto every kind a desk produces', () => {
    assert.deepEqual([...SESSION_AGENTS].sort(), ['aether', 'analyst', 'axl', 'mentor', 'portfolio', 'scanner', 'strategy'])
    assert.deepEqual([...CONTEXT_KINDS].sort(), ['coverage', 'industry_view', 'portfolio', 'scan', 'setup'])
    assert.deepEqual([...SESSION_AGENTS], [...AGENT_KEYS])
    assert.deepEqual([...CONTEXT_KINDS], [...ENTITY_KINDS])
})

test('history depth per desk is what each agent carried before the move', () => {
    const depth = Object.fromEntries(Object.values(DESKS).map(d => [d.agent, d.maxMessages]))
    assert.deepEqual(depth, { axl: 20, analyst: 8, mentor: 8, portfolio: 10, scanner: 10, strategy: 8, aether: 12 })
})

test('the admin desks talk in their own scope; everyone else in the one chat', () => {
    for (const d of Object.values(DESKS)) assert.equal(d.scope, d.admin ? d.agent : 'main', d.agent)
})

test('a route lands on the agent its desk enters at — `trade` enters at Argus, in single-pick mode for Mentor', () => {
    assert.deepEqual(entryOf('trade'), { agent: 'scanner', state: { handoff: true, handoffTo: 'mentor' } })
    assert.deepEqual(entryOf('assist'), { agent: 'mentor', state: null })
    assert.equal(entryOf('nowhere'), null)
    // A fresh copy each time — a caller merging into it must not change the registry.
    entryOf('trade').state.handoff = false
    assert.equal(entryOf('trade').state.handoff, true)
})

test('lookups: agent at a desk, agent for a kind, entry for an agent', () => {
    assert.equal(agentAtDesk('assist'), 'mentor')
    assert.equal(agentAtDesk('trade'), null)          // a composite names no one agent
    assert.equal(agentForKind('coverage'), 'analyst')
    assert.equal(agentForKind('call'), null)          // archived with Kairos
    assert.equal(deskOf('axl').desk, null)
    assert.equal(deskOf('kairos'), null)
})
