import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeExperienceHandlers, EXPERIENCE_TOOL_SPEC } from '../../services/experience.tools.js'
import { setExperienceLevel } from '../../services/experience.service.js'
import { TOOL_SCHEMAS } from '../../services/agentTools.registry.js'
import { isToolError } from '../../services/toolResult.util.js'

// The tool Axl uses to record who it is talking to. It deliberately does NOT re-implement the
// asymmetry — the guard is in the service, and this layer's job is to hand the model a reason it
// can act on when the service says no.

const handler = (deps) => makeExperienceHandlers('u1', deps).set_experience_level

function fakeDb() {
    const docs = []
    return {
        docs,
        collection: () => ({
            findOne: async () => null,
            updateOne: async (q, u, opts) => { if (opts?.upsert) docs.push({ ...u.$set }); return {} },
        }),
    }
}

test('an inferred beginner is recorded', async () => {
    const db = fakeDb()
    const out = await handler({ set: (u, l, s) => setExperienceLevel(u, l, s, { db }) })({ level: 'beginner', source: 'inferred' })
    assert.equal(out.saved, true)
    assert.equal(out.level, 'beginner')
})

test('the tool cannot launder an inference past the service guard', async () => {
    // The handler has no guard of its own ON PURPOSE — a guard here is one a future caller could
    // route around. The refusal must come from the service and still reach the model.
    const db = fakeDb()
    const out = await handler({ set: (u, l, s) => setExperienceLevel(u, l, s, { db }) })({ level: 'experienced', source: 'inferred' })
    assert.equal(out.saved, false)
    assert.match(out.reason, /only "beginner" may be inferred/)
    assert.equal(db.docs.length, 0)
})

test('a refusal is NOT a tool error — the model should ask, not apologise', async () => {
    const db = fakeDb()
    const out = await handler({ set: (u, l, s) => setExperienceLevel(u, l, s, { db }) })({ level: 'experienced', source: 'inferred' })
    assert.ok(!isToolError(out))
})

test('a declared experienced goes through', async () => {
    const db = fakeDb()
    const out = await handler({ set: (u, l, s) => setExperienceLevel(u, l, s, { db }) })({ level: 'experienced', source: 'declared' })
    assert.equal(out.saved, true)
})

test('"unset" clears the level rather than storing the string', async () => {
    let seen
    const out = await handler({ set: async (_u, l) => { seen = l; return { ok: true, level: l } } })({ level: 'unset', source: 'declared' })
    assert.equal(seen, null)
    assert.equal(out.saved, true)
})

test('recording an inferred beginner reminds the model to TELL the user', async () => {
    // The entire justification for inferring instead of waiting to be told. If this stops coming
    // back, the app starts forming a private view of someone with no way for them to see it.
    const out = await handler({ set: async () => ({ ok: true, level: 'beginner' }) })({ level: 'beginner', source: 'inferred' })
    assert.match(out.remember, /Tell the user/)
    assert.match(out.remember, /ask you to stop any time/)
})

test('a DECLARED level needs no announcement — they just said it', async () => {
    const out = await handler({ set: async () => ({ ok: true, level: 'beginner' }) })({ level: 'beginner', source: 'declared' })
    assert.equal(out.remember, null)
})

test('a thrown write becomes a toolError', async () => {
    const out = await handler({ set: async () => { throw new Error('mongo down') } })({ level: 'beginner', source: 'inferred' })
    assert.ok(isToolError(out))
})

// ─── the schema and description the model reads ───────────────────────────────

test('the schema offers exactly the three levels and two sources', () => {
    const s = TOOL_SCHEMAS.set_experience_level
    assert.deepEqual(s.properties.level.enum, ['beginner', 'experienced', 'unset'])
    assert.deepEqual(s.properties.source.enum, ['declared', 'inferred'])
    assert.deepEqual(s.required, ['level', 'source'])
})

test('the schema warns, where the model reads it, that experienced cannot be inferred', () => {
    assert.match(TOOL_SCHEMAS.set_experience_level.properties.level.description, /only accepted with source 'declared'/)
})

test('the description states the words-not-decisions line', () => {
    assert.match(EXPERIENCE_TOOL_SPEC.set_experience_level, /never what they decide, never a level or a size/)
})

test('the description tells the model the attempt will be refused', () => {
    // Cheaper than letting it retry: it should go and let the user say it instead.
    assert.match(EXPERIENCE_TOOL_SPEC.set_experience_level, /the attempt will be refused/)
})
