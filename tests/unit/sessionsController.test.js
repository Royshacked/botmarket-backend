import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _scopeOf } from '../../api/sessions/sessions.controller.js'

// The sessions routes' one judgment: which scope a request may ask for. The admin desk keeps its own
// session ('strategy') and a trader is refused it — the same gate its routes keep.

const as = (role) => ({ user: { _id: 'u1', role } })

test('no scope is the one chat', () => {
    assert.equal(_scopeOf(as('user'), undefined), 'main')
    assert.equal(_scopeOf(as('user'), ''), 'main')
    assert.equal(_scopeOf(as('user'), 'main'), 'main')
})

test('an unknown scope is a 400', () => {
    assert.throws(() => _scopeOf(as('admin'), 'mentor'), e => e.status === 400)
})

test('the admin desk’s scope is 403 for a trader and open to an admin', () => {
    for (const s of ['strategy']) {
        assert.throws(() => _scopeOf(as('user'), s), e => e.status === 403, s)
        assert.equal(_scopeOf(as('admin'), s), s)
    }
    // Aether's scope went with the event board (2026-11-18): unknown now, for everyone.
    assert.throws(() => _scopeOf(as('admin'), 'aether'), e => e.status === 400)
})
