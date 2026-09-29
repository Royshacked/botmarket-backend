import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    STAGES, emptyBuild, emptyName, upsertName, activeName, claim, settle, stageOf, isWaived,
    normalizeBuild, sanitizeBuildOps, applyBuildOps, settledConflicts,
} from '../../services/mentorBuild.util.js'

// Phase 2 of the ledger: the turn. Everything here is about state that has been OUT of the process
// — through the client and back on the draft, or through the model as a <build> tag — so every test
// is really "what happens when the thing that came back is not what we sent".

const VALUES = {
    direction: 'long', horizon: 'swing', lens: 'smc',
    spans: ['s1'], entries: ['s1:0'], size: 100, summary: { rr: 2.5 },
}

/** Settle a name up to and including `through`. */
function advance(name, through) {
    for (const stage of STAGES) {
        name = claim(name, Object.fromEntries(stage.fields.map(f => [f, VALUES[f]])), 'mentor').name
        name = settle(name, stage.fields).name
        if (stage.key === through) break
    }
    return name
}

// ─── Back through the client ──────────────────────────────────────────────────

test('a ledger coming back from the client keeps what it recognises and drops the rest', () => {
    const b = normalizeBuild({
        names: [{
            asset: 'nvda',
            claimed: { lens: { value: 'smc', source: 'user' }, nonsense: { value: 1 } },
            settled: { direction: 'long', conviction: 'high' },
        }],
        active: 'NVDA',
        waiver: 'yes',
        refused: [{ field: 'size', reason: 'too early' }],
    })
    assert.deepEqual(Object.keys(b.names[0].claimed), ['lens'])
    assert.deepEqual(Object.keys(b.names[0].settled), ['direction'])
    assert.equal(b.waiver, true)
    assert.deepEqual(b.refused, [{ field: 'size', reason: 'too early' }])
})

test('an unknown claim source becomes Mentor\'s own, never the user\'s', () => {
    const b = normalizeBuild({ names: [{ asset: 'NVDA', claimed: { lens: { value: 'smc', source: 'the chart' } } }] })
    assert.equal(b.names[0].claimed.lens.source, 'mentor')
})

test('an active name the ledger does not hold falls back to the first one', () => {
    const b = normalizeBuild({ names: [{ asset: 'NVDA' }, { asset: 'AMD' }], active: 'TSLA' })
    assert.equal(b.active, 'NVDA')
})

test('garbage normalises to an empty build rather than throwing', () => {
    assert.deepEqual(normalizeBuild(null), emptyBuild())
    assert.deepEqual(normalizeBuild('nope'), emptyBuild())
    assert.deepEqual(normalizeBuild({ names: 'lots' }).names, [])
})

// ─── The model's ops ──────────────────────────────────────────────────────────

test('ops are dropped by TYPE, never coerced — a sentence is not a settlement', () => {
    assert.equal(sanitizeBuildOps({ settle: 'I think we are agreed' }), null)
    assert.deepEqual(sanitizeBuildOps({ settle: 'direction' }).settle, ['direction'])
    assert.deepEqual(sanitizeBuildOps({ settle: ['direction', 'vibes'] }).settle, ['direction'])
    assert.equal(sanitizeBuildOps({ unsettle: 'rung 4' }), null)
    assert.equal(sanitizeBuildOps({ waiver: 'yes' }), null)
    assert.equal(sanitizeBuildOps({ claim: { vibes: 'good' } }), null)
    assert.equal(sanitizeBuildOps('go all the way'), null)
})

test('a source the model invented is ignored; a real one survives', () => {
    assert.equal('source' in sanitizeBuildOps({ claim: { lens: 'smc' }, source: 'the chart' }), false)
    assert.equal(sanitizeBuildOps({ claim: { lens: 'smc' }, source: 'user' }).source, 'user')
})

// ─── One turn's moves ─────────────────────────────────────────────────────────

test('the worksheet alone records CLAIMS — proposing is not agreeing', () => {
    const { build } = applyBuildOps(emptyBuild(), {
        asset: 'NVDA',
        derived: { direction: 'long', horizon: 'swing', lens: 'smc' },
    })
    const n = activeName(build)
    assert.equal(stageOf(n), 'opening')
    assert.equal(n.claimed.direction.source, 'mentor')
    assert.deepEqual(n.settled, {})
})

test('an explicit claim beats the one derived from the worksheet', () => {
    const { build } = applyBuildOps(emptyBuild(), {
        asset: 'NVDA',
        derived: { lens: 'discretionary' },
        claim: { lens: 'smc' },
        source: 'user',
    })
    assert.equal(activeName(build).claimed.lens.value, 'smc')
    assert.equal(activeName(build).claimed.lens.source, 'user')
})

test('reopen, re-claim and confirm are ONE turn, applied in that order', () => {
    let { build } = applyBuildOps(upsertName(emptyBuild(), 'NVDA'), {
        derived: { direction: 'long', horizon: 'swing', lens: 'smc' },
        settle: ['direction', 'horizon', 'lens'],
    })
    assert.equal(activeName(build).settled.direction, 'long')

    // The user flips it. Without the reopen landing FIRST, the claim collides with the settled
    // value, is dropped, and the confirmation then has nothing to settle.
    const flipped = applyBuildOps(build, {
        unsettle: 'opening',
        claim: { direction: 'short', horizon: 'swing', lens: 'smc' },
        source: 'user',
        settle: ['direction', 'horizon', 'lens'],
    })
    assert.equal(activeName(flipped.build).settled.direction, 'short')
    assert.deepEqual(flipped.refused, [])
})

test('a refusal is stored on the build, so the next turn hears about it', () => {
    const { build, refused } = applyBuildOps(upsertName(emptyBuild(), 'NVDA'), {
        claim: { size: 100 },
        settle: ['size'],
    })
    assert.deepEqual(refused.map(r => r.field), ['size'])
    assert.deepEqual(build.refused.map(r => r.field), ['size'])
    assert.equal(activeName(build).settled.size, undefined)
})

test('ops with no name at all change nothing', () => {
    const { build, refused } = applyBuildOps(emptyBuild(), { settle: ['direction'] })
    assert.deepEqual(build.names, [])
    assert.deepEqual(refused, [])
})

test('the waiver is recorded from the same turn as everything else', () => {
    const { build } = applyBuildOps(emptyBuild(), { asset: 'NVDA', waiver: true })
    assert.equal(isWaived(build, 'spans'), true)
})

// ─── Ledger vs worksheet ──────────────────────────────────────────────────────

test('a worksheet contradicting a settled value is a conflict, and the settled value wins', () => {
    const name = advance(emptyName('NVDA'), 'opening')
    const conflicts = settledConflicts({ direction: 'short', type: 'swing', trade_mode: 'smc' }, name)
    assert.deepEqual(conflicts.map(c => c.key), ['direction'])
    assert.equal(conflicts[0].settled, 'long')
    assert.match(conflicts[0].reason, /restored/)
})

test('a worksheet that agrees, or leaves a field out, is no conflict', () => {
    const name = advance(emptyName('NVDA'), 'opening')
    assert.deepEqual(settledConflicts({ direction: 'long', type: 'swing', trade_mode: 'smc' }, name), [])
    assert.deepEqual(settledConflicts({ direction: null }, name), [])
    assert.deepEqual(settledConflicts(null, name), [])
})

test('nothing settled means nothing to contradict', () => {
    const name = claim(emptyName('NVDA'), { direction: 'long' }, 'mentor').name
    assert.deepEqual(settledConflicts({ direction: 'short' }, name), [])
})
