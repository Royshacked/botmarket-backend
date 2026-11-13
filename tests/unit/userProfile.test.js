import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeUserProfileService, aboutSection, workingOnLines, sizeWords, MAX_NOTES, COLLECTION } from '../../services/userProfile.service.js'
import { makeRememberHandler, REMEMBER_TOOL } from '../../services/tools/userProfile.tools.js'
import { runAgentStream } from '../../services/agentIO.js'

// ABOUT THE USER (docs/design/one-axl.md step 3, 2026-11-13): one small record every role reads — what the user told any
// role, the size they last settled — and, computed live, what is open at the other roles.

const rig = () => {
    const { db, rows } = memDb()
    let t = 1000
    return { svc: makeUserProfileService({ db: async () => db, now: () => ++t }), rows }
}

test('a stated fact is kept once (any case), trimmed and cut; past the cap the oldest goes; forgetting takes it back', async () => {
    const { svc, rows } = rig()
    await svc.remember('u1', '  never trades   low-float names ', { by: 'proteus' })
    assert.deepEqual((await svc.remember('u1', 'NEVER trades low-float names')).unchanged, true)
    assert.deepEqual((await svc.read('u1')).notes.map(n => [n.text, n.by]), [['never trades low-float names', 'proteus']])
    for (let i = 0; i < MAX_NOTES + 2; i++) await svc.remember('u1', `rule ${i}`)
    const notes = (await svc.read('u1')).notes
    assert.equal(notes.length, MAX_NOTES)
    assert.equal(notes[0].text, 'rule 2', 'the oldest went first')
    assert.equal((await svc.forget('u1', 'RULE 1')).removed, 4, 'rules 2–13 are left; "rule 1" matches 10, 11, 12 and 13')
    assert.equal((await svc.forget('u1', 'nothing like it')).removed, 0)
    assert.equal(rows(COLLECTION).length, 1, 'one record per user')
    assert.deepEqual(await svc.remember('', 'x'), { ok: false, reason: 'no_user' })
    assert.deepEqual(await svc.remember('u1', '   '), { ok: false, reason: 'empty' })
})

test('the size a build settled carries to the next trade — risk and position size, never a share count', async () => {
    const { svc } = rig()
    assert.equal((await svc.noteSize('u1', { unit: 'shares', value: 100 })).ok, false, '100 shares means nothing on the next name')
    assert.equal((await svc.noteSize('u1', { unit: 'risk_pct', value: 0 })).ok, false)
    await svc.noteSize('u1', { unit: 'risk_pct', value: 1 }, { asset: 'nvda' })
    assert.deepEqual((await svc.noteSize('u1', { unit: 'risk_pct', value: 1 })).unchanged, true)
    const { size } = await svc.read('u1')
    assert.deepEqual({ unit: size.unit, value: size.value, asset: size.asset }, { unit: 'risk_pct', value: 1, asset: 'NVDA' })
})

test('a read that fails is an empty record, never a failed turn', async () => {
    const svc = makeUserProfileService({ db: async () => { throw new Error('mongo down') } })
    assert.deepEqual(await svc.read('u1'), { notes: [], size: null })
})

test('the block: facts only, the size as a default to offer, what is open at the OTHER roles; nothing → null', () => {
    assert.equal(aboutSection({}), null)
    assert.equal(sizeWords({ unit: 'risk_cash', value: 1000 }), '$1,000 at risk')
    assert.equal(sizeWords({ unit: 'size_pct', value: 10 }), '10% of the account in the position')
    const text = aboutSection({
        profile: { notes: [{ text: 'never trades low-float names' }], size: { unit: 'risk_pct', value: 1, asset: 'NVDA' } },
        working: workingOnLines({ mentor: { draft: { asset: 'nvda', direction: 'LONG' } }, portfolio: { editing: { kind: 'portfolio', name: 'Growth book' } }, analyst: {} }, 'proteus'),
    })
    assert.equal(text, [
        'ABOUT THE USER (shared by every role — what they told any of us, and what is open; use it, do not recite it):',
        '- The size they last gave a trade: 1% of the account at risk (on NVDA). A default to offer, never to assume — they choose each trade\'s size.',
        '- They told us: "never trades low-float names"',
        '- On the table with the trader: building a long trade on NVDA (not saved yet).',
        '- On the table with the portfolio manager: reopened portfolio Growth book.',
    ].join('\n'))
    assert.deepEqual(workingOnLines({ mentor: { draft: { asset: 'NVDA' } } }, 'mentor'), [], 'the answering role has its own work in front of it')
})

test('the tool: keeps, says so, takes back with forget — and with no user keeps nothing', async () => {
    const { svc } = rig()
    const h = makeRememberHandler({ userId: 'u1', agent: 'mentor', profiles: svc })
    assert.match(await h({ note: 'only trades the open' }), /^Kept\./)
    assert.match(await h({ note: 'only trades the open' }), /^Already kept/)
    assert.match(await h({ note: 'the open', forget: true }), /^Removed 1 note/)
    assert.match(await makeRememberHandler({ userId: null, profiles: svc })({ note: 'x' }), /no signed-in user/)
})

test('declaring remember_about_user is all a desk does — runAgentStream builds the handler for THIS user and desk', async () => {
    let got = null, opts = null
    const run = (tools) => runAgentStream({
        log: '[mentorAgent]', requestedModel: 'm', userId: 'u7', messages: [{ role: 'user', content: 'hi' }], systemPrompt: 's', tools, toolHandlers: {},
        _resolve: () => ({ model: 'x', streamFn: async (a) => { got = a; return 'raw' }, provider: 'p' }),
        _makeRemember: (o) => { opts = o; return async () => 'kept' },
    })
    await run([{ name: REMEMBER_TOOL }])
    assert.equal(typeof got.toolHandlers[REMEMBER_TOOL], 'function')
    assert.deepEqual(opts, { userId: 'u7', agent: 'mentorAgent' })
    opts = null
    await run([{ name: 'get_candles' }])
    assert.equal(got.toolHandlers[REMEMBER_TOOL], undefined, 'a desk that never declared it gets none')
    assert.equal(opts, null)
})
