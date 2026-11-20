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
    assert.deepEqual([turns[0].agent, turns[0].origin, turns[0].sessionId, turns[0].user._id], ['echo', 'background', 's1', 'u1'])
    assert.match(turns[0].text, /^\[App note, not the user's words: the map of event ev_1 that you started is done\. Read it with get_event_map/)
})

test('the same event asked twice maps once — and a second chat that asked meanwhile gets its own line and announcement (CR)', async () => {
    let runs = 0
    const { jobs, waiting, turns } = rig({ run: async () => { runs++; await new Promise(r => setTimeout(r, 5)); return { status: 'scored' } } })
    const a = jobs.start({ userId: 'u1', sessionId: 's1', doc: { _id: 'ev_1' }, label: 'x' })
    const b = jobs.start({ userId: 'u1', sessionId: 's1', doc: { _id: 'ev_1' }, label: 'x' })
    const c = jobs.start({ userId: 'u2', sessionId: 's2', doc: { _id: 'ev_1' }, label: 'x' })
    assert.deepEqual([a.started, b.started, c.started], [true, false, false])
    await a.done
    assert.equal(runs, 1)
    assert.deepEqual(turns.map(t => t.sessionId), ['s1', 's2'], 'each chat that asked is told once')
    assert.deepEqual(waiting.filter(w => w.entry === null).map(w => w.sessionId), ['s1', 's2'], 'each line comes down')
})

test('a failed or stopped map is still announced — the event analyst says so', async () => {
    const { jobs, turns } = rig({ run: async () => { throw new Error('EDGAR down') } })
    await jobs.start({ userId: 'u1', sessionId: 's1', doc: { _id: 'ev_2' }, label: 'x' }).done
    assert.match(turns[0].text, /It stopped: EDGAR down\./)
    assert.match(doneOpening('ev_3', { stoppedAt: 'score', reason: 'the model failed' }), /It stopped at score: the model failed\./)
    assert.doesNotMatch(doneOpening('ev_3', { stoppedAt: 'check', wait: true, reason: 'the day-5 close is not in yet' }), /stopped/, 'waiting for the close is not a failure')
})

test('another run holds the event (the hourly pipeline): it waits for THAT run to finish before announcing — never a half map', async () => {
    const states = [{ status: 'mapped', runningUntil: 'x' }, { status: 'scored' }]
    const turns = []
    const jobs = makeEchoMapJobs({
        sessions: { setWaiting: async () => ({ ok: true }) },
        pipeline: { run: async () => ({ status: 'framed', stoppedAt: 'claim', reason: 'another run holds it', wait: true }) },
        events: { get: async () => states.shift() ?? { status: 'scored' } },
        runTurn: async (x) => { turns.push(x) }, sleep: async () => {}, pollMs: 1, maxWaitMs: 10,
    })
    const r = await jobs.start({ userId: 'u1', sessionId: 's1', doc: { _id: 'ev_4' }, label: 'x' }).done
    assert.deepEqual(r, { status: 'scored' })
    assert.doesNotMatch(turns[0].text, /stopped/)
})

test('the boot sweep picks up a map a restart cut off: its claim released, mapped again; a finished one announced; a lost one said', async () => {
    const { memDb } = await import('../helpers/memDb.js')
    const { makeSessionService } = await import('../../services/session.service.js')
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const s = await sessions.getActive({ userId: 'u1' })
    const line = (eventId, label) => ({ kind: 'echo_map', text: 'mapping', eventId, label, since: Date.now() })
    await sessions.setWaiting({ sessionId: s.sessionId, userId: 'u1', key: 'echo|ev_cut', entry: line('ev_cut', '"cut"') })
    await sessions.setWaiting({ sessionId: s.sessionId, userId: 'u1', key: 'echo|ev_done', entry: line('ev_done', '"done"') })
    await sessions.setWaiting({ sessionId: s.sessionId, userId: 'u1', key: 'echo|ev_gone', entry: line('ev_gone', '"gone"') })
    await sessions.setWaiting({ sessionId: s.sessionId, userId: 'u1', key: 'NVDA|coverage', entry: { symbol: 'NVDA', kind: 'coverage', since: Date.now() } })
    const docs = { ev_cut: { _id: 'ev_cut', status: 'mapped' }, ev_done: { _id: 'ev_done', status: 'scored' } }
    const released = [], ran = [], turns = []
    const jobs = makeEchoMapJobs({
        sessions,
        events: { get: async (id) => docs[id] ?? null, advance: async (id, status) => { released.push(`${id}:${status}`) } },
        pipeline: { run: async (doc) => { ran.push(doc._id); return { status: 'scored' } } },
        runTurn: async (x) => { turns.push(x.text) },
    })
    assert.equal(await jobs.sweep(), 3)
    await new Promise(r => setTimeout(r, 20))
    assert.deepEqual(released, ['ev_cut:mapped'])
    assert.deepEqual(ran, ['ev_cut'])
    assert.equal(turns.length, 2, 'the restarted one and the finished one are announced')
    assert.ok(turns.every(t => /that you started is done/.test(t)))
    const rows = await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })
    assert.deepEqual(rows.map(r => r.content), ['The map of "gone" was cut off by a restart and could not be picked up again — ask me to map it again.'])
    const left = (await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).waiting
    assert.deepEqual(Object.keys(left), ['NVDA|coverage'], "the analyst's read line is not the sweep's")
})
