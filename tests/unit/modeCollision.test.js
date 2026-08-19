import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODES, DEFAULT_MODE } from '../../services/analysisModes.js'
import { TRADE_MODES } from '../../services/setup.schema.js'
import { WORKSPACE_MODES, resolveMode } from '../../services/venue.resolve.service.js'

// `mode` MEANS TWO DIFFERENT THINGS DEPENDING ON THE KIND, and only luck keeps them apart.
//
// On an idea and a setup, `mode` is the WORKSPACE — live | paper | manual, which book the trade
// lives in. On a CALL it is the analytical LENS the trade was built through — discretionary | smc |
// institutional. Kairos is archived, but `call` documents still exist in Mongo and KINDS.CALL is
// still in the vocabulary, so the overload is dormant rather than gone.
//
// resolveMode reads `source.mode` FIRST and returns it when it looks like a workspace. It works
// today only because the two vocabularies happen not to overlap: a call's lens falls through to its
// `broker` field and resolves correctly. Name a future lens `live` and every call built through it
// silently changes workspace — a real-money trade reported as paper, or the reverse.
//
// Nothing enforced that. This does. It is the cheap half of the fix; the thorough half is renaming
// the call's field, which touches stored documents.

test('a lens can never be mistaken for a workspace', () => {
    const collision = MODES.filter(m => WORKSPACE_MODES.includes(m))
    assert.deepEqual(collision, [],
        `these lens names would be read as a WORKSPACE by resolveMode: ${collision.join(', ')}. ` +
        'Rename the lens, or stop overloading `mode` on the call kind.')
})

test('the default lens especially — it is the one every unstamped call gets', () => {
    assert.ok(!WORKSPACE_MODES.includes(DEFAULT_MODE),
        `DEFAULT_MODE '${DEFAULT_MODE}' reads as a workspace; every call without an explicit lens would move book`)
})

test('and the collision is not theoretical — this is what resolveMode would do', () => {
    // Pin the mechanism, not just the word lists, so the test still means something if resolveMode's
    // precedence is ever rewritten. A call carrying a lens must resolve on its BROKER.
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
