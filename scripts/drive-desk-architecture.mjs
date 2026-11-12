#!/usr/bin/env node
// Live drive of the desk rework (docs/design/argus-rework.md steps 1–3 + two targets stage 1), real models, real database.
//
//   node scripts/drive-desk-architecture.mjs [part ...]      parts: pick · view · intraday · proteus · oneq (default: pick view)
//                                            [--user ui-smoke]
//
// On THIS process's database (axl_dev on the laptop; it refuses `test`), as a throwaway QA user (default `ui-smoke`), so
// the user's own chat is never archived by a drive. The desks run IN THIS PROCESS (startTurn), including the chain and —
// for `view` — the research run the chain starts: nothing goes through the HTTP server.
//
//   pick      Mentor, no name, a SWING trade → routes to Argus → Argus reads get_horizon_list and picks ONE → the pick is
//             on the house's lists (houseListNames) → the chain hands it back to Mentor.
//   view      Mentor, a LONG-TERM trade on a name whose coverage target is a SWING one (3m/6m) → once the horizon is
//             confirmed, the read is asked for (a long-term VIEW), Generate is held while it runs, Prometheus writes
//             coverage.horizon_views.long_term, and the chain hands the read to Mentor, whose turn runs by itself.
//   intraday  Mentor, no name, an INTRADAY trade → Argus picks from today's latest DAY BOARD (needs a board today).
//   proteus   Axl, "how does TSLA behave?" → routes to Proteus (technicals) → Proteus reads the MEASURED profile
//             (get_behaviour_profile; computed and kept in proteus_profiles) and answers; a follow-up on the daily 50 SMA.
//   oneq      argus-rework.md §2.2: Axl, "let's swing on EQPT" → Mentor asks ONE question (size, risk, R:R) → the
//             answer with the paper account marked → Mentor builds, says <go>, and the setup is SAVED AND ARMED (it
//             waits for Prometheus's read if one runs). Leaves a real armed setup on the QA user's paper account.
//
// A few cents of model spend; `view` adds one Prometheus horizon read (~4 minutes). Exits 1 on a broken expectation.

import dns from 'node:dns'
import { config } from '../services/config.js'

if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, getDbName, closeDb } = await import('../providers/mongodb.provider.js')
const { roleOf } = await import('../api/user/user.model.js')
const { _register, _unregister } = await import('../api/chat/chatWs.js')
const { sessionService } = await import('../services/session.service.js')
const { startTurn } = await import('../services/desks/turns.js')
const { houseListNames } = await import('../services/tools/horizonList.tools.js')
const { readTarget, readFor, readPending } = await import('../services/mentorReads.service.js')
const { normalizeBuild, activeName } = await import('../services/mentorBuild.util.js')
const { todayBoards } = await import('../services/hotlist.day.js')

const C = { dim: '\x1b[2m', ok: '\x1b[32m', bad: '\x1b[31m', head: '\x1b[36m', off: '\x1b[0m' }
const step = (s) => console.log(`\n${C.head}── ${s}${C.off}`)
const note = (s) => console.log(`${C.dim}${s}${C.off}`)
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
const turnDone = (turnId, ms) => waitFor(f => f.event === 'session_turn' && f.data.turnId === turnId && DONE.includes(f.data.status), `turn ${turnId}`, ms)
// A turn the drive already waited on is not waited on twice — but one that STARTED before the wait began counts (Argus's
// opening turn starts as Mentor's routing turn finishes, before the drive gets to wait for it).
const used = new Set()
const doneFor = async (agent, origin, ms) => {
    const started = await waitFor(f => f.event === 'session_turn' && f.data.agent === agent && f.data.origin === origin && f.data.status === 'started' && !used.has(f.data.turnId), `${agent}'s ${origin} turn to start`, ms)
    if (started) used.add(started.data.turnId)
    return started ? turnDone(started.data.turnId, ms) : null
}
const say = async (user, sid, agent, text, input = undefined) => {
    const t = await startTurn({ user, sessionId: sid, agent, text, ...(input ? { input } : {}), turnId: `drive_${agent}_${Date.now()}` })
    const d = await turnDone(t.turnId)
    expect(d?.data.status === 'done', `${agent}'s turn ${d?.data.status}`)
    note(`  ${agent}: ${(d?.data.payload?.reply ?? '').replace(/\s+/g, ' ').slice(0, 260)}`)
    return d
}
const short = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)

async function freshSession(user, floor) {
    const s = await sessionService.startNew({ userId: user._id, scope: 'main' })
    await sessionService.setFloor({ sessionId: s.sessionId, userId: user._id, agent: floor })
    return s.sessionId
}

/** Mentor, no name → Argus → a pick → back to Mentor. Returns the pick. */
async function pickFlow(user, horizonWords, label) {
    const sid = await freshSession(user, 'mentor')
    const m = await say(user, sid, 'mentor', `I want a long ${horizonWords} trade but I don't have a stock in mind. Find me one.`)
    if (!expect(m?.data.payload?.route === 'scan', `Mentor routed to Argus (${m?.data.payload?.route})`)) return { sid, pick: null }
    let a = await doneFor('scanner', 'opening')
    const answers = [`${label} — yes, that horizon. Pick one for me.`, 'Just pick one from the list.']
    let n = 0
    while (a && !a.data.payload?.argus_pick && n < answers.length) {
        note(`  Argus, no pick yet: ${short(a.data.payload?.reply)}`)
        a = await say(user, sid, 'scanner', answers[n++])
    }
    const pick = a?.data.payload?.argus_pick
    note(`  Argus: ${short(a?.data.payload?.reply, 400)}`)
    note(`  answers it took: ${n}`)
    return { sid, pick, reply: a?.data.payload?.reply ?? '' }
}

async function partPick(user) {
    step('PICK — a swing trade, no name: Argus picks from the house\'s list')
    const { sid, pick } = await pickFlow(user, 'swing', 'Swing')
    if (!expect(!!pick?.ticker, `argus_pick: ${pick ? `${pick.ticker} — ${short(pick.thesis, 120)}` : 'none'}`)) return
    const names = await houseListNames()
    expect(names.has(pick.ticker), `${pick.ticker} is on the house's lists today (${names.size} names) — the pick gate held`)
    const tools = frames.filter(f => f.event === 'tool_start' || f.event === 'status').map(f => f.data?.tool ?? f.data?.name).filter(Boolean)
    note(`  tools seen: ${[...new Set(tools)].join(', ') || '(none captured)'}`)
    const back = await doneFor('mentor', 'chain')
    expect(back?.data.status === 'done', `the chain handed ${pick.ticker} back to Mentor (${back?.data.status})`)
    note(`  Mentor: ${short(back?.data.payload?.reply, 300)}`)
    void sid
}

async function partView(user) {
    step('VIEW — a long-term trade on a name covered on a SWING target: the read, the hold, the view, the hand-back')
    const db = await getDb()
    // A Buy on the swing book with no long-term view yet — the case the CR found (a swing coverage read for a long build).
    const cov = await db.collection('coverage').findOne({ status: 'active', rating: { $in: ['buy', 'strong_buy'] }, 'price_target.horizon': { $in: ['3m', '6m'] }, 'horizon_views.long_term': { $exists: false } },
        { projection: { _id: 0, id: 1, symbol: 1, rating: 1, price_target: 1 } })
    if (!expect(!!cov, `a swing-target Buy with no long-term view: ${cov ? `${cov.symbol} (${cov.rating}, ${cov.price_target?.value} on ${cov.price_target?.horizon})` : 'none in dev'}`)) return
    const sym = cov.symbol
    const before = await readFor(sym, 'long term')
    expect(before.state === 'missing' && before.need === 'view', `before: the long-term read is missing and needs a VIEW (${before.state}/${before.need})`)

    const sid = await freshSession(user, 'mentor')
    // The user confirms the horizon the way a user would; the settle is the ledger's (Mentor's <build>), so allow a few turns.
    const lines = [
        `I want to buy ${sym} as a long-term position — hold it a year or more.`,
        'Yes: long, long term. Risk-based is fine. Confirmed — go ahead.',
        'Confirmed, long term.',
    ]
    let target = null
    for (const text of lines) {
        await say(user, sid, 'mentor', text)
        const h = await sessionService.get({ sessionId: sid, userId: user._id })
        target = readTarget(h.agentState?.mentor)
        const name = activeName(normalizeBuild(h.agentState?.mentor?.draft?.build))
        note(`  ledger: ${name?.asset ?? '-'} settled=${JSON.stringify(name?.settled ?? {})}`)
        if (target) break
    }
    if (!expect(target?.symbol === sym && target?.horizon === 'long term', `the horizon is confirmed on the ledger (${JSON.stringify(target)})`)) return

    // The chain posts the line AFTER the turn's done frame (runner.afterTurn → askRead): wait for it, do not race it.
    let wait = null
    for (let i = 0; i < 30 && !wait; i++) {
        const msgs = await sessionService.messagesSince({ sessionId: sid, userId: user._id })
        wait = msgs.find(m => m.agent === 'mentor' && /Prometheus is reading it/.test(m.content ?? ''))
        if (!wait) await new Promise(r => setTimeout(r, 500))
    }
    expect(!!wait, `Mentor said the read is running: "${short(wait?.content, 220)}"`)
    expect(/long term view/.test(wait?.content ?? ''), 'it says a long-term VIEW, not a full coverage')
    const h1 = await sessionService.get({ sessionId: sid, userId: user._id })
    expect(await readPending(h1.agentState?.mentor, undefined, { sessionId: sid }), 'Generate is held while it runs (readPending)')
    const ready = h1.agentState?.mentor?.view?.readiness
    if (ready) expect(ready.ready === false, `the readiness the panel shows is dark (${JSON.stringify(ready.problems ?? [])})`)
    else note('  (no setup draft on the table yet — the readiness hold is covered by the unit test)')

    step('… waiting for Prometheus (one horizon read on the shared research run)')
    const t0 = Date.now()
    const landed = await doneFor('mentor', 'chain', 15 * 60_000)
    note(`  waited ${Math.round((Date.now() - t0) / 1000)}s`)
    expect(landed?.data.status === 'done', `Mentor's turn ran by itself when the read landed (${landed?.data.status})`)
    const after = await db.collection('coverage').findOne({ symbol: sym }, { projection: { _id: 0, horizon_views: 1, price_target: 1, revisions: { $slice: 1 } } })
    const v = after?.horizon_views?.long_term
    expect(!!v, `coverage.horizon_views.long_term written: ${v ? `${v.rating}, ${v.target?.value} on ${v.target?.horizon} by ${v.target?.target_date}` : 'none'}`)
    if (v) expect(['12m', '18m', '24m'].includes(v.target?.horizon), 'the view is on a long-term horizon')
    expect(after?.price_target?.horizon === cov.price_target?.horizon && after?.price_target?.value === cov.price_target?.value, 'the MAIN target is untouched')
    note(`  latest revision: ${after?.revisions?.[0]?.kind} — ${short(after?.revisions?.[0]?.note, 160)}`)
    const msgs2 = await sessionService.messagesSince({ sessionId: sid, userId: user._id })
    const pLine = msgs2.find(m => m.agent === 'analyst' && m.content?.startsWith(`${sym}, long term:`))
    expect(!!pLine, `Prometheus's line in the chat: "${short(pLine?.content, 240)}"`)
    const hand = msgs2.find(m => m.kind === 'handoff' && m.to === 'mentor')
    expect(!!hand, `the hand-off to Mentor: "${short(hand?.content, 200)}"`)
    note(`  Mentor: ${short(landed?.data.payload?.reply, 400)}`)
    const h2 = await sessionService.get({ sessionId: sid, userId: user._id })
    expect(!(await readPending(h2.agentState?.mentor, undefined, { sessionId: sid })), 'Generate is no longer held')
}

async function partIntraday(user) {
    step('INTRADAY — no name, an intraday trade: Argus picks from today\'s day board')
    const boards = await todayBoards()
    if (!expect(boards.length > 0, `a day board today (${boards.map(b => `${b.checkpoint}:${b.rows?.length ?? 0}`).join(' ') || 'none'})`)) return
    const onBoard = new Set(boards.flatMap(b => (b.rows ?? []).map(r => r.symbol)))
    const { pick, reply } = await pickFlow(user, 'intraday', 'Intraday')
    if (!onBoard.size) { expect(!pick, `an empty board gives no pick (${short(reply, 160)})`); return }
    if (!expect(!!pick?.ticker, `argus_pick: ${pick ? `${pick.ticker} — ${short(pick.thesis, 120)}` : 'none'}`)) return
    expect(onBoard.has(pick.ticker), `${pick.ticker} is on today's day board`)
    const back = await doneFor('mentor', 'chain')
    expect(back?.data.status === 'done', `handed back to Mentor (${back?.data.status})`)
}

async function partProteus(user) {
    step('PROTEUS — Axl hands "how does TSLA behave?" to the technical analysis desk')
    const sid = await freshSession(user, 'axl')
    const a = await say(user, sid, 'axl', 'How does TSLA behave? Does it respect any moving average?')
    if (!expect(a?.data.payload?.route === 'technicals', `Axl routed to Proteus (${a?.data.payload?.route})`)) return
    const t0 = Date.now()
    const p = await doneFor('proteus', 'opening')
    expect(p?.data.status === 'done', `Proteus's opening turn ${p?.data.status} (${Math.round((Date.now() - t0) / 1000)}s)`)
    const tools = frames.filter(f => f.event === 'tool_start' || f.event === 'status').map(f => f.data?.tool ?? f.data?.name).filter(Boolean)
    note(`  tools seen: ${[...new Set(tools)].join(', ') || '(none captured)'}`)
    const reply = p?.data.payload?.reply ?? ''
    note(`  Proteus: ${short(reply, 900)}`)
    const doc = await (await getDb()).collection('proteus_profiles').findOne({ symbol: 'TSLA' })
    expect(!!doc?.profile?.timeframes?.day, `TSLA's profile kept in proteus_profiles (computed ${doc?.computed_at ?? 'never'})`)
    expect(/ATR/i.test(reply), 'the answer gives the ATR')
    expect(!/\bwill (go|rise|fall|break)\b/i.test(reply), 'no forecast in the answer')
    const f = await say(user, sid, 'proteus', 'And on the daily — the 50-day SMA specifically? Should I put my stop under it?')
    const r2 = f?.data.payload?.reply ?? ''
    note(`  Proteus (follow-up): ${short(r2, 700)}`)
    expect(/mentor/i.test(r2), 'the stop question is sent to Mentor, not answered with a level')
    void sid
}

async function partOneQuestion(user) {
    step('ONE QUESTION — Mentor asks size, risk and R:R once, then builds, generates and arms')
    const db = await getDb()
    const { getTradingContext } = await import('../services/tradingContext.service.js')
    const paper = (await getTradingContext(user._id)).accounts.find(a => a.mode === 'paper')
    if (!expect(!!paper, `a paper account to mark (${paper?.id ?? 'none'})`)) return
    const input = { accounts: [paper], mainAccountId: paper.id }
    const before = new Set((await db.collection('entities').find({ kind: 'setup', userId: user._id }, { projection: { id: 1 } }).toArray()).map(d => d.id))
    const sid = await freshSession(user, 'axl')
    const a = await say(user, sid, 'axl', "Let's swing on EQPT.", input)
    if (!expect(a?.data.payload?.route === 'assist', `Axl routed to Mentor (${a?.data.payload?.route})`)) return
    const m = await doneFor('mentor', 'opening')
    const ask = m?.data.payload?.reply ?? ''
    note(`  Mentor's ask: ${short(ask, 700)}`)
    expect(/position size/i.test(ask) && /risk/i.test(ask) && /R:R|reward to risk/i.test(ask), 'Mentor asks position size, risk and R:R')
    expect(!/all the way|checkpoints|A, B or both|how long|let it go/i.test(ask), 'and nothing else (no waiver, no A/B, no wait, no runaway question)')
    const t0 = Date.now()
    const ans = await say(user, sid, 'mentor', 'Position size $5,000, risk $100, R:R 2.', input)
    note(`  Mentor's build: ${short(ans?.data.payload?.reply, 900)}`)
    expect(!!ans?.data.payload?.go, `Mentor said go (${JSON.stringify(ans?.data.payload?.go ?? null)})`)
    // Saved and armed — at once, or once Prometheus's read lands and Mentor's chain turn says go again.
    let made = null
    for (let i = 0; i < 160 && !made; i++) {
        made = await db.collection('entities').findOne({ kind: 'setup', userId: user._id, asset: 'EQPT', id: { $nin: [...before] } })
        if (!made) await new Promise(r => setTimeout(r, 3000))
    }
    if (!expect(!!made, `an EQPT setup was saved (${Math.round((Date.now() - t0) / 1000)}s)`)) {
        const rows = await sessionService.messagesSince({ sessionId: sid, userId: user._id }).catch(() => [])
        note(`  last lines: ${(rows ?? []).slice(-3).map(r => `${r.agent}: ${short(r.content, 200)}`).join(' | ')}`)
        return
    }
    expect(made.status === 'looking', `…and ARMED (status ${made.status})`)
    const sc = made.scenarios ?? []
    note(`  scenarios: ${sc.map(s => `${s.name ?? s.id}: entry ${s.entry_legs?.map(l => l.price).join('/')} stop ${s.stop_legs?.map(l => l.price).join('/')} target ${s.target_legs?.map(l => l.price).join('/')} on_away ${s.validity?.on_away}`).join(' · ')}; valid_until ${made.valid_until}`)
    expect(sc.every(s => !s.validity || s.validity.on_away === 'revise'), 'runaway = redraw on every scenario')
    const active = await sessionService.getActive({ userId: user._id })
    const [line] = await sessionService.messagesSince({ sessionId: active.sessionId, userId: user._id })
    expect(/saved and armed/.test(line?.content ?? ''), `back at Axl: "${short(line?.content, 160)}"`)
}

async function run() {
    const args = process.argv.slice(2)
    const ui = args.indexOf('--user')
    const username = ui >= 0 ? args[ui + 1] : 'ui-smoke'
    const parts = args.filter((a, i) => !a.startsWith('--') && (ui < 0 || i !== ui + 1))
    const todo = parts.length ? parts : ['pick', 'view']
    if (getDbName() === 'test') { console.error('refusing to run on the production database `test`'); process.exitCode = 2; return }
    const db = await getDb()
    const u = await db.collection('users').findOne({ username }, { projection: { _id: 0, id: 1, role: 1, isAdmin: 1 } })
    if (!u) { console.error(`no user "${username}" in this database`); process.exitCode = 2; return }
    const user = { _id: String(u.id), role: roleOf(u) }
    console.log(`${C.dim}user=${username} (${user.role}) parts=${todo.join(',')}${C.off}`)
    globalThis.__driveUser = user._id
    _register(user._id, socket)
    for (const p of todo) {
        if (p === 'pick') await partPick(user)
        else if (p === 'view') await partView(user)
        else if (p === 'intraday') await partIntraday(user)
        else if (p === 'proteus') await partProteus(user)
        else if (p === 'oneq') await partOneQuestion(user)
        else expect(false, `unknown part ${p}`)
    }
    step('clean up')
    const fresh = await sessionService.startNew({ userId: user._id, scope: 'main' })
    expect(!!fresh.sessionId, 'the drive sessions are archived (the QA user\'s only)')
    note(`frames captured: ${frames.length}`)
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
