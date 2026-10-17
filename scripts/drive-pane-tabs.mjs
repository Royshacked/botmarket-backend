// DRIVE THE PANE'S KEPT TABS AND THE TEARDOWN — in a real browser (unified-chat plan phase 8e).
//
// What 8e changed that only a browser shows: the chat column is ALWAYS the timeline (no desk tabs, no agent bar, no
// crumb); Pythia and Aether open from the chat's header (admin) as side-pane tabs that stay MOUNTED — a half-typed
// message survives the pane closing and another tab showing; and Discard throws a desk's unsaved work away (asked
// first). No model call: nothing is sent to Pythia or Aether, and Mentor's draft is seeded.
//
//   node scripts/drive-pane-tabs.mjs [baseUrl] [outDir]
//
// Runs against the Vite dev server (:5173, /api and /ws proxied to :3030) as the throwaway `ui-smoke` user (an
// admin), on a FRESH session, removed after. A failed check fails the process. Several drives back to back trip the
// dev server's in-memory rate limits — restart it between runs (touch a backend file).
/* global document -- page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { userService } = await import('../api/user/user.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')
const { draftVerdict } = await import('../services/setupVerdict.js')

const DRAFT = {
    asset: 'NVDA', direction: 'long', type: 'swing',
    conditions:  [{ id: 'c1', text: 'CHoCH up on the 15m' }],
    entry_legs:  [{ price: 238.6, quantity: 100 }],
    stop_legs:   [{ price: 234.8 }],
    target_legs: [{ price: 246 }],
}

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/pt-${name}.png`, fullPage: false }); console.log('  shot:', name) }
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const pane = (page) => page.locator('.side-pane')

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

const userId = await ensureUser()
const sid    = (await sessionService.startNew({ userId })).sessionId
console.log('session:', sid)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

try {
    // ── 1. the chat column is the timeline — no desk tab, no agent bar, no crumb ──
    await signIn(page)
    await page.waitForTimeout(800)
    check('the chat column is the timeline, with no agent bar or crumb', (await page.locator('.chat-agentbar').count()) === 0 && await page.locator('.workspace__chat .chat-timeline').isVisible())

    // ── 2. Pythia opens from the chat's header, as a pane tab ──
    await page.getByRole('button', { name: 'Pythia', exact: true }).click()
    await pane(page).waitFor({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(800)
    await shot(page, '01-pythia')
    check('Pythia opens in the side pane, beside the chat', (await pane(page).locator('.side-pane__tabs').innerText().catch(() => '')).includes('Pythia') && await page.locator('.chat-timeline').isVisible())

    // ── 3. a half-typed message survives the pane closing ──
    const box = pane(page).locator('textarea').first()
    await box.fill('Drive — a half-typed question for Pythia')
    await pane(page).getByRole('button', { name: 'Close', exact: true }).click()
    await page.waitForTimeout(500)
    check('the pane closes', (await pane(page).count()) === 0)
    await page.getByRole('button', { name: 'Pythia', exact: true }).click()
    await page.waitForTimeout(800)
    check('…and Pythia comes back with the half-typed message still there', (await pane(page).locator('textarea').first().inputValue().catch(() => '')) === 'Drive — a half-typed question for Pythia')

    // ── 4. Aether beside it; Pythia's tab and text are kept while Aether shows ──
    await page.getByRole('button', { name: 'Aether', exact: true }).click()
    await page.waitForTimeout(800)
    await shot(page, '02-aether')
    const tabs = await pane(page).locator('.side-pane__tabs').innerText().catch(() => '')
    check('Aether opens as a second tab', /Aether/.test(tabs) && /Pythia/.test(tabs))
    await pane(page).getByRole('tab', { name: 'Pythia' }).click()
    await page.waitForTimeout(500)
    check('back on Pythia, the message is still there', (await pane(page).locator('textarea').first().inputValue().catch(() => '')) === 'Drive — a half-typed question for Pythia')

    // ── 5. Discard: Mentor's unsaved draft thrown away, asked first ──
    const v = draftVerdict(DRAFT, true)
    await sessionService.setAgentState({ sessionId: sid, userId, agent: 'mentor', state: { active_asset: 'NVDA', draft: v.setup, coverage: [], drafts: {}, view: { gate: null, readiness: v.readiness, setups: null } } })
    await sessionService.setFloor({ sessionId: sid, userId, agent: 'mentor' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
    await pane(page).getByRole('button', { name: 'Discard' }).waitFor({ timeout: 15000 }).catch(() => {})
    let asked = null
    page.once('dialog', d => { asked = d.message(); d.accept() })
    await pane(page).getByRole('button', { name: 'Discard' }).click()
    await page.waitForTimeout(1500)
    await shot(page, '03-discarded')
    const mentor = (await sessionService.get({ sessionId: sid, userId }))?.agentState?.mentor ?? null
    check('Discard asks first, then Mentor\'s table is clear', /Discard the NVDA plan\? It is not saved anywhere/.test(asked ?? '') && !mentor, `asked: ${asked}`)
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
} finally {
    const db = await getDb()
    await db.collection('session_messages').deleteMany({ sessionId: sid }).catch(() => {})
    await db.collection('sessions').deleteOne({ sessionId: sid }).catch(() => {})
    const crashed = errors.filter(e => e.startsWith('PAGEERROR'))
    if (crashed.length) check('no page errors', false, crashed.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
    if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '))
    await closeDb()
}
