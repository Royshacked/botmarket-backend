// DRIVE MENTOR'S TWO MODES (Roy, 2026-11-01; docs/design/mentor-modes.md).
//
//   A. The Hotlist's Build with Mentor → RISK-BASED from the seed (no lens rides from the client), no pattern tool
//      called; then the user brings their own idea → the switch to a lens of theirs, and the next turn on the whole kit.
//   B. A typed bare name → the cheap read says no setup → RISK-BASED.
//   C. A typed setup → the read says setup → THE USER'S SETUP under a lens Mentor recommends; then "do it your way" →
//      the switch to thesis, and the next turn on the risk-based kit.
//
// What a turn ran on is read from the backend's own turn log (logs/backend.log, `[mentorAgent] chatStream done`:
// mode · modeSource · switchedTo · tools), what it built from the session.
//
//   node scripts/drive-mentor-modes.mjs [baseUrl] [outDir]
//
// Against the Vite dev server (:5173) as the throwaway `ui-smoke` user, on FRESH sessions (deleted after). Real model
// spend: about seven Mentor turns. Nothing is generated. One sign-in; each new session is one reload.
import dns from 'dns'
import { readFileSync, statSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const LOG  = 'logs/backend.log'
const USER = { username: 'ui-smoke', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { userService } = await import('../api/user/user.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')
const { THESIS_DROPPED } = await import('../services/mentorMode.service.js')

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/modes-${name}.png`, fullPage: false }); console.log('  shot:', name) }
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

// ── the backend's turn log, from a byte offset on ──
let logAt = statSync(LOG).size
function turnsLogged() {
    const buf = readFileSync(LOG)
    const fresh = buf.subarray(logAt).toString('utf8')
    logAt = buf.length
    return fresh.split('\n')
        .filter(l => l.includes('[mentorAgent] | chatStream done | '))
        .map(l => { try { return JSON.parse(l.slice(l.indexOf('chatStream done | ') + 18)) } catch { return null } })
        .filter(Boolean)
}
const lastTurn = () => turnsLogged().at(-1) ?? null
const patternTools = (t) => (t?.tools ?? []).filter(n => THESIS_DROPPED.has(n))

async function ensureUser() {
    try { await userService.createUser(USER); console.log('qa user: created') }
    catch (err) { console.log('qa user: already there —', err.message) }
    const db = await getDb()
    const u = await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } })
    if (!u?.id) throw new Error('qa user has no id')
    return u.id
}

async function signIn(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input').first().count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
    await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
}

async function waitIdle(page, ms) {
    const deadline = Date.now() + ms
    await page.waitForTimeout(2000)
    while (Date.now() < deadline) {
        if (!(await page.getByLabel('Stop response').count())) return true
        await page.waitForTimeout(2000)
    }
    return false
}

async function say(page, text) {
    const box = page.locator('.chat-timeline textarea')
    await box.fill(text)
    await box.press('Enter')
    const done = await waitIdle(page, 300000)
    await page.waitForTimeout(1500)   // the log line lands after the stream closes
    return done
}

const lensOf = (state) => {
    const b = state?.draft?.build ?? state?.build
    const n = b?.names?.find(x => x.asset === b.active)
    return n?.settled?.lens ?? n?.claimed?.lens?.value ?? null
}

const userId = await ensureUser()
const sessions = []
const fresh = async (mentorFloor) => {
    const sid = (await sessionService.startNew({ userId })).sessionId
    sessions.push(sid)
    if (mentorFloor) await sessionService.setFloor({ sessionId: sid, userId, agent: 'mentor' })
    return sid
}
const mentorOf = async (sid) => (await sessionService.get({ sessionId: sid, userId }))?.agentState?.mentor ?? null

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = [], posted = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
page.on('request', r => { if (r.method() === 'POST' && /\/api\/sessions\/[^/]+\/turn/.test(r.url())) { try { posted.push(JSON.parse(r.postData() ?? '{}')) } catch { /* not JSON */ } } })

try {
    // ── A. the Hotlist → risk-based from the seed; then the user's own idea → the switch ──
    const sidA = await fresh(false)
    console.log('\nA. Hotlist — session', sidA)
    await signIn(page)
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.floor-lists', { timeout: 15000 })
    await page.waitForTimeout(2000)
    turnsLogged()
    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForSelector('.hot-panel', { timeout: 60000 })
    await page.locator('.hot-panel').getByRole('button', { name: /^Swing/ }).click()
    await page.waitForSelector('.hot-panel tr.hot-row', { timeout: 60000 })
    const sym = await page.locator('.hot-panel tr.hot-row').first().getAttribute('data-symbol')
    await page.locator('.hot-panel tr.hot-row').first().locator('td').nth(3).click()
    await page.waitForSelector('.hot-page', { timeout: 10000 })
    await page.locator('.hot-panel').getByRole('button', { name: 'Build with Mentor' }).first().click()
    check('A: the opening turn finished', await waitIdle(page, 300000))
    await page.waitForTimeout(1500)
    const seedTurn = posted.find(t => t.agent === 'mentor')
    check(`A: ${sym} is handed over with no lens`, seedTurn?.seed && !('recommended_mode' in seedTurn.seed), JSON.stringify(seedTurn?.seed ?? null).slice(0, 160))
    let t = lastTurn()
    check('A: the turn ran risk-based, from the seed', t?.mode === 'thesis' && t?.modeSource === 'seed', JSON.stringify({ mode: t?.mode, src: t?.modeSource }))
    check('A: no pattern or indicator tool was called', t && patternTools(t).length === 0, (t?.tools ?? []).join(', '))
    let st = await mentorOf(sidA)
    check('A: the lens on the ledger is thesis', lensOf(st) === 'thesis', lensOf(st))
    const openingA = (await page.locator('.chat-timeline').innerText().catch(() => '')).slice(-2000)
    check('A: Mentor says it is building it risk-based', /risk[- ]based|thesis/i.test(openingA), openingA.replace(/\s+/g, ' ').slice(-240))
    await shot(page, 'A1-opening')

    await say(page, 'Actually I have my own idea for this one: buy the breakout over the last swing high on a daily close, with the stop under the breakout day\'s low. Long, swing.')
    t = lastTurn()
    st = await mentorOf(sidA)
    check('A: bringing an idea switches the lens off thesis', t?.switchedTo && t.switchedTo !== 'thesis' && lensOf(st) === t.switchedTo, JSON.stringify({ switchedTo: t?.switchedTo, lens: lensOf(st) }))
    check('A: the worksheet carries the new lens', st?.draft?.trade_mode && st.draft.trade_mode !== 'thesis', st?.draft?.trade_mode)
    await shot(page, 'A2-switched')
    await say(page, 'Yes, go on.')
    t = lastTurn()
    check('A: the next turn runs on the whole kit (the user\'s setup, from the ledger)', t?.mode === 'user' && t?.modeSource === 'ledger', JSON.stringify({ mode: t?.mode, src: t?.modeSource, tools: t?.tools }))

    // ── B. a typed bare name → risk-based by the read ──
    const sidB = await fresh(true)
    console.log('\nB. typed bare name — session', sidB)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline textarea').waitFor({ timeout: 20000 })
    await page.waitForTimeout(2000)
    turnsLogged()
    await say(page, 'Build me a trade on AAPL.')
    t = lastTurn()
    st = await mentorOf(sidB)
    check('B: a bare name reads as no setup → risk-based', t?.mode === 'thesis' && t?.modeSource === 'read', JSON.stringify({ mode: t?.mode, src: t?.modeSource }))
    check('B: no pattern or indicator tool was called', t && patternTools(t).length === 0, (t?.tools ?? []).join(', '))
    check('B: the lens on the ledger is thesis', lensOf(st) === 'thesis', lensOf(st))
    await shot(page, 'B1-opening')

    // ── C. a typed setup → the user's setup; then "your way" → the switch to thesis ──
    const sidC = await fresh(true)
    console.log('\nC. typed setup — session', sidC)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline textarea').waitFor({ timeout: 20000 })
    await page.waitForTimeout(2000)
    turnsLogged()
    await say(page, 'I want to go long AMD on a pullback to the 50-day moving average, as a swing trade.')
    t = lastTurn()
    st = await mentorOf(sidC)
    check('C: a setup reads as the user\'s → the whole kit', t?.mode === 'user' && t?.modeSource === 'read', JSON.stringify({ mode: t?.mode, src: t?.modeSource }))
    check('C: Mentor recommends one of the three lenses', ['discretionary', 'smc', 'institutional'].includes(lensOf(st)), lensOf(st))
    await shot(page, 'C1-opening')
    await say(page, 'On second thought, forget my pullback — do it your way, risk-based.')
    t = lastTurn()
    st = await mentorOf(sidC)
    check('C: "your way" switches to thesis', t?.switchedTo === 'thesis' && lensOf(st) === 'thesis', JSON.stringify({ switchedTo: t?.switchedTo, lens: lensOf(st) }))
    await shot(page, 'C2-switched')
    await say(page, 'Yes, go on.')
    t = lastTurn()
    check('C: the next turn runs risk-based (from the ledger), no pattern tool', t?.mode === 'thesis' && t?.modeSource === 'ledger' && patternTools(t).length === 0, JSON.stringify({ mode: t?.mode, src: t?.modeSource, tools: t?.tools }))
    await shot(page, 'C3-after')
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
    await shot(page, 'error').catch(() => {})
} finally {
    const db = await getDb()
    for (const sid of sessions) {
        await db.collection('session_messages').deleteMany({ sessionId: sid }).catch(() => {})
        await db.collection('sessions').deleteOne({ sessionId: sid }).catch(() => {})
    }
    const crashed = errors.filter(e => e.startsWith('PAGEERROR'))
    if (crashed.length) check('no page errors', false, crashed.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
    if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '))
    await closeDb()
}
