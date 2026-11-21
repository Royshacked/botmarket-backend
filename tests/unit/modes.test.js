import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeModes, modeOf, MODES } from '../../services/desks/modes.js'
import { makeAsking } from '../../services/desks/asking.js'
import { withSessionLock, laneKey } from '../../services/desks/turnLock.js'

// The chat's mode (docs/design/modes-and-builders.md M3/M4, step 3): General or a builder — derived from the floor.

const user = { _id: 'u1', role: 'user' }

test('the mode a floor means: a builder on the floor is its mode, anyone else is General', () => {
    assert.deepEqual(Object.keys(MODES), ['general', 'mentor', 'portfolio', 'analyst'])
    for (const b of ['mentor', 'portfolio', 'analyst']) assert.equal(modeOf(b), b)
    for (const f of ['axl', 'echo', 'proteus', 'scanner', 'strategy', null, undefined]) assert.equal(modeOf(f), 'general', String(f))
})

function rig() {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    // The analyst's card (2026-11-21) reads the coverage book — a stub, never the real store.
    const asks = makeAsking({ sessions, profiles: { read: async () => null }, runTurn: async () => {}, coverage: { listSymbols: async () => [], getCoverageBySymbol: async () => null } })
    return { sessions, modes: makeModes({ sessions, asks }) }
}

test('picking a mode moves the floor — General is Axl; a builder keeps its parked work when the user leaves and comes back', async () => {
    const { sessions, modes } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'NVDA' } } })
    let r = await modes.setMode({ user, sessionId: s.sessionId, mode: 'mentor' })
    assert.deepEqual(await r.done, { mode: 'mentor', floor: 'mentor' })
    r = await modes.setMode({ user, sessionId: s.sessionId, mode: 'general' })
    assert.deepEqual(await r.done, { mode: 'general', floor: 'axl' })
    const after = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(after.floor, 'axl')
    assert.deepEqual(after.agentState.mentor, { draft: { asset: 'NVDA' } }, 'the trade on the table is kept')
    r = await modes.setMode({ user, sessionId: s.sessionId, mode: 'analyst' })
    assert.equal((await r.done).floor, 'analyst', 'Analyst mode is for every user (M17)')
})

test("a switch waits for Axl's running turn — never for a builder's (lanes, step 5a)", async () => {
    const { sessions, modes } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    const log = []
    const slow = (name) => async () => { await new Promise(r => setTimeout(r, 15)); log.push(name) }
    // A builder at work on the session's own key: the switch lands at once.
    const desk = withSessionLock(s.sessionId, slow('desk'))
    await (await modes.setMode({ user, sessionId: s.sessionId, mode: 'general' })).done.then(() => log.push('mode'))
    await desk
    assert.deepEqual(log, ['mode', 'desk'])
    // Axl's turn in his lane: the switch lands after it.
    log.length = 0
    const axl = withSessionLock(laneKey(s.sessionId, 'axl'), slow('axl'))
    await (await modes.setMode({ user, sessionId: s.sessionId, mode: 'general' })).done.then(() => log.push('mode'))
    await axl
    assert.deepEqual(log, ['axl', 'mode'])
    assert.equal(laneKey('s9', 'mentor'), 's9', "every desk keeps the session's own key")
})

test('refused: an unknown mode, another user\'s session; nothing moves', async () => {
    const { sessions, modes } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    assert.equal((await modes.setMode({ user, sessionId: s.sessionId, mode: 'echo' })).reason, 'invalid_mode')
    assert.equal((await modes.setMode({ user, sessionId: s.sessionId, mode: 'scanner' })).reason, 'invalid_mode', 'the stock picker is never a mode')
    assert.equal((await modes.setMode({ user: { _id: 'u2' }, sessionId: s.sessionId, mode: 'mentor' })).reason, 'not_found')
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).floor ?? 'axl', 'axl')
})
