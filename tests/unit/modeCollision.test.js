import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODES, DEFAULT_MODE } from '../../services/analysisModes.js'
import { TRADE_MODES } from '../../services/setup.schema.js'
import { WORKSPACE_MODES, resolveMode } from '../../services/venue.resolve.service.js'

// `mode` MEANS TWO DIFFERENT THINGS DEPENDING ON THE KIND, and only luck keeps them apart.
//
// On an idea and a setup, `mode` is the WORKSPACE — live | paper | manual, which book the trade
// lives in. The deleted `call` kind (2026-11-10) stored the analytical LENS there instead —
// discretionary | smc | institutional — and any future kind that does the same reopens the overload.
//
// resolveMode reads `source.mode` FIRST and returns it when it looks like a workspace. It works
// today only because the two vocabularies happen not to overlap: a lens falls through to the
// `broker` field and resolves correctly. Name a future lens `live` and every entity built through it
// silently changes workspace — a real-money trade reported as paper, or the reverse.
//
// Nothing enforced that. This does. It is the cheap half of the fix; the thorough half is never storing
// a lens in `mode`.

test('a lens can never be mistaken for a workspace', () => {
    const collision = MODES.filter(m => WORKSPACE_MODES.includes(m))
    assert.deepEqual(collision, [],
        `these lens names would be read as a WORKSPACE by resolveMode: ${collision.join(', ')}. ` +
        'Rename the lens, or stop overloading `mode`.')
})

test('the default lens especially — it is the one every unstamped entity gets', () => {
    assert.ok(!WORKSPACE_MODES.includes(DEFAULT_MODE),
        `DEFAULT_MODE '${DEFAULT_MODE}' reads as a workspace; every entity without an explicit lens would move book`)
})

test('and the collision is not theoretical — this is what resolveMode would do', () => {
    // Pin the mechanism, not just the word lists, so the test still means something if resolveMode's
    // precedence is ever rewritten. An entity carrying a lens must resolve on its BROKER.
    for (const lens of MODES) {
        assert.equal(resolveMode({ mode: lens, broker: 'ctrader' }), 'live', lens)
        assert.equal(resolveMode({ mode: lens, broker: 'paper' }), 'paper', lens)
    }
    // Whereas a real workspace value in the same field is taken at its word.
    assert.equal(resolveMode({ mode: 'paper', broker: 'ctrader' }), 'paper')
})

// ── one vocabulary, not two ───────────────────────────────────────────────────

test('the setup kind and the shared vocabulary name the same lenses', () => {
    // analysisModes says outright that it is "the shared vocabulary, not one desk's". setup.schema
    // kept a second copy of the same three words to validate `trade_mode` against, which is the
    // arrangement where one side gains a lens and the other silently rejects it as unknown.
    assert.deepEqual(TRADE_MODES, MODES)
})
