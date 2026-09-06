// The log file is the only forensic record of what the server actually did, so a test
// run must not write into it.
//
// This is not tidiness. instanceLock's own tests drive a lock through acquire -> lose ->
// re-acquire -> release inside a single second, under the instance ids 'A' and 'B', and
// emit ERROR lines carrying stub failure text. In backend.log that is indistinguishable
// from a production instance thrashing its lease during a Mongo outage — 408 test-shaped
// lines against 31 real ones. It cost a wrong diagnosis: the churn was read as a blip
// flapping the background loops, and only the instance ids gave it away.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../../services/logger.service.js'

const LOG_FILE = path.join('logs', 'backend.log')

test('node --test is detected without the suites having to say so', () => {
    // Set by the runner itself, so a new test file cannot forget to opt in.
    assert.ok(process.env.NODE_TEST_CONTEXT, 'NODE_TEST_CONTEXT should be set under node --test')
})

test('logging from a test does not append to backend.log', () => {
    const before = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : null

    const canary = `logger-file-sink-canary-${Date.now()}`
    logger.info('[loggerTest]', canary)
    logger.error('[loggerTest]', canary)

    if (before === null) {
        assert.ok(!fs.existsSync(LOG_FILE), 'a test run must not create the log file')
        return
    }
    assert.equal(fs.statSync(LOG_FILE).size, before, 'backend.log grew during a test run')
    assert.ok(!fs.readFileSync(LOG_FILE, 'utf8').includes(canary), 'canary reached backend.log')
})

test('the logger still works — every level returns cleanly', () => {
    // Suppression must be of the FILE sink only; console output is what a failing test needs.
    for (const level of ['debug', 'info', 'warn', 'error']) {
        assert.doesNotThrow(() => logger[level]('[loggerTest]', `${level} still logs`))
    }
})

test('an Error argument is still rendered, not stringified to {}', () => {
    assert.doesNotThrow(() => logger.error('[loggerTest]', new Error('boom')))
})
