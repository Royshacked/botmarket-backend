#!/usr/bin/env node
// Live check of the unified chat's chain and channel (plan phase 5e) — real models, real database.
//
//   node scripts/drive-session-chain.mjs [username, default roy_shacked]
//
// On THIS process's database (axl_dev on the laptop; it refuses `test`), as the given user:
//   1. a fresh session; a recording socket registered in the WebSocket registry for the user, so every
//      frame the session pushes is captured exactly as a browser would receive it
//   2. Axl turn through the turn engine (startTurn) → routes to the trade desk; frames arrive
//   3. Argus single-pick turn → its pick is handed to Mentor AUTOMATICALLY (if Argus declines to pick,
//      the drive hands the chain a pick itself and says so — Mentor's chain turn is a real model call
//      either way) → Mentor's chain turn runs → it stops at Mentor's call
//   4. a restart: the chain is marked running and swept → "I was interrupted — continue?"; Continue re-runs
//   5. a seal → `session_removed` arrives
//   6. clean up
// A few cents of model spend. Exits 1 on the first broken expectation.

import dns from 'node:dns'
import { config } from '../services/config.js'

if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, getDbName, closeDb } = await import('../providers/mongodb.provider.js')
const { roleOf } = await import('../api/user/user.model.js')
const { _register, _unregister } = await import('../api/chat/chatWs.js')
const { sessionService } = await import('../services/session.service.js')
const { agentContextService } = await import('../services/agentContext.service.js')
const { startTurn, chain } = await import('../services/desks/turns.js')
const { sealing } = await import('../services/desks/seal.js')

const C = { dim: '\x1b[2m', ok: '\x1b[32m', bad: '\x1b[31m', head: '\x1b[36m', off: '\x1b[0m' }
const step = (s) => console.log(`\n${C.head}── ${s}${C.off}`)
let failed = false
function expect(cond, what) {
    console.log(`${cond ? C.ok + '  ✓' : C.bad + '  ✗'} ${what}${C.off}`)
    if (!cond) failed = true
    return cond
}

// The recording socket: OPEN, and every frame parsed into `frames`.
const frames = []
const socket = { readyState: 1, send: (f) => frames.push(JSON.parse(f)), ping() {}, terminate() {} }
const waitFor = async (pred, what, ms = 240_000) => {
    const end = Date.now() + ms
    for (;;) {
        const hit = frames.find(pred)
        if (hit) return hit
        if (Date.now() > end) { expect(false, `timed out waiting for ${what}`); return null }
        await new Promise(r => setTimeout(r, 500))
    }
}
const turnDone = (turnId) => waitFor(f => f.event === 'session_turn' && f.data.turnId === turnId && ['done', 'stopped', 'refused', 'error'].includes(f.data.status), `turn ${turnId}`)

async function run() {
    const [username = 'roy_shacked'] = process.argv.slice(2)
    if (getDbName() === 'test') { console.error('refusing to run on the production database `test`'); process.exitCode = 2; return }
    const db = await getDb()
    const u  = await db.collection('users').findOne({ username }, { projection: { _id: 0, id: 1, role: 1, isAdmin: 1 } })
    if (!u) { console.error(`no user "${username}" in ${getDbName()}`); process.exitCode = 2; return }
    // The app's user id is the document's `id` (what the login token carries), not Mongo's _id.
    const user = { _id: String(u.id), role: roleOf(u) }
    console.log(`${C.dim}db=${getDbName()} user=${username} (${user.role})${C.off}`)
    globalThis.__driveUser = user._id
    _register(user._id, socket)

    step('1. a fresh session, a recording socket')
    const s = await sessionService.startNew({ userId: user._id, scope: 'main' })
    const sid = s.sessionId
    expect(!!sid, `session ${sid}`)

    step('2. Axl, through the turn engine')
    const a = await startTurn({ user, sessionId: sid, text: 'I want to build a long swing trade on NVDA. Take me to the desk that builds trades.', turnId: `drive_axl_${Date.now()}` })
    expect(a.agent === 'axl', 'answered at once by Axl')
    const aDone = await turnDone(a.turnId)
    expect(aDone?.data.status === 'done', 'Axl\'s turn reported done on the channel')
    expect(frames.some(f => f.event === 'session_delta' && f.data.turnId === a.turnId && f.data.type === 'token'), 'its tokens streamed as session_delta frames')
    expect(frames.some(f => f.event === 'session_message' && f.data.message.agent === 'axl' && f.data.message.role === 'assistant'), 'its reply arrived as a session_message')
    const route = aDone?.data.payload?.route
    const h1 = await sessionService.get({ sessionId: sid, userId: user._id })
    expect(route === 'trade' || route === 'assist', `routed to a build desk (${route})`)
    expect(frames.some(f => f.event === 'session_state' && f.data.floor === h1.floor), `the floor move (${h1.floor}) arrived as session_state`)

    step('3. the chain: Argus picks → Mentor builds, on its own')
    if (h1.floor === 'scanner') {
        const b = await startTurn({ user, sessionId: sid, text: aDone.data.payload.opening || 'Validate NVDA for a long swing and hand it to Mentor.', turnId: `drive_argus_${Date.now()}` })
        const bDone = await turnDone(b.turnId)
        expect(bDone?.data.status === 'done', 'Argus\'s turn done')
        if (!bDone?.data.payload?.kairos_pick) {
            console.log(`${C.dim}  Argus did not pick (its call) — handing the chain a pick to exercise Mentor's chain turn${C.off}`)
            await chain.afterTurn({ user, sessionId: sid, agent: 'scanner', origin: 'user', out: { payload: { reply: 'NVDA', kairos_pick: { ticker: 'NVDA', direction: 'long', thesis: 'Testing support near its 50-day.' } } } })
        }
    } else {
        console.log(`${C.dim}  Axl went straight to Mentor — handing the chain a pick from Argus to exercise the hop${C.off}`)
        await sessionService.setAgentState({ sessionId: sid, userId: user._id, agent: 'scanner', state: { handoff: true, handoffTo: 'mentor' } })
        await chain.afterTurn({ user, sessionId: sid, agent: 'scanner', origin: 'user', out: { payload: { reply: 'NVDA', kairos_pick: { ticker: 'NVDA', direction: 'long', thesis: 'Testing support near its 50-day.' } } } })
    }
    const hand = await waitFor(f => f.event === 'session_message' && f.data.message.kind === 'handoff' && f.data.message.to === 'mentor', 'the hand-off to Mentor')
    expect(!!hand, `hand-off message: "${hand?.data.message.content.slice(0, 90)}…"`)
    const mStart = await waitFor(f => f.event === 'session_turn' && f.data.agent === 'mentor' && f.data.status === 'started' && f.data.origin === 'chain', 'Mentor\'s chain turn to start')
    const mDone  = mStart ? await turnDone(mStart.data.turnId) : null
    expect(mDone?.data.status === 'done', 'Mentor\'s chain turn ran with no user message, and finished')
    console.log(`${C.dim}${(mDone?.data.payload?.reply ?? '').slice(0, 280)}${C.off}`)
    await new Promise(r => setTimeout(r, 1500))
    const h2 = await sessionService.get({ sessionId: sid, userId: user._id })
    expect(['waiting', 'awaiting', 'done'].includes(h2.chain?.status), `the chain stopped for the user (${h2.chain?.status})`)

    step('4. a restart cuts the chain off → it asks; Continue re-runs')
    await sessionService.setChain({ sessionId: sid, userId: user._id, chain: { ...h2.chain, status: 'running', current: { to: 'mentor', input: {}, step: h2.chain.steps } } })
    const swept = await chain.sweep()
    expect(swept >= 1, `the sweep paused ${swept} chain(s)`)
    const ask = await waitFor(f => f.event === 'session_message' && f.data.message.content === 'I was interrupted — continue?', 'the interrupted question')
    expect(!!ask, '"I was interrupted — continue?" arrived')
    const resumed = await chain.resume({ user, sessionId: sid, choice: 'continue' })
    expect(resumed.ok === true, 'Continue accepted')
    const rStart = await waitFor(f => f.event === 'session_turn' && f.data.agent === 'mentor' && f.data.status === 'started' && f.data.turnId.includes('_r'), 'the re-run to start')
    const rDone  = rStart ? await turnDone(rStart.data.turnId) : null
    expect(rDone?.data.status === 'done', 'the cut step ran again and finished')

    step('5. a seal → session_removed')
    const sealed = await sealing.sealFromSession({ userId: user._id, sessionId: sid, agent: 'mentor', kind: 'setup', entityIds: [`drive_${Date.now()}`], name: 'NVDA setup (chain drive)' })
    expect(sealed.sealed === 1, `sealed ${sealed.turns} turn(s)`)
    const removed = await waitFor(f => f.event === 'session_removed' && f.data.sessionId === sid, 'session_removed')
    expect(removed?.data.seqs.length > 0, `session_removed carried ${removed?.data.seqs.length} seq(s)`)

    step('6. clean up')
    await agentContextService.removeFor({ kind: 'setup', entityId: sealed.line?.ref?.ids?.[0] })
    const fresh = await sessionService.startNew({ userId: user._id, scope: 'main' })
    expect(fresh.sessionId !== sid, 'drive session archived')
    console.log(`${C.dim}frames captured: ${frames.length} (${[...new Set(frames.map(f => f.event))].join(', ')})${C.off}`)
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
