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
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDbName } from '../../providers/mongodb.provider.js'
import { aetherSchedulerService, _engineDbName } from '../../services/aetherScheduler.service.js'

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

// ── The host gate ─────────────────────────────────────────────────────────────
//
// The scheduler is no longer started behind the instance lease. The lease answers
// "should this process own the shared work?", which is the wrong question: only a
// machine with an aether-engine checkout and a built venv can run the engine at all.
// Under the lease it ran essentially nowhere — the holder is the deployed instance,
// which has no Python, and the laptop that does was a follower.
//
// start() must therefore be a SAFE no-op on a host without the engine, and must never
// leave a child process behind. These run in-process, so a spawn here would be a real
// Python daemon attached to the test run.

function withEnginePath(value, fn) {
    const had = Object.hasOwn(process.env, 'AETHER_ENGINE_PATH')
    const prev = process.env.AETHER_ENGINE_PATH
    if (value === undefined) delete process.env.AETHER_ENGINE_PATH
    else process.env.AETHER_ENGINE_PATH = value
    try {
        return fn()
    } finally {
        if (had) process.env.AETHER_ENGINE_PATH = prev
        else delete process.env.AETHER_ENGINE_PATH
    }
}

test('no AETHER_ENGINE_PATH means no scheduler, and no throw', () => {
    withEnginePath(undefined, () => {
        assert.doesNotThrow(() => aetherSchedulerService.start())
    })
})

test('an engine path with no venv does not spawn — the deployed-instance case', () => {
    // A directory that exists but holds no .venv: precisely what a Render checkout of
    // the backend looks like if AETHER_ENGINE_PATH is ever pointed at something real.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-noengine-'))
    try {
        withEnginePath(empty, () => {
            assert.doesNotThrow(() => aetherSchedulerService.start())
        })
    } finally {
        fs.rmSync(empty, { recursive: true, force: true })
    }
})

test('stop() is safe when nothing was ever started', async () => {
    await assert.doesNotReject(() => aetherSchedulerService.stop())
})

// ── The house database ────────────────────────────────────────────────────────
//
// Aether is house research: one news queue (filled by the deployed crons), one candidate list,
// read by every admin on every host. A laptop on its own dev database (axl_dev, 2026-09-19)
// must still run the engine against the HOUSE one — pointed at the local clone it reads a
// queue nobody refreshes and writes a list nobody deployed can see. AETHER_DB says which;
// unset keeps the old rule (the connected database), which is right for the deployed instance.

function withAetherDbEnv(value, fn) {
    const had = Object.hasOwn(process.env, 'AETHER_DB')
    const prev = process.env.AETHER_DB
    if (value === undefined) delete process.env.AETHER_DB
    else process.env.AETHER_DB = value
    try {
        return fn()
    } finally {
        if (had) process.env.AETHER_DB = prev
        else delete process.env.AETHER_DB
    }
}

test('AETHER_DB unset → the engine follows the connected database (the deployed case)', () => {
    withAetherDbEnv(undefined, () => withDbNameEnv('test', () => {
        assert.equal(_engineDbName(), 'test')
    }))
})

test('AETHER_DB set → the engine works in the house database, not the local one', () => {
    withAetherDbEnv('test', () => withDbNameEnv('axl_dev', () => {
        assert.equal(_engineDbName(), 'test')
    }))
})

test('an empty AETHER_DB is unset, not a database named ""', () => {
    withAetherDbEnv('', () => withDbNameEnv('axl_dev', () => {
        assert.equal(_engineDbName(), 'axl_dev')
    }))
})
