import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userService } from '../../api/user/user.service.js'

// savePreferences validates the payload shape BEFORE touching the DB, so these
// rejection cases exercise the guard without a live Mongo connection.
async function rejects(value) {
    await assert.rejects(
        () => userService.savePreferences('user-1', value),
        err => err.status === 400 && /object/i.test(err.message),
    )
}

test('savePreferences: rejects null', () => rejects(null))
test('savePreferences: rejects undefined', () => rejects(undefined))
test('savePreferences: rejects a primitive', () => rejects('nope'))
test('savePreferences: rejects a number', () => rejects(42))
test('savePreferences: rejects an array', () => rejects([{ theme: 'x' }]))
