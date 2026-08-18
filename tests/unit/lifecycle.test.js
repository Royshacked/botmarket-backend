import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startLoop, stopLoops, loopNames, markDraining, isDraining, _reset }
    from '../../services/lifecycle.service.js'

// The registry exists so `stopLoops()` can be written at all: every monitor already exported a
// `stop()` that nothing in the repository called, so SIGTERM left all eleven running while the HTTP
// server drained. What these lock is the part that makes it trustworthy — a shutdown path that
// throws half way through is worse than none, because it strands an arbitrary subset of the fleet
// while the caller believes it is done.

const fake = (log, name, { failStart = false, failStop = false } = {}) => ({
    start() { if (failStart) throw new Error(`${name} start boom`); log.push(`start:${name}`) },
    stop()  { if (failStop)  throw new Error(`${name} stop boom`);  log.push(`stop:${name}`) },
})

beforeEach(() => _reset())

test('a started loop is registered, and starting it actually starts it', () => {
    const log = []
    assert.equal(startLoop('alpha', fake(log, 'alpha')), true)
    assert.deepEqual(log, ['start:alpha'])
    assert.deepEqual(loopNames(), ['alpha'])
})

test('loops stop in REVERSE start order', async () => {
    // Mirrors how the boot built them up, so a loop that may depend on an earlier one goes first.
    const log = []
    startLoop('a', fake(log, 'a'))
    startLoop('b', fake(log, 'b'))
    startLoop('c', fake(log, 'c'))

    const stopped = await stopLoops()

    assert.deepEqual(stopped, ['c', 'b', 'a'])
    assert.deepEqual(log.filter(l => l.startsWith('stop')), ['stop:c', 'stop:b', 'stop:a'])
})

test('one loop that throws on stop does NOT strand the others', async () => {
    // THE contract. Without it a single bad stop() leaves everything registered after it running,
    // silently, in a process that is about to exit.
    const log = []
    startLoop('good1', fake(log, 'good1'))
    startLoop('bad',   fake(log, 'bad', { failStop: true }))
    startLoop('good2', fake(log, 'good2'))

    const stopped = await stopLoops()

    assert.deepEqual(stopped, ['good2', 'good1'], 'the thrower is absent, both survivors stopped')
    assert.deepEqual(loopNames(), [], 'and the registry is drained either way')
})

test('a loop that throws on START is not registered and does not take the boot down', () => {
    const log = []
    assert.equal(startLoop('broken', fake(log, 'broken', { failStart: true })), false)
    assert.deepEqual(loopNames(), [], 'never registered — stopping it would throw a second time')
})

test('something that is not a loop is refused rather than half-registered', () => {
    assert.equal(startLoop('nope', { start() {} }), false, 'no stop() — unstoppable by definition')
    assert.equal(startLoop('nah', null), false)
    assert.deepEqual(loopNames(), [])
})

test('stopLoops is idempotent — both signal handlers may call it blind', async () => {
    const log = []
    startLoop('a', fake(log, 'a'))

    assert.deepEqual(await stopLoops(), ['a'])
    assert.deepEqual(await stopLoops(), [], 'second call is a no-op, not a second stop')
    assert.equal(log.filter(l => l === 'stop:a').length, 1)
})

test('stopLoops on an empty registry resolves rather than throwing', async () => {
    assert.deepEqual(await stopLoops(), [])
})

test('draining is one-way: a process shutting down never becomes ready again', () => {
    assert.equal(isDraining(), false)
    markDraining()
    assert.equal(isDraining(), true)
    markDraining()
    assert.equal(isDraining(), true)
})
