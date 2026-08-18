import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPollLoop } from '../../monitoring/pollLoop.js'

// `stop()` awaiting the tick already in flight is a shutdown property, not a scheduling one.
// Clearing the interval only prevents the NEXT tick; it says nothing about the one part-way
// through a Mongo write or a broker round trip. Without the await, shutdown walks on to
// `closeDb()` and pulls the connection out from under it — the precise "killed mid-order" this
// path exists to prevent.

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('stop() WAITS for the tick already running', async () => {
    const gate  = defer()
    let finished = false

    const loop = createPollLoop({
        intervalMs: 10_000,
        eager: true,                      // one tick starts immediately
        tick: async () => { await gate.promise; finished = true },
        log: '[test]',
    })
    loop.start()

    let stopped = false
    const stopping = loop.stop().then(() => { stopped = true })

    // Let any un-awaited microtasks drain. If stop() did not await, it has already resolved.
    await new Promise(r => setImmediate(r))
    assert.equal(stopped, false, 'stop() resolved while the tick was still running')
    assert.equal(finished, false)

    gate.resolve()
    await stopping
    assert.equal(finished, true, 'the tick got to finish before stop() resolved')
})

test('stop() resolves immediately when nothing is in flight, and is idempotent', async () => {
    const loop = createPollLoop({ intervalMs: 10_000, tick: async () => {}, log: '[test]' })
    loop.start()
    await loop.stop()
    await loop.stop()          // second call must not hang or throw
})

test('stop() before start() is safe', async () => {
    const loop = createPollLoop({ intervalMs: 10_000, tick: async () => {}, log: '[test]' })
    await loop.stop()
})

test('a tick that THROWS still releases stop() — a bad tick cannot wedge shutdown', async () => {
    const gate = defer()
    const loop = createPollLoop({
        intervalMs: 10_000,
        eager: true,
        tick: async () => { await gate.promise; throw new Error('boom') },
        log: '[test]',
    })
    loop.start()

    const stopping = loop.stop()
    gate.resolve()
    await stopping             // pollLoop catches inside the tick, so this resolves rather than rejects
})

test('the single-flight guard still holds — a slow tick is not stacked', async () => {
    const gate = defer()
    let entered = 0

    const loop = createPollLoop({
        intervalMs: 1,
        eager: true,
        tick: async () => { entered++; await gate.promise },
        log: '[test]',
    })
    loop.start()
    await new Promise(r => setTimeout(r, 20))   // several intervals elapse while tick 1 hangs

    assert.equal(entered, 1, 'later ticks were skipped, not queued')
    gate.resolve()
    await loop.stop()
})
