import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    STAGES, STAGE_KEYS, BUILD_FIELDS,
    emptyBuild, emptyName, nameFor, upsertName, activeName, putName, setWaiver,
    claim, claimOf, canSettle, settle, unsettle,
    isSettled, stageOf, firstUnsettled, isWaived, buildComplete, claimsFromDraft,
} from '../../services/mentorBuild.util.js'

// The build ledger's whole job is to be strict about ORDER and silent about TOPIC. So these tests
// are mostly "what does it refuse, and does the refusal say something the next turn can act on".

/** Settle a name up to and including `through`, claiming plausible values on the way. */
function advance(name, through) {
    const VALUES = {
        direction: 'long', horizon: 'swing', lens: 'smc',
        spans: ['s1'], entries: ['s1:0'], size: 100, summary: { rr: 2.5 },
    }
    for (const stage of STAGES) {
        const fields = stage.fields
        name = claim(name, Object.fromEntries(fields.map(f => [f, VALUES[f]])), 'mentor').name
        name = settle(name, fields).name
        if (stage.key === through) break
    }
    return name
}

// ─── Shape ────────────────────────────────────────────────────────────────────

test('the stages are the flow, in order, and only the two gates are waivable', () => {
    assert.deepEqual(STAGE_KEYS, ['opening', 'spans', 'entries', 'sizing', 'summary'])
    assert.deepEqual(STAGES.filter(s => s.waivable).map(s => s.key), ['spans', 'entries'])
    assert.deepEqual(BUILD_FIELDS, ['direction', 'horizon', 'lens', 'spans', 'entries', 'size', 'summary'])
})

test('a fresh name is at the opening stage with all three fields blank', () => {
    const n = emptyName('nvda')
    assert.equal(n.asset, 'NVDA')
    assert.equal(stageOf(n), 'opening')
    assert.deepEqual(firstUnsettled(n), { stage: 'opening', fields: ['direction', 'horizon', 'lens'] })
})

// ─── Claiming ─────────────────────────────────────────────────────────────────

test('claims are free and carry their source — the user, Argus and Mentor are told apart', () => {
    let n = emptyName('NVDA')
    n = claim(n, { direction: 'long' }, 'user').name
    n = claim(n, { lens: 'smc' }, 'argus').name
    n = claim(n, { horizon: 'swing' }).name
    assert.equal(claimOf(n, 'direction').source, 'user')
    assert.equal(claimOf(n, 'lens').source, 'argus')
    assert.equal(claimOf(n, 'horizon').source, 'mentor')
    // Claiming commits nothing: the ledger has not moved.
    assert.equal(stageOf(n), 'opening')
    assert.equal(isSettled(n, 'direction'), false)
})

test('a claim out of stage order is still accepted — only settlement is ordered', () => {
    const { name, dropped } = claim(emptyName('NVDA'), { size: 100 }, 'user')
    assert.deepEqual(dropped, [])
    assert.equal(claimOf(name, 'size').value, 100)
})

test('an unknown field is dropped, not recorded', () => {
    const { name, dropped } = claim(emptyName('NVDA'), { conviction: 'high' })
    assert.deepEqual(dropped, ['conviction'])
    assert.deepEqual(name.claimed, {})
})

test('a claim cannot overwrite a settled field — that has to go through unsettle', () => {
    let n = advance(emptyName('NVDA'), 'opening')
    const { name, dropped } = claim(n, { direction: 'short' }, 'user')
    assert.deepEqual(dropped, ['direction'])
    assert.equal(name.settled.direction, 'long')
})

// ─── Settling ─────────────────────────────────────────────────────────────────

test('settling takes the value from the CLAIM, so an overrule is always visible', () => {
    let n = claim(emptyName('NVDA'), { direction: 'long' }, 'user').name
    n = settle(n, ['direction']).name
    assert.equal(n.settled.direction, 'long')
})

test('nothing can be settled before the stages above it', () => {
    const n = claim(emptyName('NVDA'), { size: 100 }, 'user').name
    const verdict = canSettle(n, 'size')
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /opening must be settled before size/)
})

test('a field with no claim cannot be settled — there is nothing to confirm', () => {
    const { refused } = settle(emptyName('NVDA'), ['direction'])
    assert.equal(refused.length, 1)
    assert.match(refused[0].reason, /nothing claimed/)
})

test('re-settling the same value is a silent no-op — the model re-emits every turn', () => {
    let n = advance(emptyName('NVDA'), 'opening')
    const again = settle(n, ['direction', 'horizon', 'lens'])
    assert.deepEqual(again.refused, [])
    assert.deepEqual(again.accepted, [])
    assert.deepEqual(again.name.settled, n.settled)
})

test('settling a DIFFERENT value over a settled field is refused, and the refusal names the cure', () => {
    let n = advance(emptyName('NVDA'), 'opening')
    // The claim itself is dropped, so the refusal comes from there — either way nothing changes.
    n = { ...n, claimed: { ...n.claimed, direction: { value: 'short', source: 'user' } } }
    const verdict = canSettle(n, 'direction')
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /unsettle opening/)
})

test('a partial settle accepts what it can and reports what it cannot', () => {
    let n = claim(emptyName('NVDA'), { direction: 'long' }, 'user').name
    const { name, accepted, refused } = settle(n, ['direction', 'lens'])
    assert.deepEqual(accepted, ['direction'])
    assert.deepEqual(refused.map(r => r.field), ['lens'])
    assert.equal(stageOf(name), 'opening')
    assert.deepEqual(firstUnsettled(name).fields, ['horizon', 'lens'])
})

// ─── The cascade ──────────────────────────────────────────────────────────────

test('unsettling a stage clears everything BELOW it too — a flipped direction voids the entries', () => {
    let n = advance(emptyName('NVDA'), 'sizing')
    assert.equal(stageOf(n), 'summary')

    const { name, cleared } = unsettle(n, 'opening')
    assert.deepEqual(cleared.sort(), ['direction', 'entries', 'horizon', 'lens', 'size', 'spans'].sort())
    assert.equal(stageOf(name), 'opening')
    // The claims below go with it: a span proposed for a long is not a candidate for a short.
    assert.deepEqual(name.claimed, {})
})

test('unsettling a middle stage leaves the stages above it alone', () => {
    let n = advance(emptyName('NVDA'), 'entries')
    const { name, cleared } = unsettle(n, 'entries')
    assert.deepEqual(cleared, ['entries'])
    assert.equal(name.settled.direction, 'long')
    assert.equal(name.settled.spans.length, 1)
    assert.equal(stageOf(name), 'entries')
})

test('unsettling an unknown stage is a no-op, not a wipe', () => {
    const n = advance(emptyName('NVDA'), 'opening')
    const { name, cleared } = unsettle(n, 'nonsense')
    assert.deepEqual(cleared, [])
    assert.deepEqual(name.settled, n.settled)
})

// ─── Waiver ───────────────────────────────────────────────────────────────────

test('the waiver reaches the two gates and nothing else', () => {
    const build = setWaiver(emptyBuild(), true)
    assert.equal(isWaived(build, 'spans'), true)
    assert.equal(isWaived(build, 'entries'), true)
    assert.equal(isWaived(build, 'opening'), false)
    assert.equal(isWaived(build, 'sizing'), false)
    assert.equal(isWaived(build, 'summary'), false)
})

test('no waiver means no stage is waived', () => {
    const build = emptyBuild()
    assert.equal(isWaived(build, 'spans'), false)
})

// ─── Several names ────────────────────────────────────────────────────────────

test('names are added once and the newest is active', () => {
    let b = upsertName(emptyBuild(), 'nvda')
    b = upsertName(b, 'AMD')
    b = upsertName(b, 'NVDA')
    assert.deepEqual(b.names.map(n => n.asset), ['NVDA', 'AMD'])
    assert.equal(activeName(b).asset, 'NVDA')
    assert.equal(nameFor(b, 'amd').asset, 'AMD')
})

test('an empty ticker adds nothing', () => {
    const b = upsertName(emptyBuild(), '   ')
    assert.deepEqual(b.names, [])
})

test('the build is complete only when every name is', () => {
    let b = upsertName(upsertName(emptyBuild(), 'NVDA'), 'AMD')
    assert.equal(buildComplete(b), false)
    b = putName(b, advance(nameFor(b, 'NVDA'), 'summary'))
    assert.equal(buildComplete(b), false)
    b = putName(b, advance(nameFor(b, 'AMD'), 'summary'))
    assert.equal(buildComplete(b), true)
})

test('an empty build is not a complete one', () => {
    assert.equal(buildComplete(emptyBuild()), false)
})

// ─── The brought plan ─────────────────────────────────────────────────────────

test('a brought draft becomes CLAIMS, not settlements — it is still validated', () => {
    const draft = {
        asset: 'NVDA', direction: 'long', type: 'swing', trade_mode: 'smc',
        scenarios: [{ id: 's1', quantity: 100, entry_legs: [{ price: 238.2 }, { price: 236 }] }],
    }
    const claims = claimsFromDraft(draft)
    assert.deepEqual(claims, {
        direction: 'long', horizon: 'swing', lens: 'smc',
        spans: ['s1'], entries: ['s1:0', 's1:1'], size: 100,
    })

    const n = claim(emptyName('NVDA'), claims, 'user').name
    assert.equal(stageOf(n), 'opening')   // claimed, not settled
    assert.equal(claimOf(n, 'size').source, 'user')
})

test('a draft with nothing in it claims nothing', () => {
    assert.deepEqual(claimsFromDraft(null), {})
    assert.deepEqual(claimsFromDraft({ scenarios: [] }), {})
})

// ─── Malformed input ──────────────────────────────────────────────────────────

test('claiming onto a half-built name refuses rather than throws', () => {
    const { name, dropped } = claim({ asset: 'NVDA' }, { direction: 'long' }, 'user')
    assert.deepEqual(dropped, [])
    assert.equal(claimOf(name, 'direction').value, 'long')
})

test('a name the build never heard of is APPENDED, not silently dropped', () => {
    const b = putName(upsertName(emptyBuild(), 'NVDA'), advance(emptyName('AMD'), 'opening'))
    assert.deepEqual(b.names.map(n => n.asset), ['NVDA', 'AMD'])
    assert.equal(nameFor(b, 'AMD').settled.direction, 'long')
})

test('a draft whose scenarios disagree on size has not stated one', () => {
    const agree = claimsFromDraft({ scenarios: [{ id: 's1', quantity: 100 }, { id: 's2', quantity: 100 }] })
    assert.equal(agree.size, 100)
    const disagree = claimsFromDraft({ scenarios: [{ id: 's1', quantity: 100 }, { id: 's2', quantity: 60 }] })
    assert.equal('size' in disagree, false)
})
