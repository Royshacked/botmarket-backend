import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _scopeOf } from '../../api/sessions/sessions.controller.js'

// The sessions routes' one judgment: which scope a request may ask for. The admin desks keep their own
// session ('strategy', 'aether') and a trader is refused them — the same gate those desks' routes keep.

const as = (role) => ({ user: { _id: 'u1', role } })

test('no scope is the one chat', () => {
    assert.equal(_scopeOf(as('user'), undefined), 'main')
    assert.equal(_scopeOf(as('user'), ''), 'main')
    assert.equal(_scopeOf(as('user'), 'main'), 'main')
})

test('an unknown scope is a 400', () => {
    assert.throws(() => _scopeOf(as('admin'), 'mentor'), e => e.status === 400)
})

test('the admin desks’ scopes are 403 for a trader and open to an admin', () => {
    for (const s of ['strategy', 'aether']) {
        assert.throws(() => _scopeOf(as('user'), s), e => e.status === 403, s)
        assert.equal(_scopeOf(as('admin'), s), s)
    }
})
