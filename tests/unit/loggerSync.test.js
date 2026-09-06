import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { logger, switchToSyncLogging, _setLogSinkForTests } from '../../services/logger.service.js'

// THE BUG THIS EXISTS FOR, found while diagnosing a shutdown that appeared to hang.
//
// `fs.appendFile` queues, and `process.exit()` discards whatever has not been flushed — so the LAST
// few lines never reach the file, and the last few lines are the whole shutdown record: did the
// loops stop, did the sockets drain, did Mongo close. A real Ctrl-C had already lost three
// loop-stop lines from the file that the console had shown, which sent the diagnosis the wrong way:
// the tail looked missing because it was never written, not because it never ran.
//
// The property is about TIMING, not content — is the line on disk by the time the call returns,
// with nothing awaited in between. That is what makes it survive process.exit().
//
// ORDER MATTERS HERE. `_sync` is module state and the switch is one-way, so the async case has to be
// asserted first. node:test runs a file's tests in order, and each test FILE gets its own process
// (see the npm test script), so nothing else can have flipped it.

// A TEMP sink, not ./logs/backend.log. This file used to probe the real log, which meant
// the operational record grew a `sync-probe-*` line on every run — and backend.log is the
// only forensic account of what the server did. Redirecting keeps the timing property
// under test while leaving that record to the server alone.
const TMP_DIR  = mkdtempSync(join(tmpdir(), 'logger-sync-'))
const LOG_FILE = join(TMP_DIR, 'backend.log')
_setLogSinkForTests(LOG_FILE)

test.after(() => {
    _setLogSinkForTests(null)
    rmSync(TMP_DIR, { recursive: true, force: true })
})

const marker = (tag) => `sync-probe-${tag}-${process.pid}-${process.hrtime.bigint()}`
const onDisk = (m) => existsSync(LOG_FILE) && readFileSync(LOG_FILE, 'utf8').includes(m)

test('BY DEFAULT a line is not yet on disk when the call returns — the loss this fixes', () => {
    // Not a complaint about the default: async is right for a server that logs on every request.
    // It is only wrong for the handful of lines written while the process is on its way out.
    const m = marker('async')
    logger.info('[loggerSync.test]', m)
    assert.equal(onDisk(m), false, 'appendFile resolved synchronously — this test can no longer prove anything')
})

test('AFTER switching, the line is on disk before the call returns', () => {
    const m = marker('sync')

    switchToSyncLogging()
    logger.info('[loggerSync.test]', m)

    // No await, no tick, no flush — exactly the conditions process.exit() imposes.
    assert.equal(onDisk(m), true, 'still buffered — process.exit() would drop the shutdown tail')
})

test('and it STAYS switched, so nothing re-buffers mid-shutdown', () => {
    const m = marker('still-sync')
    logger.info('[loggerSync.test]', m)
    assert.equal(onDisk(m), true)
})
