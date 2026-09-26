import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENTRY_ARCHETYPES, STOP_ANCHORS, TARGET_ANCHORS, SIBLINGS, siblingOf, normalizeTaxon } from '../../services/setup.taxonomy.js'

// The taxonomy is a CLOSED SET whose whole value is that it can be checked (Phase 0 of
// docs/design/mentor-challenge.md). These tests guard the two ways a closed set stops being one:
// an id spelled two ways, and a member added without deciding what it implies.

// ─── The vocabularies ─────────────────────────────────────────────────────────

for (const [name, list] of [['ENTRY_ARCHETYPES', ENTRY_ARCHETYPES], ['STOP_ANCHORS', STOP_ANCHORS], ['TARGET_ANCHORS', TARGET_ANCHORS]]) {
    test(`${name} is a set of unique snake_case ids`, () => {
        assert.ok(Array.isArray(list) && list.length > 0)
        assert.equal(new Set(list).size, list.length, 'a duplicated id is one the schema would accept twice')
        for (const id of list) assert.match(id, /^[a-z][a-z_]*[a-z]$/, `${id} must be lower snake_case`)
    })
}

test('the sets are the sizes the design settled on — growth is a decision, not a drift', () => {
    // Eight / five / five. Not arbitrary: a ninth archetype has to earn its place by having its own
    // invalidation (two ways in that share a stop are one way in), and every id added here owes a
    // prose mirror in the Mentor prompt and a sibling decision below.
    assert.equal(ENTRY_ARCHETYPES.length, 8)
    assert.equal(STOP_ANCHORS.length, 5)
    assert.equal(TARGET_ANCHORS.length, 5)
})

// ─── Siblings ─────────────────────────────────────────────────────────────────

test('SIBLINGS decides every archetype and invents none', () => {
    // The failure this prevents: a ninth archetype lands, nobody decides its continuation, and the
    // runaway redraw silently treats it as "no sibling" — which is a real answer for three of the
    // eight and therefore indistinguishable from an oversight.
    assert.deepEqual(Object.keys(SIBLINGS).sort(), [...ENTRY_ARCHETYPES].sort())
})

test('every sibling is itself a way in', () => {
    for (const [from, to] of Object.entries(SIBLINGS)) {
        if (to === null) continue
        assert.ok(ENTRY_ARCHETYPES.includes(to), `${from} → ${to} is not an archetype`)
        assert.notEqual(to, from, 'an archetype cannot be its own continuation')
    }
})

test('a sibling chain is one hop — you do not chase a chase', () => {
    // The design's recursion rule (§3): one continuation per thesis. If the sibling of a sibling
    // were ever non-null, the redraw conversation could ladder forever off one missed entry.
    for (const id of ENTRY_ARCHETYPES) {
        const next = siblingOf(id)
        if (next) assert.equal(siblingOf(next), null, `${id} → ${next} → ${siblingOf(next)} is a second hop`)
    }
})

test('the momentum archetypes have no continuation, and that is authored not accidental', () => {
    assert.equal(siblingOf('breakout'), null)
    assert.equal(siblingOf('retest'), null)
    assert.equal(siblingOf('event_gated'), null)
    // A fade that runs away is evidence for the OTHER direction — a new plan, not this one's
    // sibling. Offering one would walk the user into a reversal wearing the missed trade's label.
    assert.equal(siblingOf('fade'), null)
})

test('the three that do have one point where the design says', () => {
    assert.equal(siblingOf('pullback'), 'retest')
    assert.equal(siblingOf('sweep_reclaim'), 'retest')
    assert.equal(siblingOf('gap_fill'), 'momentum_continuation')
})

test('siblingOf is tolerant of what a half-built plan actually holds', () => {
    // The caller is a conversation, and a setup filed before this taxonomy existed has no
    // archetype at all. None of these may throw.
    for (const junk of [null, undefined, '', '   ', 42, {}, [], 'no_such_archetype']) {
        assert.equal(siblingOf(junk), null)
    }
    assert.equal(siblingOf('  PULLBACK '), 'retest', 'trim and case are spelling, not meaning')
})

// ─── normalizeTaxon — the one matcher all three fields go through ─────────────

test('normalizeTaxon accepts a member, in any spelling, and nothing else', () => {
    // ONE function rather than three near-identical normalisers: the tolerance is the mechanism, and
    // it must not differ between the archetype and the two anchor fields (CLAUDE.md).
    for (const list of [ENTRY_ARCHETYPES, STOP_ANCHORS, TARGET_ANCHORS]) {
        for (const id of list) {
            assert.equal(normalizeTaxon(list, id), id)
            assert.equal(normalizeTaxon(list, ` ${id.toUpperCase()} `), id)
        }
    }
    // Cross-vocabulary is the failure that matters: a target's anchor on a stop leg is not a
    // spelling mistake, it is a claim about the price that cannot be true.
    assert.equal(normalizeTaxon(STOP_ANCHORS, 'measured_move'), null)
    assert.equal(normalizeTaxon(TARGET_ANCHORS, 'volatility'), null)
    assert.equal(normalizeTaxon(ENTRY_ARCHETYPES, 'structure'), null)
})

test('normalizeTaxon degrades to null instead of throwing, for anything', () => {
    // It runs on every streamed turn over a half-built worksheet. Nothing here may cost the user
    // the draft — the house rule for every field the model authors.
    for (const bad of [null, undefined, '', '  ', 42, {}, [], 'no_such_id', 'toString']) {
        assert.equal(normalizeTaxon(ENTRY_ARCHETYPES, bad), null, String(bad))
    }
    for (const list of [null, undefined, 'pullback', 42, {}]) {
        assert.equal(normalizeTaxon(list, 'pullback'), null, String(list))
    }
})

test('siblingOf does not answer for inherited object keys', () => {
    // `SIBLINGS['toString']` is a function, and a naive lookup would hand the redraw a sibling that
    // is not an archetype at all.
    assert.equal(siblingOf('toString'), null)
    assert.equal(siblingOf('constructor'), null)
})
