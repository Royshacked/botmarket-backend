// DRIVE THE RE-DRAW CARD, END TO END (Roy, 2026-11-03: "when Mentor asks 'if something happens, should I revise?' and
// the user says yes — is the revising really happening?"). Not one ran_away card had ever been posted on axl_dev.
//
//   1. A thesis GNRC setup for `ui-smoke`, its scenario's validity drawn with `on_away: revise` (the "ping me to
//      redraw" answer). Talos's own wake (`_checkSetup`) runs on it with ONLY the price feed stubbed — a day close
//      past the away edge — so the gate, the latch, the card and its copy are the real ones.
//   2. The card: in the social chat, from Mentor, pending, with its "Re-draw with Mentor" button; and what the push
//      would say (ui-smoke has no push subscription — the push itself is not sent from here).
//   3. The button, pressed in the browser: Mentor opens on THIS setup, and the re-draw turn runs — its opening words and
//      Mentor's answer printed in full, so the judgment can be read.
//   4. The work landing: a re-draw generated over the setup (`setupCommit.commitSetup` with `updateId`, the service the
//      Generate action calls) closes the card.
//
//   node scripts/drive-redraw-card.mjs [baseUrl] [outDir]
//
// Against the Vite dev server (:5173). One sign-in, one Mentor turn. The setup, the card and the session are removed.
import dns from 'dns'
import { readFileSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const LOG  = 'logs/backend.log'
const USER = { username: 'ui-smoke', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

if (process.env.DB_NAME !== 'axl_dev') throw new Error(`refusing to run against ${process.env.DB_NAME} — axl_dev only`)

const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')
const { setupService } = await import('../api/setups/setups.service.js')
const { setupCommit } = await import('../api/setups/setupCommit.service.js')
const { paperBrokerService } = await import('../api/broker/paperBroker.service.js')
const { _checkSetup, _testDeps } = await import('../monitoring/talos.monitor.service.js')
const { notificationForMessage } = await import('../services/push.service.js')

const VALID_UNTIL = new Date(Date.now() + 30 * 86_400_000).toISOString()
// The GNRC A of the thesis drives: the pullback on the deep stop, its away edge the swing high a close over is B's.
const SETUP = {
    asset: 'GNRC', direction: 'long', type: 'swing', trade_mode: 'thesis', entry_mode: 'conditional', timeframe: 'day',
    pace_rungs: ['1hr', '4hr'], valid_until: VALID_UNTIL,
    scenarios: [{
        id: 's1', name: 'Pullback to the level', archetype: 'pullback',
        entry_legs: [{ price: 185.93, quantity: 13 }], stop_legs: [{ price: 171.06, anchor: 'structure' }], target_legs: [{ price: 231.89, anchor: 'structure' }],
        conditions: [{ id: 'c1', text: 'Price at or under 185.93 shows strength on the 1h / 4h', weight: 'primary', mode: 'judgment' }],
        validity: { lower: 171.06, upper: 208.11, approach: 212.81, timeframe: 'day', on_break: 'revise', on_away: 'revise' },
    }],
}
const RAN_TO = 214.6   // a day close over the 212.81 away edge

// AS MENTOR SAVES ONE: Generate stores the working state on the setup (`chat_state`), its ledger fully settled. Without
// it a reopen rebuilds a flat draft with no ledger and Mentor starts over at the opening (redraw drive 1).
const { emptyBuild, upsertName, activeName, putName } = await import('../services/mentorBuild.util.js')
const settledBuild = () => {
    const b = upsertName(emptyBuild(), 'GNRC')
    const size = { unit: 'risk_cash', value: 200 }
    const vals = { direction: 'long', horizon: 'swing', lens: 'thesis', spans: ['t1'], entries: ['t1:o1'], size, summary: true }
    const claimed = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, { value: v, source: k === 'size' ? 'user' : 'mentor' }]))
    return putName(b, { ...activeName(b), settled: vals, claimed })
}
const CHAT_STATE = { active_asset: 'GNRC', draft: { ...SETUP, build: settledBuild() }, coverage: ['structure', 'news', 'earnings'] }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/rd-${name}.png` }); console.log('  shot:', name) }

const db = await getDb()
const userId = (await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1, pushSubscriptions: 1 } }))?.id
if (!userId) throw new Error('no ui-smoke user — run another drive first')

let setupId = null, sid = null
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

try {
    // ── 1. the setup, and Talos's wake with a close past the away edge ──
    const paper = await paperBrokerService.getAccount(userId)
    const accounts = paper ? [{ id: paper.accountId, broker: 'paper' }] : []
    const made = await setupService.generateSetup(SETUP, { userId, accounts, mainAccountId: paper?.accountId ?? null, chatState: CHAT_STATE })
    setupId = made?.ok ? made.doc?.id : null
    check('fixture: a thesis setup with a validity range and "ping me to redraw"', setupId, made?.reason ?? setupId)
    if (!setupId) throw new Error(`setup not made: ${JSON.stringify(made?.problems ?? made?.reason)}`)
    await setupService.patchSetup(setupId, { status: 'looking' }, userId)
    const doc = await db.collection('entities').findOne({ id: setupId }, { projection: { _id: 0 } })
    console.log('setup:', setupId, '· status', doc.status, '· broker', doc.broker, '· validity', JSON.stringify(doc.scenarios?.[0]?.validity))

    const deps = {
        ..._testDeps,
        isAssetOpen: () => true,
        getPrice:    async () => RAN_TO,
        getClose:    async () => RAN_TO,
        assess:      async () => { throw new Error('no read should run — validity is first') },
        cheapRead:   async () => { throw new Error('no read should run') },
    }
    const out = await _checkSetup(doc, Date.now(), deps)
    check('Talos: the close past the away edge is a runaway, not a break', out?.reason === 'invalidation' && out?.side === 'away', JSON.stringify(out))
    const after = await db.collection('entities').findOne({ id: setupId }, { projection: { _id: 0, status: 1, invalidation_status: 1, invalidation_reason: 1, monitor_state: 1 } })
    check('…the setup stays armed, its scenario drifting (price can come back)', after.status === 'looking' && after.monitor_state?.scenarios?.s1?.invalidation_status === 'drifting',
        JSON.stringify({ status: after.status, doc: after.invalidation_status, s1: after.monitor_state?.scenarios?.s1?.invalidation_status }))

    // ── 2. the card ──
    const card = await db.collection('chat_messages').findOne({ type: 'setup_invalidation', 'payload.setupId': setupId }, { projection: { _id: 0 } })
    console.log('card:', card?.content)
    check('the card is in the social chat, from Mentor', card && card.senderId === 'mentor', card?.senderId)
    check('…a "Missed" card (ran_away), pending', card?.payload?.event === 'ran_away' && card?.status === 'pending', JSON.stringify({ event: card?.payload?.event, status: card?.status }))
    check('…with "Re-draw with Mentor" and Dismiss', card?.actions?.primary?.label === 'Re-draw with Mentor' && card?.actions?.dismiss === true, JSON.stringify(card?.actions))
    check('…its words: missed, not wrong', /didn't get filled/.test(card?.content ?? '') && /wasn't wrong/.test(card?.content ?? ''))
    const note = notificationForMessage(card)
    console.log('push would say:', JSON.stringify({ title: note?.title, body: note?.body }))
    const subs = (await db.collection('users').findOne({ id: userId }, { projection: { pushSubscriptions: 1 } }))?.pushSubscriptions?.length ?? 0
    check('the push notification is built (title Mentor, the card\'s words)', note?.title && note.body?.startsWith(card.content.slice(0, 30)), `${note?.title} · ui-smoke subscriptions: ${subs}`)

    // ── 3. the button, in the browser ──
    sid = (await sessionService.startNew({ userId, force: true })).sessionId
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
    }
    await page.locator('.chat-timeline').waitFor({ timeout: 20000 })
    await page.waitForTimeout(2000)
    await page.locator('.app-header-axl__chat').click()
    await page.locator('.social-chat__topbar').waitFor({ timeout: 10000 })
    const back = page.getByLabel('Back to conversations')
    if (await back.count()) await back.click()
    const conv = page.locator('.social-chat__conv-item', { hasText: 'Mentor' }).first()
    await conv.waitFor({ timeout: 10000 })
    await conv.click()
    const btn = page.getByRole('button', { name: 'Re-draw with Mentor' }).last()
    const shown = await btn.waitFor({ timeout: 10000 }).then(() => true).catch(() => false)
    await shot(page, '01-card')
    check('the card shows in the social chat with its button', shown)
    if (!shown) throw new Error('no button')
    const logFrom = readFileSync(LOG, 'utf8').split('\n').length - 1
    await btn.click()

    // The re-draw turn runs — wait it out (one Mentor turn).
    const stop = page.getByLabel('Stop response')
    await stop.waitFor({ timeout: 20000 }).catch(() => {})
    for (let t = Date.now(); Date.now() - t < 240000 && await stop.count();) await page.waitForTimeout(2000)
    await page.waitForTimeout(2500)
    await shot(page, '02-redraw')
    const timeline = await page.locator('.chat-timeline').innerText().catch(() => '')
    console.log('\n--- the timeline after the button ---\n' + timeline.slice(-3500) + '\n---\n')
    const live = (await sessionService.list?.({ userId }))?.[0]?.sessionId ?? sid
    const m = (await sessionService.get({ sessionId: live, userId }))?.agentState?.mentor ?? null
    check('Mentor opened on THIS setup', m?.editing?.entityId === setupId, JSON.stringify(m?.editing ?? null))
    check('…the opening words say it was MISSED, not broken', /ran|missed|didn.t fill|without/i.test(timeline) && !/no longer valid/i.test(timeline),
        (timeline.match(/Talos says[^\n]*/)?.[0] ?? '').slice(0, 300))
    check('…and Mentor answered (a re-draw turn ran)', /MENTOR/.test(timeline))
    // What the turn RAN, from the backend's own line (`[mentorAgent] chatStream done`) — the redraw drive's first two
    // runs answered with no tool at all, from a finished ledger.
    const done = readFileSync(LOG, 'utf8').split('\n').slice(logFrom).filter(l => l.includes('[mentorAgent] | chatStream done')).at(-1) ?? ''
    const turn = (() => { try { return JSON.parse(done.slice(done.indexOf('{'))) } catch { return null } })()
    console.log('the re-draw turn:', JSON.stringify({ stage: turn?.stage, settled: turn?.settled, tools: turn?.tools }))
    // The fixture has no build conversation, so the user's limits are not in it: a level from the tool, or the limits
    // asked once (redraw drive 3 — the new higher low read, the risk read and B said, the limits asked).
    const reply = timeline.split(/\nMENTOR\n/).at(-1) ?? ''
    check('…it re-drew: the chart read again, then a new level from the tool or the limits asked',
        turn?.tools?.includes('get_price_structure') && (turn.tools.includes('get_entry_level') || /risk limit|stop[- ]distance|reward[- ]to[- ]risk|R:R/i.test(reply)), JSON.stringify(turn?.tools))
    check('…on the entries reopened — the opening and the span kept', ['direction', 'horizon', 'lens', 'spans'].every(f => turn?.settled?.includes(f)) && turn?.stage !== 'opening' && turn?.stage !== 'spans',
        JSON.stringify({ stage: turn?.stage, settled: turn?.settled }))

    // ── 4. the work landing closes the card ──
    const redrawn = { ...SETUP, scenarios: [{ ...SETUP.scenarios[0], entry_legs: [{ price: 194.36, quantity: 12 }], stop_legs: [{ price: 178.81, anchor: 'structure' }],
        validity: { lower: 178.81, upper: 224.94, approach: 231.89, timeframe: 'day', on_break: 'revise', on_away: 'revise' } }] }
    const landed = await setupCommit.commitSetup(redrawn, { userId, accounts, mainAccountId: paper?.accountId ?? null, updateId: setupId })
    const closed = await db.collection('chat_messages').findOne({ id: card.id }, { projection: { _id: 0, status: 1, resolveOutcome: 1 } })
    check('a re-draw generated over the setup closes the card', landed?.ok && closed?.status !== 'pending', JSON.stringify({ ok: landed?.ok, reason: landed?.reason, card: closed }))
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
} finally {
    if (setupId) {
        await db.collection('chat_messages').deleteMany({ 'payload.setupId': setupId }).catch(() => {})
        await setupService.deleteSetup(setupId, userId).catch(() => {})
    }
    if (sid) {
        await db.collection('session_messages').deleteMany({ sessionId: sid }).catch(() => {})
        await db.collection('sessions').deleteOne({ sessionId: sid }).catch(() => {})
    }
    if (errors.length) check('no page errors', false, errors.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
    await closeDb()
}
