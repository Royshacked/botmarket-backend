import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEchoMapJobs, mappingLine, doneOpening } from '../../services/echoMapJobs.service.js'

// The event analyst's map in the background (docs/design/modes-and-builders.md step 2): the chat's status line while it
// maps, then ONE turn for the event analyst to say what it found.

function rig({ run = async () => ({ status: 'scored' }) } = {}) {
    const waiting = [], turns = []
    const sessions = { setWaiting: async (x) => { waiting.push(x); return { ok: true } } }
    const jobs = makeEchoMapJobs({ sessions, pipeline: { run }, runTurn: async (x) => { turns.push(x) } })
    return { jobs, waiting, turns }
}

test('it starts at once: the line goes up, the pipeline runs, the line comes down, the event analyst gets its turn', async () => {
    let release
    const gate = new Promise(r => { release = r })
    const { jobs, waiting, turns } = rig({ run: async () => { await gate; return { status: 'scored' } } })
    const { started, done } = jobs.start({ userId: 'u1', sessionId: 's1', doc: { _id: 'ev_1' }, label: '"Anthropic IPO"' })
    assert.equal(started, true)
    await new Promise(r => setTimeout(r, 5))
    assert.equal(turns.length, 0, 'nothing announced while it maps')
    assert.deepEqual(waiting[0].entry.text, mappingLine('"Anthropic IPO"'))
    assert.equal(waiting[0].key, 'echo|ev_1')
    release()
    await done
    assert.deepEqual(waiting.map(w => w.entry === null), [false, true], 'the line cleared when it settled')
    assert.equal(turns.length, 1)
    assert.deepEqual([turns[0].agent, turns[0].origin, turns[0].sessionId, turns[0].user._id], ['echo', 'opening', 's1', 'u1'])
    assert.match(turns[0].text, /^\[App note, not the user's words: the map of event ev_1 that you started is done\. Read it with get_event_map/)
})

test('the same event asked twice maps once', async () => {
    let runs = 0
    const { jobs } = rig({ run: async () => { runs++; await new Promise(r => setTimeout(r, 5)); return { status: 'scored' } } })
    const a = jobs.start({ userId: 'u1', sessionId: 's1', doc: { _id: 'ev_1' }, label: 'x' })
    const b = jobs.start({ userId: 'u1', sessionId: 's1', doc: { _id: 'ev_1' }, label: 'x' })
    assert.deepEqual([a.started, b.started], [true, false])
    await a.done
    assert.equal(runs, 1)
})

test('a failed or stopped map is still announced — the event analyst says so', async () => {
    const { jobs, turns } = rig({ run: async () => { throw new Error('EDGAR down') } })
    await jobs.start({ userId: 'u1', sessionId: 's1', doc: { _id: 'ev_2' }, label: 'x' }).done
    assert.match(turns[0].text, /It stopped: EDGAR down\./)
    assert.match(doneOpening('ev_3', { stoppedAt: 'score', reason: 'the model failed' }), /It stopped at score: the model failed\./)
    assert.doesNotMatch(doneOpening('ev_3', { stoppedAt: 'check', wait: true, reason: 'the day-5 close is not in yet' }), /stopped/, 'waiting for the close is not a failure')
})
