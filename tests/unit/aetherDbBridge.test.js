// The Node → Python database bridge.
//
// The Aether engine is a separate Python process that must reach the SAME database as the
// app. It used to be told which one via `env.MONGO_DB = env.DB_NAME` — and DB_NAME was not
// set, so the bridge assigned nothing and both sides fell through to their own hardcoded
// "test". They agreed by luck, not by configuration. On 2026-09-03 one engine process had
// MONGO_DB=botmarket in its environment and wrote a complete parallel copy of all 21
// aether_* collections: no error, no warning, and 57 news items stranded in a database
// nothing reads. The pipeline sat dead for five days looking exactly like a running one.
//
// The fix is to stop having two sources of truth. getDbName() reports the database this
// process is ACTUALLY connected to, and the scheduler refuses to spawn when it cannot
// resolve one — a silent default is what made the original divergence invisible.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDbName } from '../../providers/mongodb.provider.js'

// getDbName() prefers the live connection and falls back to config.dbName, which reads
// process.env.DB_NAME on every access. Nothing here connects, so these exercise the
// fallback — the path that runs before the first query, and the one that used to lie.
function withDbNameEnv(value, fn) {
    const had = Object.hasOwn(process.env, 'DB_NAME')
    const prev = process.env.DB_NAME
    if (value === undefined) delete process.env.DB_NAME
    else process.env.DB_NAME = value
    try {
        return fn()
    } finally {
        if (had) process.env.DB_NAME = prev
        else delete process.env.DB_NAME
    }
}

test('an unset DB_NAME resolves to null, never to a guessed name', () => {
    // The whole defect in one assertion: the answer to "which database?" must be
    // "I don't know" rather than a plausible-looking default nobody chose.
    withDbNameEnv(undefined, () => {
        assert.equal(getDbName(), null)
    })
})

test('an empty DB_NAME is not a database name', () => {
    withDbNameEnv('', () => {
        assert.equal(getDbName(), null)
    })
})

test('a configured DB_NAME is what the engine will be told', () => {
    withDbNameEnv('test', () => {
        assert.equal(getDbName(), 'test')
    })
})

test('the name is passed through verbatim — no normalising, no substitution', () => {
    // If someone points the app at another database, the engine must follow it there.
    // Silently rewriting the name back to a default is the original bug wearing a hat.
    withDbNameEnv('botmarket_dev', () => {
        assert.equal(getDbName(), 'botmarket_dev')
    })
})
