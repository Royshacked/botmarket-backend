// Loaded into every test process via `node --test --import ./tests/setup.mjs` (see package.json).
// Its whole job is to make a test process able to EXIT.
//
// `getDb()` is a lazy singleton with no owner: whichever test first reaches one of its ~48 caller
// modules opens the client, and the connection pool + topology heartbeat that come with it are
// ref'd handles the event loop can never drain. The assertions all pass, the file finishes, and the
// process then sits forever. That is not hypothetical — three orphans were found holding Atlas
// connections for three days, having burned ~114s of CPU each on nothing but heartbeats.
//
// Registered here rather than in each file for the obvious reason (there are ~60) and a better one:
// a per-file hook only protects the files that remember it, and the failure mode is a NEW test
// silently re-arming the trap.
//
// `after()` and not `process.on('beforeExit')`: beforeExit fires when the loop drains, which is
// precisely what an open Mongo client prevents. The hook that never runs is worse than no hook.
import { after } from 'node:test'
import { closeDb } from '../providers/mongodb.provider.js'
import { _setCorporateActionsIO } from '../services/corporateActions.service.js'

// No test reads FMP's split calendar for real (2026-11-22): every edit path asks it first (splitSweep ensureRestated),
// so a test saving a setup would otherwise make a network call. A test that needs splits sets its own.
_setCorporateActionsIO({ calendar: async () => [] })

after(async () => {
    // Never fail a green suite on teardown. A close that throws is worth seeing, but it is not a
    // test result, and turning it into one would make an unrelated network blip look like a bug in
    // whatever ran last.
    try {
        await closeDb()
    } catch (err) {
        console.error('[tests/setup] closeDb failed during teardown:', err?.message ?? err)
    }
})
