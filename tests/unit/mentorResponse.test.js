import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _mentorResponse, mentorNextState } from '../../services/desks/mentor.desk.js'
import { _parseMentorResponse, _parseScenarioOffer } from '../../services/agents/mentor.agent.service.js'

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
    const out = _mentorResponse(FULL)
    for (const key of ['reply', 'coverage', 'build', 'gate', 'drafts', 'setup', 'readiness']) {
        assert.ok(key in out, `${key} was dropped on the way to the client`)
    }
    assert.deepEqual(out.gate, FULL.gate)
    assert.deepEqual(out.drafts, FULL.drafts)
})

test('the gate is what the panel draws its cards from, so its shape travels whole', () => {
    const { gate } = _mentorResponse(FULL)
    assert.equal(gate.stage, 'spans')
    assert.equal(gate.awaiting, true)
    assert.deepEqual(gate.fields, ['spans'])
})

test('the optional halves stay optional — a bare turn sends no empty shells', () => {
    const out = _mentorResponse({ reply: 'hi', coverage: [], build: { names: [] } })
    assert.equal('gate' in out, false)
    assert.equal('drafts' in out, false)
    assert.equal('setup' in out, false)
    assert.equal('readiness' in out, false)
    assert.equal(out.reply, 'hi')
})

test('readiness rides WITH the setup — a verdict about a draft nobody was sent is noise', () => {
    const out = _mentorResponse({ reply: 'x', coverage: [], readiness: { ready: true } })
    assert.equal('readiness' in out, false)
})

// Roy, 2026-11-07: the choice between scenarios reached the pane only after he had answered.
test('a scenario offer: in the response, stripped from the reply, on the view for the turn that asks and gone the next', () => {
    const OFFER = { options: [{ id: 'A', label: 'pullback', arm: null, stop: 49.66, target: 60.15 }, { id: 'B', label: 'break', arm: 55.45, stop: 52.46, target: 58.47 }] }
    const raw = `A, B or both?\n<scenario_offer>${JSON.stringify({ options: OFFER.options })}</scenario_offer>`
    const parsed = _parseMentorResponse(raw)
    assert.deepEqual(parsed.scenarioOffer, OFFER)
    assert.equal(parsed.reply.includes('scenario_offer'), false)
    assert.equal(parsed.reply.includes('49.66'), false)

    assert.deepEqual(_mentorResponse({ reply: 'x', coverage: [], scenarioOffer: OFFER }).scenarioOffer, OFFER)
    assert.equal('scenarioOffer' in _mentorResponse({ reply: 'x', coverage: [] }), false)

    const asked = mentorNextState({}, { scenarioOffer: OFFER }, {})
    assert.deepEqual(asked.view.offer, OFFER)
    assert.equal(mentorNextState(asked, {}, {}).view.offer, null, 'the answer\'s turn clears it')
})

test('a scenario offer without what makes it one is dropped', () => {
    const offer = (options) => _parseScenarioOffer(`<scenario_offer>${JSON.stringify({ options })}</scenario_offer>`)
    assert.equal(offer([]), null)
    assert.equal(offer([{ id: 'A' }]), null, 'no stop')
    assert.equal(offer([{ stop: 50 }]), null, 'no id')
    assert.equal(offer([{ id: 'A', stop: 0 }]), null, 'a stop of 0 is no stop')
    assert.deepEqual(offer([{ id: 'A', stop: '50' }, { id: 'B' }]), { options: [{ id: 'A', label: '', arm: null, stop: 50, target: null }] })
    assert.equal(_parseScenarioOffer('no tag'), null)
    assert.equal(_parseScenarioOffer('<scenario_offer>not json</scenario_offer>'), null)
})

test('a candidate offer travels; the route is left to the shared desk stream', () => {
    const out = _mentorResponse({
        reply: 'options', coverage: [], setups: { candidates: [{ label: 'one' }] },
        route: 'scan', routeSymbol: 'NVDA',
    })
    assert.deepEqual(out.setups.candidates, [{ label: 'one' }])
    // makeDeskStream appends the routing fields, validated for the user's role (deskStream.test.js).
    // Mentor building them too is how one desk's copy drifts from the gate.
    assert.equal('route' in out, false)
})
