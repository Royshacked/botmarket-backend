import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { planThread } from '../../services/migrations/unifiedChat.migration.js'
import { makeAgentContextService } from '../../services/agentContext.service.js'
import { makeSessionService } from '../../services/session.service.js'

// Unified chat, phase 9 (Roy, 2026-10-20): the legacy chat stores move onto sessions and agent_contexts. What each
// thread becomes, and the two imports — idempotent, older turns IN FRONT, nothing filed that the user never spoke in.

const all = () => true
const none = () => false
const t = (over) => ({ threadId: 'thr_1', userId: 'u1', tier: 'linked', messages: [{ role: 'user', content: 'hi' }], ...over })

test('planThread: a linked thread goes onto its entity, as that kind\'s agent', () => {
    assert.deepEqual(planThread(t({ agent: 'mentor', subjectType: 'setup', subjectId: 's1' }), all), { action: 'context', kind: 'setup', agent: 'mentor', entityId: 's1' })
    assert.deepEqual(planThread(t({ agent: 'analyst', subjectType: 'coverage', subjectId: 'c1' }), all), { action: 'context', kind: 'coverage', agent: 'analyst', entityId: 'c1' })
    assert.deepEqual(planThread(t({ agent: 'scanner', subjectType: 'scan', subjectId: 'scan_1' }), all).kind, 'scan')
    assert.deepEqual(planThread(t({ agent: 'portfolio', subjectType: 'portfolio', subjectId: 'p1' }), all).agent, 'portfolio')
})

test('planThread: an entity that is gone, and the retired desks (Kairos, Idea, Pythia\'s old tilts), are deleted', () => {
    assert.deepEqual(planThread(t({ agent: 'mentor', subjectType: 'setup', subjectId: 's9' }), none), { action: 'delete', why: 'entity_gone' })
    assert.deepEqual(planThread(t({ agent: 'kairos', subjectType: 'call', subjectId: 'k1' }), all), { action: 'delete', why: 'retired:call' })
    assert.deepEqual(planThread(t({ agent: 'idea', subjectType: 'idea', subjectId: 'i1' }), all), { action: 'delete', why: 'retired:idea' })
    assert.deepEqual(planThread(t({ agent: 'strategy', subjectType: 'tilt', subjectId: 't1' }), all), { action: 'delete', why: 'retired:tilt' })
    assert.deepEqual(planThread(t({ agent: 'kairos', tier: 'draft', subjectId: null }), all), { action: 'delete', why: 'retired:kairos' })
})

test('planThread: a chat desk\'s draft becomes an archived session; Pythia\'s and Aether\'s own threads are left alone', () => {
    assert.deepEqual(planThread(t({ agent: 'mentor', tier: 'draft', subjectType: 'setup', subjectId: null }), all), { action: 'session' })
    assert.deepEqual(planThread(t({ agent: 'axl', tier: 'draft', subjectId: null }), all), { action: 'session' })
    assert.deepEqual(planThread(t({ agent: 'strategy', tier: 'draft', subjectId: null }), all), { action: 'keep' })
    assert.deepEqual(planThread(t({ agent: 'aether', tier: 'linked', subjectType: 'event', subjectId: 'e1' }), all), { action: 'keep' })
})

test('importLegacy: older turns go in FRONT of what is sealed since; a source already in is skipped', async () => {
    const { db } = memDb()
    const ctx = makeAgentContextService({ getDb: async () => db })
    await ctx.seal({ userId: 'u1', kind: 'setup', entityId: 's1', agent: 'mentor', messages: [{ role: 'user', content: 'new turn' }] })
    const r1 = await ctx.importLegacy({ userId: 'u1', kind: 'setup', entityId: 's1', agent: 'mentor', sources: ['thread:thr_1', 'setup:s1'], at: 1000,
        messages: [{ role: 'user', content: 'old ask' }, { role: 'assistant', content: 'old answer' }, { role: 'tool', content: 'x' }] })
    assert.equal(r1.imported, true)
    const doc = await ctx.load({ userId: 'u1', kind: 'setup', entityId: 's1', agent: 'mentor' })
    assert.deepEqual(doc.messages.map(m => m.content), ['old ask', 'old answer', 'new turn'])
    assert.equal(doc.messages[0].at, 1000)
    assert.deepEqual(doc.legacy, ['thread:thr_1', 'setup:s1'])
    assert.deepEqual(await ctx.importLegacy({ userId: 'u1', kind: 'setup', entityId: 's1', agent: 'mentor', sources: ['setup:s1', 'thread:thr_1'], messages: [{ role: 'user', content: 'old ask' }] }), { imported: false, reason: 'already_imported' })
    assert.equal((await ctx.load({ userId: 'u1', kind: 'setup', entityId: 's1', agent: 'mentor' })).messages.length, 3, 'a re-run doubles nothing')
    assert.equal((await ctx.importLegacy({ userId: 'u1', kind: 'call', entityId: 'k1', agent: 'mentor', sources: ['s'], messages: [{ role: 'user', content: 'x' }] })).imported, false, 'not a context kind')
    assert.equal((await ctx.importLegacy({ userId: 'u1', kind: 'setup', entityId: 's2', agent: 'mentor', sources: [], messages: [{ role: 'user', content: 'x' }] })).reason, 'sources are required')
})

test('mergeSources: oldest first; a copy of a conversation already taken is left out; one that extends it replaces it', async () => {
    const { mergeSources } = await import('../../services/migrations/unifiedChat.migration.js')
    const ask = (t) => ({ role: 'user', content: t }), say = (t) => ({ role: 'assistant', content: t })
    const book = [ask('Build me a growth book'), say('What is the horizon?')]
    // A book's thread and its own messages: the same chat, the book's a step further. → once, the longer one.
    const m1 = mergeSources([
        { source: 'book:p1', at: 200, messages: [...book, ask('Five years')] },
        { source: 'thread:t1', at: 100, messages: book },
    ])
    assert.deepEqual(m1.messages.map(m => m.content), ['Build me a growth book', 'What is the horizon?', 'Five years'])
    assert.equal(m1.dropped, 1)
    // Two separate revisions that open with the SAME ask — both kept, whole, in time order (REGN on axl_dev).
    const rev1 = [ask('Revise our coverage on REGN.'), say('Holds at 18x.')]
    const rev2 = [ask('Revise our coverage on REGN.'), say('Now 18.7x–25.3x.')]
    const m2 = mergeSources([{ source: 'thread:b', at: 300, messages: rev2 }, { source: 'thread:a', at: 100, messages: rev1 }])
    assert.deepEqual(m2.messages.map(m => m.content), ['Revise our coverage on REGN.', 'Holds at 18x.', 'Revise our coverage on REGN.', 'Now 18.7x–25.3x.'])
    assert.equal(m2.dropped, 0)
    assert.equal(m2.at, 100)
    assert.deepEqual(mergeSources([{ source: 'x', at: 1, messages: [] }]).messages, [])
})

test('importArchived: one archived session, its rows through the timeline gate; idempotent; nothing filed the user never spoke in', async () => {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const out = await sessions.importArchived({ userId: 'u1', source: 'thread:thr_2', createdAt: 5000, archivedAt: 6000, title: null,
        messages: [{ agent: 'mentor', role: 'user', content: 'Build me an AMD long' }, { agent: 'mentor', role: 'assistant', content: 'Where is your stop?' }, { agent: 'mentor', role: 'tool', content: 'junk' }] })
    assert.equal(out.imported, true)
    const s = await sessions.get({ sessionId: out.sessionId, userId: 'u1' })
    assert.deepEqual([s.status, s.title, s.archivedAt, s.legacySource], ['archived', 'Build me an AMD long', 6000, 'thread:thr_2'])
    const rows = await sessions.messagesSince({ sessionId: out.sessionId, userId: 'u1' })
    assert.deepEqual(rows.map(r => `${r.seq}:${r.role}`), ['1:user', '2:assistant'])
    assert.equal((await sessions.importArchived({ userId: 'u1', source: 'thread:thr_2', messages: [{ agent: 'mentor', role: 'user', content: 'x' }] })).reason, 'already_imported')
    assert.equal((await sessions.importArchived({ userId: 'u1', source: 'thread:thr_3', messages: [{ agent: 'axl', role: 'assistant', content: 'Hello' }] })).reason, 'nothing_said')
    assert.equal((await sessions.list({ userId: 'u1' })).length, 1)
})

test('subjectSlice: a thread that went on to a second company moves from the first turn naming ITS company', async () => {
    const { subjectSlice } = await import('../../services/migrations/unifiedChat.migration.js')
    const zts = [{ role: 'user', content: 'Revise our coverage on ZTS.' }, { role: 'assistant', content: 'ZTS — holds.' }]
    const regn = [{ role: 'user', content: 'Revise our coverage on REGN.' }, { role: 'assistant', content: 'REGN — 18.7x.' }]
    assert.deepEqual(subjectSlice([...zts, ...regn], 'cov_REGN_e747afca'), regn)
    assert.deepEqual(subjectSlice([...regn, ...zts], 'cov_REGN_e747afca'), [...regn, ...zts], 'already starts on it — whole')
    assert.deepEqual(subjectSlice(zts, 'cov_REGN_e747afca'), zts, 'never names it — kept whole, nothing to cut on')
    assert.equal(subjectSlice([{ role: 'user', content: 'gold first' }, { role: 'user', content: 'Long $BRK.B here' }], 'setup_BRK.B_1a').length, 1)
    assert.equal(subjectSlice([{ role: 'user', content: 'MAREGNX is not it' }, { role: 'user', content: 'REGN' }], 'cov_REGN_x').length, 1, 'a word containing it is not it')
    assert.deepEqual(subjectSlice([...zts, ...regn], 'scan_1786445452372'), [...zts, ...regn], 'a scan spans names — untouched')
})
