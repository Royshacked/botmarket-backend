#!/usr/bin/env node
// Live check of the unified chat's session turn (plan phase 4 §6.1 step 7) — real models, real database.
//
//   node scripts/drive-session-turn.mjs [username, default roy_shacked]
//
// Runs on THIS process's database (DB_NAME — axl_dev on the laptop; never point it at `test`):
//   1. a fresh 'main' session for the user (the running one is archived — this is a dev database)
//   2. Axl turn  → it should route to Mentor; the floor moves
//   3. the entry agent (Mentor, or Argus for the composite trade desk) answers from ITS conversation only
//   4. seal its turns onto a THROWAWAY entity id → its rows leave the timeline, one sealed line
//   5. reopen that "setup" for edit → the card line, the floor, the editing marker
//   6. a turn while editing → the sealed context is in what it reads
//   7. clean up: the throwaway context removed, the session archived
// A few cents of model spend (three turns on the house model). Exits 1 on the first broken expectation.

import dns from 'node:dns'
import { config } from '../services/config.js'

// Mongo's SRV lookup fails on this laptop's default resolver (the DNS pin every script here carries).
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, getDbName, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')
const { agentContextService } = await import('../services/agentContext.service.js')
const { sessionTurn } = await import('../services/desks/sessionTurn.js')
const { sealing } = await import('../services/desks/seal.js')
const { deskOf } = await import('../services/desks/registry.js')

const C = { dim: '\x1b[2m', ok: '\x1b[32m', bad: '\x1b[31m', head: '\x1b[36m', off: '\x1b[0m' }
const step = (s) => console.log(`\n${C.head}── ${s}${C.off}`)
let failed = false
function expect(cond, what) {
    console.log(`${cond ? C.ok + '  ✓' : C.bad + '  ✗'} ${what}${C.off}`)
    if (!cond) failed = true
    return cond
}

async function run() {
    const [username = 'roy_shacked'] = process.argv.slice(2)
    const dbName = getDbName()
    if (dbName === 'test') { console.error('refusing to run on the production database `test`'); process.exitCode = 2; return }
    const db   = await getDb()
    const u    = await db.collection('users').findOne({ username }, { projection: { _id: 1, role: 1 } })
    if (!u) { console.error(`no user "${username}" in ${getDbName()}`); process.exitCode = 2; return }
    const user = { _id: String(u._id), role: u.role ?? 'user' }
    console.log(`${C.dim}db=${getDbName()} user=${username} (${user.role})${C.off}`)
    const emit = () => {}

    step('1. a fresh session')
    const s = await sessionService.startNew({ userId: user._id, scope: 'main' })
    const sid = s.sessionId
    expect(!!sid && s.status === 'active', `active session ${sid}`)

    step('2. Axl: ask to build a trade')
    const t1 = await sessionTurn({ user, sessionId: sid, agent: 'axl', text: 'I want to build a swing trade on NVDA. Take me to the desk that builds setups.', emit })
    console.log(`${C.dim}${t1.payload?.reply?.slice(0, 300)}${C.off}`)
    // Either door is right: `assist` lands on Mentor; `trade` (the composite) lands on Argus in
    // single-pick mode, which validates the name before Mentor builds.
    const route = t1.payload?.route
    expect(route === 'assist' || route === 'trade', `Axl routed to a build desk (got ${route ?? 'none'})`)
    const h1 = await sessionService.get({ sessionId: sid, userId: user._id })
    const floor = h1.floor
    expect(floor === (route === 'trade' ? 'scanner' : 'mentor'), `floor moved to the desk's entry agent (got ${floor})`)
    if (route === 'trade') expect(h1.agentState?.scanner?.handoff === true && h1.agentState.scanner.handoffTo === 'mentor', 'Argus is preset to pick ONE name for Mentor')
    const kind  = deskOf(floor)?.entityKind
    const brand = deskOf(floor)?.brand

    step(`3. ${brand}: opens on Axl's opening`)
    const opening = t1.payload?.opening || 'NVDA swing trade — help me build the setup.'
    const t2 = await sessionTurn({ user, sessionId: sid, agent: floor, text: opening, emit })
    console.log(`${C.dim}${t2.payload?.reply?.slice(0, 300)}${C.off}`)
    expect(!!t2.payload?.reply, `${brand} replied`)
    const h2 = await sessionService.get({ sessionId: sid, userId: user._id })
    expect(!!h2.agentState?.[floor], `${brand}'s working state is stored on the session`)

    step(`4. seal ${brand}'s turns onto a throwaway ${kind}`)
    const fakeId = `drive_${Date.now()}`
    const sealed = await sealing.sealFromSession({ userId: user._id, sessionId: sid, agent: floor, kind, entityIds: [fakeId], name: `NVDA ${kind} (drive test)` })
    expect(sealed.sealed === 1 && sealed.turns >= 2, `sealed ${sealed.turns} turn(s) onto ${fakeId}`)
    const after = await sessionService.messagesSince({ sessionId: sid, userId: user._id })
    expect(!after.some(m => m.agent === floor && m.kind === 'msg'), `${brand}'s turns left the timeline`)
    expect(after.at(-1)?.kind === 'sealed', `one sealed line: "${after.at(-1)?.content}"`)

    step('5. reopen it for edit')
    const entity = kind === 'scan'
        ? { id: fakeId, thesis: 'NVDA (drive test)', candidates: [{ ticker: 'NVDA' }] }
        : { id: fakeId, asset: 'NVDA', direction: 'long' }
    const opened = await sealing.openForEdit({ userId: user._id, sessionId: sid, kind, entity, name: `NVDA ${kind} (drive test)` })
    expect(opened.agent === floor && opened.hasContext, 'reopened with its sealed context')
    console.log(`${C.dim}${opened.line?.content}${C.off}`)

    step(`6. ${brand} turn while editing`)
    const t3 = await sessionTurn({ user, sessionId: sid, agent: floor, text: 'Remind me in one line what we were working on, then stop.', emit })
    console.log(`${C.dim}${t3.payload?.reply?.slice(0, 300)}${C.off}`)
    expect(/NVDA/i.test(t3.payload?.reply ?? ''), `${brand}'s reply knows the sealed conversation (mentions NVDA)`)

    step('7. clean up')
    const removed = await agentContextService.removeFor({ kind, entityId: fakeId })
    expect(removed.deleted === 1, 'throwaway context removed')
    const fresh = await sessionService.startNew({ userId: user._id, scope: 'main' })
    expect(fresh.sessionId !== sid, 'drive session archived')
}

run()
    .catch(err => { console.error(`${C.bad}failed:${C.off}`, err?.stack ?? err); failed = true })
    .finally(async () => {
        await closeDb()
        console.log(failed ? `\n${C.bad}DRIVE FAILED${C.off}` : `\n${C.ok}DRIVE PASSED${C.off}`)
        process.exit(failed ? 1 : 0)
    })
