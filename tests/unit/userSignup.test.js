import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { invalidUserFields, USERNAME_MIN, USERNAME_MAX, FULLNAME_MAX, PASSWORD_MIN } from '../../api/user/user.model.js'

// What a new account must look like, server-side. The password rule mirrors AuthModal's
// validatePassword (≥ 8 characters, ≥ 2 digits); until 2026-09-16 it had no server twin.

const good = { username: 'roy_shacked', fullname: 'Roy Shacked', password: 'hunter2024' }

test('a well-formed sign-up passes', () => {
    assert.equal(invalidUserFields(good), null)
})

test('username: bounded, no whitespace, no padding', () => {
    assert.match(invalidUserFields({ ...good, username: 'ab' }), /characters/)
    assert.match(invalidUserFields({ ...good, username: 'a'.repeat(USERNAME_MAX + 1) }), /characters/)
    assert.match(invalidUserFields({ ...good, username: 'roy shacked' }), /whitespace/)
    assert.match(invalidUserFields({ ...good, username: ' roy' }), /whitespace/)
    assert.match(invalidUserFields({ ...good, username: 42 }), /whitespace|characters/)
    assert.equal(invalidUserFields({ ...good, username: 'a'.repeat(USERNAME_MIN) }), null)
})

test('fullname: required, bounded', () => {
    assert.match(invalidUserFields({ ...good, fullname: '   ' }), /required/)
    assert.match(invalidUserFields({ ...good, fullname: undefined }), /required/)
    assert.match(invalidUserFields({ ...good, fullname: 'x'.repeat(FULLNAME_MAX + 1) }), /at most/)
})

test('password: the same rule the form enforces', () => {
    assert.match(invalidUserFields({ ...good, password: 'short1' }), new RegExp(`${PASSWORD_MIN}`))
    assert.match(invalidUserFields({ ...good, password: 'longenoughbutnodigits' }), /numbers/)
    assert.match(invalidUserFields({ ...good, password: 'onlyone1digit' }), /numbers/)
    assert.equal(invalidUserFields({ ...good, password: 'exactly8' + '12' }), null)
})

test('a rename validates the username alone — the other fields are not being changed', () => {
    assert.equal(invalidUserFields({ username: 'new_name' }, ['username']), null)
    assert.match(invalidUserFields({ username: 'x' }, ['username']), /characters/)
})

test('self sign-up rides userService.createUser — one path, and it is the one that welcomes', () => {
    const src = readFileSync(new URL('../../api/authentication/authentication.service.js', import.meta.url), 'utf8')
    assert.match(src, /userService\.createUser\(/)
    assert.doesNotMatch(src, /insertOne|buildUserDoc/, 'the insert is written once, in user.service')
})
