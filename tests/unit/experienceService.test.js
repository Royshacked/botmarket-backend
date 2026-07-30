import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getExperienceLevel, setExperienceLevel, invalidateExperience } from '../../services/experience.service.js'
import { maySet, LEVELS, INFERABLE_LEVELS } from '../../api/experience/experience.model.js'

// THE ASYMMETRY IS THE FEATURE, so it is tested first and hardest.
//
// `beginner` may be inferred. `experienced` may only be declared. Not squeamishness — the costs
// differ. Treating an expert as a beginner is mildly irritating and they fix it in one sentence.
// Treating a beginner as an expert puts a wall of jargon in front of a Confirm button, and they
// cannot tell anything went wrong. The app may err in exactly one direction.
//
// The guard lives in the SERVICE, not in a prompt, because a prompt instruction can be ignored by
// a model and a guard cannot. These tests are what stop it being "simplified" into symmetry.

const uid = () => `u${Math.random().toString(36).slice(2, 10)}`

function fakeDb(docs = []) {
    return {
        docs,
        collection: () => ({
            findOne: async (q) => docs.find(d => d.userId === q.userId) ?? null,
            updateOne: async (q, u, opts) => {
                const i = docs.findIndex(d => d.userId === q.userId)
                if (i >= 0) docs[i] = { ...docs[i], ...u.$set }
                else if (opts?.upsert) docs.push({ ...u.$set })
                return { modifiedCount: 1 }
            },
        }),
    }
}

// ─── the rule itself ──────────────────────────────────────────────────────────

test('only "beginner" is inferable', () => {
    assert.deepEqual(INFERABLE_LEVELS, ['beginner'])
    assert.deepEqual(LEVELS, ['beginner', 'experienced'])
})

test('maySet: inferred may set beginner and NOTHING else', () => {
    assert.equal(maySet('beginner', 'inferred'), true)
    assert.equal(maySet('experienced', 'inferred'), false)
    assert.equal(maySet(null, 'inferred'), false, 'only the user may clear their own level')
})

test('maySet: declared may set anything, including clearing it', () => {
    assert.equal(maySet('beginner', 'declared'), true)
    assert.equal(maySet('experienced', 'declared'), true)
    assert.equal(maySet(null, 'declared'), true)
})

test('maySet: junk is refused whatever the source', () => {
    assert.equal(maySet('expert', 'declared'), false)
    assert.equal(maySet('beginner', 'guessed'), false)
    assert.equal(maySet('beginner', undefined), false)
})

// ─── the guard, through the service ───────────────────────────────────────────

test('an INFERRED "experienced" is refused, and says why', async () => {
    // The single most important line in this file. If this ever passes, the app can quietly decide
    // someone is an expert and stop explaining things to a person who needed it.
    const db = fakeDb()
    const res = await setExperienceLevel(uid(), 'experienced', 'inferred', { db })
    assert.equal(res.ok, false)
    assert.match(res.reason, /only "beginner" may be inferred/)
    assert.equal(db.docs.length, 0, 'nothing was written')
})

test('a DECLARED "experienced" is accepted — the user is allowed to say it', async () => {
    const db = fakeDb()
    const u = uid()
    const res = await setExperienceLevel(u, 'experienced', 'declared', { db })
    assert.equal(res.ok, true)
    assert.equal(db.docs[0].level, 'experienced')
    assert.equal(db.docs[0].source, 'declared')
})

test('an inferred "beginner" is accepted — the one direction we may err in', async () => {
    const db = fakeDb()
    const res = await setExperienceLevel(uid(), 'beginner', 'inferred', { db })
    assert.equal(res.ok, true)
    assert.equal(db.docs[0].level, 'beginner')
})

test('only the user may clear their own level', async () => {
    const db = fakeDb()
    const u = uid()
    await setExperienceLevel(u, 'beginner', 'inferred', { db })
    assert.equal((await setExperienceLevel(u, null, 'inferred', { db })).ok, false)
    assert.equal((await setExperienceLevel(u, null, 'declared', { db })).ok, true)
    assert.equal(db.docs[0].level, null)
})

test('a refusal is a no-op, not a partial write', async () => {
    const db = fakeDb()
    const u = uid()
    await setExperienceLevel(u, 'beginner', 'inferred', { db })
    await setExperienceLevel(u, 'experienced', 'inferred', { db })
    assert.equal(db.docs[0].level, 'beginner', 'the refused write left the existing level alone')
})

// ─── reads ────────────────────────────────────────────────────────────────────

test('an unknown user has no level — null means no view, not a default', async () => {
    // The convention carried over from the objective: nothing is assumed about anyone. An
    // un-inferred user must see today's behaviour exactly.
    assert.equal(await getExperienceLevel(uid(), { db: fakeDb() }), null)
})

test('no userId means no level, without touching the database', async () => {
    assert.equal(await getExperienceLevel(null), null)
})

test('a write takes effect on the very next read — the cache is busted, not waited out', async () => {
    // "Talk to me normally" has to work on the next reply, not in five minutes.
    const db = fakeDb()
    const u = uid()
    await setExperienceLevel(u, 'beginner', 'inferred', { db })
    assert.equal(await getExperienceLevel(u, { db }), 'beginner')
    await setExperienceLevel(u, 'experienced', 'declared', { db })
    assert.equal(await getExperienceLevel(u, { db }), 'experienced')
})

test('a second read is served from cache rather than the database', async () => {
    const db = fakeDb([{ userId: 'cached-u', level: 'beginner' }])
    let reads = 0
    const counting = { collection: () => ({ findOne: async () => { reads++; return { level: 'beginner' } } }) }
    invalidateExperience('cached-u')
    await getExperienceLevel('cached-u', { db: counting })
    await getExperienceLevel('cached-u', { db: counting })
    assert.equal(reads, 1)
    assert.ok(db)
})

test('a database failure degrades to null rather than failing the user’s turn', async () => {
    // This is read on every turn of every agent. A lookup for how to TALK to someone must never be
    // what stops them getting an answer.
    const broken = { collection: () => ({ findOne: async () => { throw new Error('mongo down') } }) }
    assert.equal(await getExperienceLevel(uid(), { db: broken }), null)
})

test('a failed read is NOT cached — a blip must not pin someone to "no view"', async () => {
    const u = uid()
    let calls = 0
    const flaky = {
        collection: () => ({
            findOne: async () => {
                calls++
                if (calls === 1) throw new Error('transient')
                return { level: 'beginner' }
            },
        }),
    }
    assert.equal(await getExperienceLevel(u, { db: flaky }), null)
    assert.equal(await getExperienceLevel(u, { db: flaky }), 'beginner', 'the retry actually re-read')
})
