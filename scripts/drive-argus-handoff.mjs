#!/usr/bin/env node
// Live check of Argus's ONLY remaining job (2026-11-10): Mentor → Argus → Mentor, real models, real database.
//
//   node scripts/drive-argus-handoff.mjs [username, default roy_shacked]
//
// Argus's list-building chat was archived on 2026-11-09; what stays is the single pick. Nothing is stubbed here
// (drive-session-chain.mjs hands the chain a pick itself): Mentor must route on its own, Argus must emit
// <argus_pick> on its own opening turn, and the chain must carry it back to Mentor with no user message.
//
// On THIS process's database (axl_dev on the laptop; it refuses `test`), as the given user:
//   1. a fresh session with Mentor on the floor; a recording socket captures every frame
//   2. the user tells Mentor they have no name → Mentor routes to Argus (`scan`)
//   3. Argus's opening turn runs by itself and emits a pick in hand-off mode
//   4. the hand-off message reaches Mentor and Mentor's chain turn runs and finishes
//   5. clean up (the session is archived)
// A few cents of model spend. Exits 1 on the first broken expectation.

import dns from 'node:dns'
import { config } from '../services/config.js'

if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, getDbName, closeDb } = await import('../providers/mongodb.provider.js')
const { roleOf } = await import('../api/user/user.model.js')
const { _register, _unregister } = await import('../api/chat/chatWs.js')
const { sessionService } = await import('../services/session.service.js')
const { startTurn } = await import('../services/desks/turns.js')

const C = { dim: '\x1b[2m', ok: '\x1b[32m', bad: '\x1b[31m', head: '\x1b[36m', off: '\x1b[0m' }
const step = (s) => console.log(`\n${C.head}── ${s}${C.off}`)
let failed = false
function expect(cond, what) {
    console.log(`${cond ? C.ok + '  ✓' : C.bad + '  ✗'} ${what}${C.off}`)
    if (!cond) failed = true
    return cond
}

const frames = []
const socket = { readyState: 1, send: (f) => frames.push(JSON.parse(f)), ping() {}, terminate() {} }
const waitFor = async (pred, what, ms = 300_000) => {
    const end = Date.now() + ms
    for (;;) {
        const hit = frames.find(pred)
        if (hit) return hit
        if (Date.now() > end) { expect(false, `timed out waiting for ${what}`); return null }
        await new Promise(r => setTimeout(r, 500))
    }
}
const DONE = ['done', 'stopped', 'refused', 'error']
const turnDone = (turnId) => waitFor(f => f.event === 'session_turn' && f.data.turnId === turnId && DONE.includes(f.data.status), `turn ${turnId}`)
// Only the 'started' frame carries `origin`; the closing frame is matched on its turnId.
const doneFor = async (agent, origin) => {
    const started = await waitFor(f => f.event === 'session_turn' && f.data.agent === agent && f.data.origin === origin && f.data.status === 'started', `${agent}'s ${origin} turn to start`)
    return started ? turnDone(started.data.turnId) : null
}

async function run() {
    const [username = 'roy_shacked'] = process.argv.slice(2)
    if (getDbName() === 'test') { console.error('refusing to run on the production database `test`'); process.exitCode = 2; return }
    const db = await getDb()
    const u  = await db.collection('users').findOne({ username }, { projection: { _id: 0, id: 1, role: 1, isAdmin: 1 } })
    if (!u) { console.error(`no user "${username}" in ${getDbName()}`); process.exitCode = 2; return }
    const user = { _id: String(u.id), role: roleOf(u) }
    console.log(`${C.dim}db=${getDbName()} user=${username} (${user.role})${C.off}`)
    globalThis.__driveUser = user._id
    _register(user._id, socket)

    step('1. a fresh session, Mentor on the floor')
    const s = await sessionService.startNew({ userId: user._id, scope: 'main' })
    const sid = s.sessionId
    await sessionService.setFloor({ sessionId: sid, userId: user._id, agent: 'mentor' })
    const h0 = await sessionService.get({ sessionId: sid, userId: user._id })
    expect(h0.floor === 'mentor', `floor is ${h0.floor}`)

    step('2. no name → Mentor routes to Argus')
    const m = await startTurn({ user, sessionId: sid, agent: 'mentor', text: "I want a long swing trade but I don't have a stock in mind. Find me one.", turnId: `drive_mentor_${Date.now()}` })
    expect(m.agent === 'mentor', `answered by ${m.agent}`)
    const mDone = await turnDone(m.turnId)
    expect(mDone?.data.status === 'done', `Mentor's turn ${mDone?.data.status}`)
    console.log(`${C.dim}${(mDone?.data.payload?.reply ?? '').slice(0, 240)}${C.off}`)
    const route = mDone?.data.payload?.route
    if (!expect(route === 'scan', `Mentor routed to the scan desk (${route})`)) return

    step('3. Argus picks ONE name — answering him as a user would, at most three times')
    let aDone = await doneFor('scanner', 'opening')
    expect(aDone?.data.status === 'done', `Argus's opening turn ${aDone?.data.status}`)
    // Argus's prompt gates its phases: he may ask the angle, then show a shortlist and ask before validating. The drive
    // answers as a user would, and COUNTS the turns it took — that number is the finding, not a pass condition.
    const ANSWERS = ['Momentum — your pick, just find me one.', 'Yes — validate them and give me the single best one.', 'Just pick one.']
    let answered = 0
    while (!aDone?.data.payload?.argus_pick && answered < ANSWERS.length) {
        console.log(`${C.dim}  Argus, no pick yet: ${(aDone?.data.payload?.reply ?? '').replace(/\s+/g, ' ').slice(0, 200)}${C.off}`)
        const ans = await startTurn({ user, sessionId: sid, agent: 'scanner', text: ANSWERS[answered++], turnId: `drive_answer_${Date.now()}` })
        aDone = await turnDone(ans.turnId)
        expect(aDone?.data.status === 'done', `Argus's turn after answer ${answered} ${aDone?.data.status}`)
    }
    const pick = aDone?.data.payload?.argus_pick
    expect(!!pick?.ticker, `argus_pick: ${pick ? `${pick.ticker} ${pick.direction ?? ''} — ${(pick.thesis ?? '').slice(0, 100)}` : 'none'}`)
    expect(aDone?.data.payload?.kairos_pick === undefined, 'no kairos_pick field on the wire')
    console.log(`${C.dim}${(aDone?.data.payload?.reply ?? '').slice(0, 240)}${C.off}`)

    step('4. the chain hands it back to Mentor')
    const hand = await waitFor(f => f.event === 'session_message' && f.data.message.kind === 'handoff' && f.data.message.to === 'mentor', 'the hand-off to Mentor')
    expect(!!hand, `hand-off: "${hand?.data.message.content.slice(0, 120)}…"`)
    const back = await doneFor('mentor', 'chain')
    expect(back?.data.status === 'done', `Mentor's chain turn ${back?.data.status}, no user message`)
    const reply = back?.data.payload?.reply ?? ''
    console.log(`${C.dim}${reply.slice(0, 300)}${C.off}`)
    console.log(`${C.dim}  answers it took: ${answered}${C.off}`)
    if (pick?.ticker) expect(reply.toUpperCase().includes(pick.ticker.toUpperCase()), `Mentor's reply names ${pick.ticker}`)

    step('5. clean up')
    const fresh = await sessionService.startNew({ userId: user._id, scope: 'main' })
    expect(fresh.sessionId !== sid, 'drive session archived')
    console.log(`${C.dim}frames captured: ${frames.length}${C.off}`)
}

run()
    .catch(err => { console.error(`${C.bad}failed:${C.off}`, err?.stack ?? err); failed = true })
    .finally(async () => {
        try { _unregister(String(globalThis.__driveUser ?? ''), socket) } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 1000))
        await closeDb()
        console.log(failed ? `\n${C.bad}DRIVE FAILED${C.off}` : `\n${C.ok}DRIVE PASSED${C.off}`)
        process.exit(failed ? 1 : 0)
    })
