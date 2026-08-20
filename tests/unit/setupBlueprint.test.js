import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toBlueprint, hydrateBlueprint, blueprintProblems, BLUEPRINT_VERSION } from '../../services/setup.blueprint.js'
import { normalizeSetup, setupReadiness } from '../../services/setup.schema.js'

// A blueprint is a trade plan with the person taken out of it. What these guard is the ONE
// invariant everything else hangs off: a plan can travel, a SIZE cannot.

const A_SETUP = {
    asset: 'nvda', direction: 'long', type: 'swing', trade_mode: 'smc', timeframe: '1hr',
    thesis: 'reclaim of the weekly shelf',
    conditions: [{ id: 'c1', text: 'holds above the 4hr VWAP', weight: 'primary', mode: 'measured', persistence: 'live' }],
    scenarios: [{
        id: 's1', name: 'the fade',
        entry_zones: [{ id: 'e1', lower: 178, upper: 180, quantity: 50, note: 'Tuesday shelf' }],
        stop_zones:  [{ id: 's1s', lower: 173, upper: 174, quantity: 50 }],
        tp_zones:    [{ id: 't1', lower: 196, upper: 200, quantity: 50 }],
        conditions:  [{ id: 's1c1', text: 'sweep of the prior low first' }],
    }],
}

const hydrated = (bp) => normalizeSetup(hydrateBlueprint(bp))

// ── The invariant ─────────────────────────────────────────────────────────────

test('a blueprint carries no size, at either end of the trip', () => {
    const bp = toBlueprint(A_SETUP, { at: 1_700_000_000_000 })

    // Out: nothing anywhere in the envelope says how big the trade is.
    assert.equal(JSON.stringify(bp).includes('quantity'), false, 'toBlueprint leaked a quantity')
    assert.equal(bp.scenarios[0].quantity, undefined)

    // In: even a blueprint that WAS handed a size — hand-edited, forged, or written by an older
    // client — cannot pass one through. This is the security half, not a tidy-up.
    const sized = { ...bp, scenarios: [{ ...bp.scenarios[0], quantity: 999, entry_zones: [{ lower: 178, upper: 180, quantity: 999 }] }] }
    const setup = hydrated(sized)
    assert.equal(setup.scenarios[0].quantity, null)
    assert.equal(setup.scenarios[0].entry_zones[0].quantity, null)
})

test('a hydrated blueprint is never ready — it is blocked on quantity and nothing else', () => {
    const setup = hydrated(toBlueprint(A_SETUP, { at: 1 }))
    const { ready, missing, problems } = setupReadiness(setup, true)   // account marked

    assert.equal(ready, false, 'someone else’s plan must not be generatable un-sized')
    assert.deepEqual(missing, ['quantity'], `the ONLY gap should be the size; got: ${missing.join(', ')}`)
    assert.deepEqual(problems, [])

    // …and typing the size is all it takes. If this ever fails, the recipient has been handed work
    // beyond "fill in the quantities", which is the whole promise of the flow.
    setup.scenarios[0].entry_zones[0].quantity = 10
    const done = setupReadiness(normalizeSetup(setup), true)
    assert.equal(done.ready, true, `still not ready after sizing: ${done.missing.join(', ')} / ${done.problems.join(', ')}`)
})

test('the plan itself survives the round trip intact', () => {
    const setup = hydrated(toBlueprint(A_SETUP, { at: 1 }))

    assert.equal(setup.asset, 'NVDA')
    assert.equal(setup.direction, 'long')
    assert.equal(setup.type, 'swing')
    assert.equal(setup.trade_mode, 'smc')
    assert.equal(setup.timeframe, '1hr')
    assert.equal(setup.thesis, 'reclaim of the weekly shelf')
    assert.deepEqual(setup.scenarios[0].entry_zones[0].lower, 178)
    assert.deepEqual(setup.scenarios[0].tp_zones[0].upper, 200)
    assert.equal(setup.scenarios[0].entry_zones[0].note, 'Tuesday shelf', 'the author’s word about a level is not re-derivable')
    assert.equal(setup.conditions[0].text, 'holds above the 4hr VWAP')
    assert.equal(setup.conditions[0].mode, 'measured', 'a condition’s tags change how it is judged and must travel with it')
    assert.equal(setup.scenarios[0].conditions[0].text, 'sweep of the prior low first')
})

test('nothing personal rides along', () => {
    const owned = {
        ...A_SETUP,
        id: 'setup_1', userId: 'u_1', status: 'looking', mode: 'live', broker: 'ctrader',
        broker_symbol: 'US100', basis_offset: 1.5, accounts: [{ id: 'acc_1' }],
        event_risk: [{ date: '2026-09-01', label: 'earnings' }],
        armed_scenario_id: 's1', armed_zone_id: 'e1',
        monitor_state: { scenarios: { s1: { invalidation_status: 'fired' } } },
    }
    const bp = toBlueprint(owned, { at: 1 })
    for (const leaked of ['userId', 'broker', 'broker_symbol', 'basis_offset', 'accounts', 'event_risk', 'monitor_state', 'armed_scenario_id']) {
        assert.equal(leaked in bp, false, `a blueprint must not carry ${leaked}`)
    }
    assert.equal(bp.status, undefined)
    // `mode` is the WORKSPACE on a setup (live | paper | manual), not the lens — see
    // modeCollision.test.js. It binds to an account, so it must not travel either.
    assert.equal(bp.mode, undefined)
})

// ── The blank form is the same door ───────────────────────────────────────────

test('no blueprint at all hydrates to the blank skeleton', () => {
    for (const empty of [null, undefined, {}]) {
        const setup = hydrated(empty)
        assert.ok(setup, 'the express form must open on nothing')
        assert.equal(setup.scenarios.length, 1, 'one empty way in, ready to be filled')
        assert.deepEqual(setup.scenarios[0].entry_zones, [])
        assert.equal(setup.asset, '')
    }
})

test('a blank draft reports every gap, so the form can say what it wants', () => {
    const { missing } = setupReadiness(hydrated(null), false)
    for (const want of ['asset', 'direction', 'horizon', 'entry zone', 'stop zone', 'target price', 'quantity', 'trading account']) {
        assert.ok(missing.includes(want), `the blank form should be asking for ${want}; got: ${missing.join(', ')}`)
    }
})

// ── Saying out loud what the normaliser swallows ──────────────────────────────

test('a level that could not be read is REPORTED, not silently dropped', () => {
    const bp = toBlueprint(A_SETUP, { at: 1 })
    bp.scenarios[0].tp_zones.push({ id: 't2', lower: 'about 210', upper: null })

    const problems = blueprintProblems(bp, hydrated(bp))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /1 target level could not be read as a price/)
})

test('an unknown lens is not quietly relabelled', () => {
    const bp = { ...toBlueprint(A_SETUP, { at: 1 }), trade_mode: 'wyckoff' }
    const problems = blueprintProblems(bp, hydrated(bp))
    assert.match(problems.join(' '), /Unknown lens "wyckoff" .* discretionary/)
})

test('an unknown horizon or timeframe is handed back to the user, not defaulted', () => {
    const bp = { ...toBlueprint(A_SETUP, { at: 1 }), type: 'scalp', timeframe: '3sec' }
    const problems = blueprintProblems(bp, hydrated(bp)).join(' ')
    assert.match(problems, /Unknown horizon "scalp"/)
    assert.match(problems, /Unknown timeframe "3sec"/)
})

test('a blueprint from a newer app refuses rather than guesses', () => {
    const bp = { ...toBlueprint(A_SETUP, { at: 1 }), version: BLUEPRINT_VERSION + 1 }
    const problems = blueprintProblems(bp, hydrated(bp))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /newer version/)
})

test('a clean blueprint reports nothing', () => {
    assert.deepEqual(blueprintProblems(toBlueprint(A_SETUP, { at: 1 }), hydrated(toBlueprint(A_SETUP, { at: 1 }))), [])
    assert.deepEqual(blueprintProblems(null, hydrated(null)), [])
})

// ── Shape edges ───────────────────────────────────────────────────────────────

test('toBlueprint refuses anything that is not a setup', () => {
    for (const junk of [null, undefined, 'NVDA', 42, ['NVDA']]) assert.equal(toBlueprint(junk), null)
})

test('hydrate tolerates junk where a plan should be', () => {
    for (const junk of ['NVDA', 42, ['NVDA'], true]) {
        const setup = hydrated(junk)
        assert.ok(setup, 'a malformed blueprint still opens an empty form rather than a dead panel')
        assert.equal(setup.scenarios.length, 1)
    }
    assert.match(blueprintProblems(['NVDA'], hydrated(['NVDA']))[0], /not a setup blueprint/)
})

test('scenario ids are minted when absent, so zone ids stay document-unique', () => {
    const setup = hydrated({ scenarios: [{ entry_zones: [{ lower: 1, upper: 2 }] }, { entry_zones: [{ lower: 3, upper: 4 }] }] })
    assert.deepEqual(setup.scenarios.map(s => s.id), ['s1', 's2'])
})

test('an inverted band is sorted rather than dropped — the recipient typed nothing wrong', () => {
    const setup = hydrated({ scenarios: [{ entry_zones: [{ lower: 180, upper: 178 }] }] })
    assert.deepEqual(
        [setup.scenarios[0].entry_zones[0].lower, setup.scenarios[0].entry_zones[0].upper],
        [178, 180],
    )
})

test('a single price collapses to an exact level, not a dropped stop', () => {
    const setup = hydrated({ scenarios: [{ stop_zones: [{ price: 173.5 }] }] })
    const z = setup.scenarios[0].stop_zones[0]
    assert.deepEqual([z.lower, z.upper], [173.5, 173.5])
})

test('a dropped way in stops the per-zone report, rather than misreading the one after it', () => {
    // Scenario 0 is junk and is dropped, so survived[0] IS what was sent[1]. Comparing them by
    // position would invent zone losses out of a premise that arrived whole.
    const bp = { scenarios: [null, { entry_zones: [{ lower: 1, upper: 2 }], stop_zones: [{ lower: 0.5, upper: 0.6 }] }] }
    const problems = blueprintProblems(bp, hydrated(bp))

    assert.equal(problems.length, 1)
    assert.match(problems[0], /1 of 2 ways in could not be read/)
})
