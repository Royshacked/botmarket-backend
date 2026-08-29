import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AGENTS } from '../../api/threads/threads.controller.js'
import { isSubstantive } from '../../services/thread.util.js'

// The draft-save whitelist. It PINS a cross-repo contract with no other enforcement: a panel that
// calls threadsService.saveDraft under an agent name missing from here gets a silent 400 on every
// save, and the failure is invisible at both ends — the panel ignores the response, and the desk
// simply never marks, never locks and never resumes.
//
// It has now cost the same bug twice. `mentor` was missing when the Mentor desk shipped. `analyst`
// and `strategy` were missing on 2026-08-11: both declare a desk in the frontend's agentMeta, so the
// Axl hub was asking for a marker and a lock that nothing could ever answer, and what looked like
// working resume on the research desk was React state surviving behind a `display:none` tab.
//
// So this is a pinning test on purpose. Adding a desk means adding its agent HERE and making its
// panel save — neither half fails loudly on its own.

test('every desk agent that drives its own draft persistence is whitelisted', () => {
    for (const agent of ['idea', 'portfolio', 'scanner', 'kairos', 'mentor', 'axl', 'analyst', 'strategy', 'aether'])
        assert.ok(AGENTS.has(agent), `${agent} is missing — its desk would 400 silently on every save`)
})

test('the whitelist is exactly that set — an unknown agent is refused', () => {
    assert.equal(AGENTS.size, 9)
    for (const agent of ['prometheus', 'pythia', 'atlas', 'argus', '', 'ANALYST'])
        assert.equal(AGENTS.has(agent), false, `${agent} should not be accepted`)
})

// The floor the whitelisted agents then have to clear. Analyst and Strategy are PHASED desks
// (Prometheus emits 1–6), so they use the ordinary phase >= 2 rule rather than the blanket exception
// Axl and Mentor need — those two emit no phase at all and would otherwise never persist.
test('the phased desks persist from phase 2, not before', () => {
    for (const agent of ['analyst', 'strategy']) {
        assert.equal(isSubstantive({ agent, phase: 1 }), false)
        assert.equal(isSubstantive({ agent, phase: 2 }), true)
        assert.equal(isSubstantive({ agent, phase: null }), false)
    }
})

test('a saved thesis is substantive whatever phase it claims', () => {
    assert.equal(isSubstantive({ agent: 'analyst', phase: 1, hasArtifact: true }), true)
})
