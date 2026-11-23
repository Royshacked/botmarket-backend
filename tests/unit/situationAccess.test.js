import { test } from 'node:test'
import assert from 'node:assert/strict'

import { canSeeSituation } from '../../services/situation/access.js'
import { config } from '../../services/config.js'

const LIST = () => ['1779968319268', '1780034546842']

test('an id on the list may see it; one off the list may not', () => {
    assert.equal(canSeeSituation('1779968319268', LIST), true)
    assert.equal(canSeeSituation('1780034546842', LIST), true)
    assert.equal(canSeeSituation('19b8e466-08b8-4f44-b776-da86fddcba6e', LIST), false)
})

test('a user object is read by id, then _id; numbers match as strings', () => {
    assert.equal(canSeeSituation({ id: '1780034546842', role: 'trader' }, LIST), true)
    assert.equal(canSeeSituation({ _id: '1779968319268' }, LIST), true)
    assert.equal(canSeeSituation(1779968319268, LIST), true)
})

test('the admin role alone does not open it', () => {
    assert.equal(canSeeSituation({ id: 'some-admin', role: 'admin', isAdmin: true }, LIST), false)
})

test('no user, an empty id, or an empty list → nobody', () => {
    for (const u of [null, undefined, '', {}]) assert.equal(canSeeSituation(u, LIST), false)
    assert.equal(canSeeSituation('1779968319268', () => []), false)
})

test('SITUATION_USERS is read live, trimmed, blanks dropped; unset → empty; the flag is opt-in', () => {
    const keep = { u: process.env.SITUATION_USERS, f: process.env.SITUATION_NETWORK }
    try {
        delete process.env.SITUATION_USERS
        assert.deepEqual(config.situationUsers, [])
        assert.equal(canSeeSituation('1779968319268'), false)
        process.env.SITUATION_USERS = ' 1779968319268 , ,1780034546842 '
        assert.deepEqual(config.situationUsers, ['1779968319268', '1780034546842'])
        assert.equal(canSeeSituation('1780034546842'), true)
        delete process.env.SITUATION_NETWORK
        assert.equal(config.situationNetwork, false)
        process.env.SITUATION_NETWORK = 'true'
        assert.equal(config.situationNetwork, true)
    } finally {
        if (keep.u === undefined) delete process.env.SITUATION_USERS; else process.env.SITUATION_USERS = keep.u
        if (keep.f === undefined) delete process.env.SITUATION_NETWORK; else process.env.SITUATION_NETWORK = keep.f
    }
})
