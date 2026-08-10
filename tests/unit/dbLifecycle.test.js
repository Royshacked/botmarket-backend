// What keeps a test process able to EXIT.
//
// A connected MongoClient holds a pool and a topology monitor that heartbeats every replica-set
// member. Both are ref'd, so the event loop cannot drain and the process cannot exit — after every
// assertion has already passed. That is the worst shape a leak can take: the suite looks green and
// simply never returns. Three orphans were once found holding Atlas connections for three days,
// burning ~114s of CPU each on nothing but heartbeats.
//
// There are two independent defences and this file guards both, because each covers the other's gap:
//
//   1. STARVATION (services/config.js) — under test, config refuses to load .env, so getDb() has no
//      URI and throws instantly. Cheap and total, but it holds only while no test supplies a URI
//      itself, which config.js explicitly invites ("a test that needs a value sets it itself").
//   2. TEARDOWN (tests/setup.mjs → closeDb) — for the test that does connect. Costs nothing when
//      nothing connected, which is the normal case.
import test from 'node:test'
import assert from 'node:assert/strict'
import { closeDb } from '../../providers/mongodb.provider.js'
import { config } from '../../services/config.js'

// ── the teardown half ────────────────────────────────────────────────────────
// The teardown runs after EVERY file, and almost none of them connect. If closing without a
// connection threw, the hook meant to prevent a hang would instead fail ~60 green suites.
test('closing without ever connecting is a no-op, not an error', async () => {
    await assert.doesNotReject(() => closeDb())
})

test('closing twice is a no-op — the hook must not care if something already closed', async () => {
    await closeDb()
    await assert.doesNotReject(() => closeDb())
})

// ── the starvation half ──────────────────────────────────────────────────────
// This is the one that protects the other ~60 files, and it is invisible: nothing in a test SAYS
// "and no database, please". It is a property of config.js that a future refactor could drop
// without any test noticing — which is exactly how the three-day orphans happened.
test('a test process has no Mongo URI — .env is not loaded under test', () => {
    assert.equal(process.env.NODE_TEST_CONTEXT !== undefined, true,
        'this file must run under the node test runner for the guard below to mean anything')
    // If this fails on your machine because MONGODB_URI is exported in your shell, that is the
    // finding, not a false alarm: every test in this suite would then be one getDb() away from the
    // PRODUCTION cluster. Unset it rather than relaxing the assertion.
    assert.equal(config.mongoUri, undefined,
        'config resolved a Mongo URI under test — tests can now reach a real cluster')
})
