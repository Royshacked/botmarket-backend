import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _mentorResponse } from '../../api/mentor/mentor.controller.js'

// EVERYTHING THE DESK COMPUTES FOR THE USER HAS TO BE LISTED IN THE RESPONSE BY HAND, and twice
// now something was not. `build` went missing first. Then `gate` — and because the panel had just
// started drawing its gate cards from the stage the server reports, both build gates silently
// vanished from the screen while the server went on computing which one was open.
//
// So the shaping is a pure function with a test around it. A field the desk returns and the panel
// reads has exactly one place to be forgotten, and this is it.

const FULL = {
    reply:     'here you go',
    coverage:  ['markets'],
    build:     { names: [{ asset: 'NVDA' }], active: 'NVDA' },
    gate:      { asset: 'NVDA', stage: 'spans', awaiting: true, fields: ['spans'], values: {} },
    drafts:    { NVDA: { asset: 'NVDA' }, AMD: { asset: 'AMD' } },
    setup:     { asset: 'NVDA' },
    readiness: { ready: false, missing: ['size'] },
}

test('every field the panel needs survives the controller', () => {
    const out = _mentorResponse(FULL, 'user')
    for (const key of ['reply', 'coverage', 'build', 'gate', 'drafts', 'setup', 'readiness']) {
        assert.ok(key in out, `${key} was dropped on the way to the client`)
    }
    assert.deepEqual(out.gate, FULL.gate)
    assert.deepEqual(out.drafts, FULL.drafts)
})

test('the gate is what the panel draws its cards from, so its shape travels whole', () => {
    const { gate } = _mentorResponse(FULL, 'user')
    assert.equal(gate.stage, 'spans')
    assert.equal(gate.awaiting, true)
    assert.deepEqual(gate.fields, ['spans'])
})

test('the optional halves stay optional — a bare turn sends no empty shells', () => {
    const out = _mentorResponse({ reply: 'hi', coverage: [], build: { names: [] } }, 'user')
    assert.equal('gate' in out, false)
    assert.equal('drafts' in out, false)
    assert.equal('setup' in out, false)
    assert.equal('readiness' in out, false)
    assert.equal(out.reply, 'hi')
})

test('readiness rides WITH the setup — a verdict about a draft nobody was sent is noise', () => {
    const out = _mentorResponse({ reply: 'x', coverage: [], readiness: { ready: true } }, 'user')
    assert.equal('readiness' in out, false)
})

test('a candidate offer travels, and so does a route', () => {
    const out = _mentorResponse({
        reply: 'options', coverage: [], setups: { candidates: [{ label: 'one' }] },
        route: 'scan', routeSymbol: 'NVDA',   // the PIPELINE key, not the desk's name
    }, 'user')
    assert.deepEqual(out.setups.candidates, [{ label: 'one' }])
    assert.equal(out.route, 'scan')
    assert.equal(out.routeSymbol, 'NVDA')
})
