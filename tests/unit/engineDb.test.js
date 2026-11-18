// Which database the engine's data lives in — services/engineDb.js, read by Pythia's data services, the
// forecast map and the house scan.
//
// History (from the deleted aetherDbBridge test, 2026-11-18): the backend once told the Python engine its
// database via `env.MONGO_DB = env.DB_NAME` while DB_NAME was unset; both sides fell through to a hardcoded
// "test" and agreed by luck. On 2026-09-03 one engine process wrote a full parallel copy of its collections
// into a database nothing read, and the pipeline sat dead for five days looking like a running one. So:
// getDbName() reports the database actually configured or connected, never a guessed default, and
// AETHER_DB names the house database when a laptop runs on its own dev clone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDbName } from '../../providers/mongodb.provider.js'
import { engineDbName } from '../../services/engineDb.js'

function withEnv(name, value, fn) {
    const had = Object.hasOwn(process.env, name)
    const prev = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    try {
        return fn()
    } finally {
        if (had) process.env[name] = prev
        else delete process.env[name]
    }
}
const withDbName = (v, fn) => withEnv('DB_NAME', v, fn)
const withAetherDb = (v, fn) => withEnv('AETHER_DB', v, fn)

// getDbName() prefers the live connection and falls back to config.dbName, which reads process.env.DB_NAME
// on every access. Nothing here connects, so these exercise the fallback.
test('an unset DB_NAME resolves to null, never to a guessed name', () => {
    withDbName(undefined, () => assert.equal(getDbName(), null))
})

test('an empty DB_NAME is not a database name', () => {
    withDbName('', () => assert.equal(getDbName(), null))
})

test('the name is passed through verbatim — no normalising, no substitution', () => {
    withDbName('botmarket_dev', () => assert.equal(getDbName(), 'botmarket_dev'))
})

test('AETHER_DB unset → the engine data is read from the connected database (the deployed case)', () => {
    withAetherDb(undefined, () => withDbName('test', () => assert.equal(engineDbName(), 'test')))
})

test('AETHER_DB set → the house database, not the local one', () => {
    withAetherDb('test', () => withDbName('axl_dev', () => assert.equal(engineDbName(), 'test')))
})

test('an empty AETHER_DB is unset, not a database named ""', () => {
    withAetherDb('', () => withDbName('axl_dev', () => assert.equal(engineDbName(), 'axl_dev')))
})
