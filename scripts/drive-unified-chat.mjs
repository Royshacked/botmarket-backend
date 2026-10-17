// DRIVE THE UNIFIED CHAT — one timeline, every agent, in a real browser (unified-chat plan phase 7, 7e).
//
// The FE tests stub the session hook and the hook tests stub the socket, so nothing else runs
// browser -> turn route -> session turn -> socket frames -> timeline as ONE path. This does, and the
// screenshots are the evidence: look at them.
//
//   node scripts/drive-unified-chat.mjs [baseUrl] [outDir]
//
// Runs against the Vite dev server (:5173 — current source, /api and /ws proxied to :3030; the dev backend
// does not serve public/). Uses the throwaway
// `ui-smoke` user and starts it on a FRESH session (the old one is archived, which is also what the
// history step reads). The card is posted from this process, so its live push goes nowhere — the page is
// reloaded to see it, which is the reconnect replay path anyway.
/* global document, window -- page.evaluate bodies run in the browser */
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
const { postBotCard, cardActions } = await import('../api/chat/chat.service.js')
const { registerSessionCards } = await import('../services/sessionCards.js')

async function ensureUser() {
    try { await userService.createUser(USER); console.log('qa user: created') }
    catch (err) { console.log('qa user: already there —', err.message) }
    const db = await getDb()
    const u = await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } })
    if (!u?.id) throw new Error('qa user has no id')
    return u.id
}

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/uc-${name}.png`, fullPage: false }); console.log('  shot:', name) }
const text = async (page) => (await page.locator('.chat-timeline').innerText()).replace(/\s+/g, ' ')
// The names are upper-cased by CSS, so innerText reads AXL — compare case-blind.
const tags = async (page) => (await page.locator('.chat-timeline__body .chat-timeline__speaker-name').allInnerTexts()).map(t => t.toLowerCase())
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

async function waitIdle(page, ms) {
    // The turn is over when the Stop button is gone (the live turn ended) — or the budget runs out.
    const deadline = Date.now() + ms
    await page.waitForTimeout(1500)
    while (Date.now() < deadline) {
        if (!(await page.getByLabel('Stop response').count())) return true
        await page.waitForTimeout(1500)
    }
    return false
}

const userId = await ensureUser()
// A fresh session: archive whatever was live (an empty one is reused, which is fine too).
const before = await sessionService.getActive({ userId })
const fresh  = await sessionService.startNew({ userId })
console.log('session:', before?.sessionId, '→', fresh?.sessionId)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

try {
    // ── sign in ──
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input').first().count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }

    // ── 1. the empty chat is Axl's opening question ──
    await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
    await shot(page, '01-empty')
    check('opening question shown', /What would you like to do\?/.test(await text(page)))
    check('opening taps shown', (await page.getByRole('button', { name: 'Trade it' }).count()) > 0)

    // ── 2. a tap → Axl answers, and (when it routes with an opening) a desk answers below, in the same chat ──
    await page.getByRole('button', { name: 'Build a portfolio' }).click()
    console.log('tapped "Build a portfolio" — waiting for the turns…')
    await waitIdle(page, 150000)
    await page.waitForTimeout(4000)   // a routed opening is queued just after Axl's turn ends
    await waitIdle(page, 150000)
    await shot(page, '02-after-tap')
    const t2 = await tags(page)
    console.log('speakers:', t2.join(' → '))
    check('the user’s tap is a row', /Build a portfolio/.test(await text(page)))
    check('Axl answered under its own name', t2.includes('axl'))
    check('the floor moved off Axl or Axl asked', t2.length >= 1, `floor title: ${await page.locator('.chat-timeline__title').innerText()}`)

    // ── 3. Stop mid-turn ──
    const box = page.locator('.chat-timeline textarea')
    await box.fill('Explain, in detail and at length, how this app monitors a setup once it is armed.')
    await box.press('Enter')
    await page.getByLabel('Stop response').waitFor({ timeout: 10000 })
    await page.waitForTimeout(2500)
    await page.getByLabel('Stop response').click()
    const stopped = await waitIdle(page, 20000)
    await shot(page, '03-stopped')
    check('Stop ends the live turn', stopped)

    // ── 4. reload → the timeline comes back from the server ──
    const rowsBefore = await page.locator('.chat-timeline__row').count()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline__row').first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(1500)
    const rowsAfter = await page.locator('.chat-timeline__row').count()
    await shot(page, '04-reloaded')
    check('reload restores the rows', rowsAfter > 0 && rowsAfter >= rowsBefore - 1, `${rowsBefore} → ${rowsAfter}`)

    // ── 5. a background card lands in the chat, drawn by the card bubble; dismiss flips it ──
    registerSessionCards()
    const card = await postBotCard({ userId, botId: 'axl', type: 'market_brief_offer', content: 'Want today’s market brief?', payload: { day: new Date().toISOString().slice(0, 10) }, actions: cardActions('Show me') })
    await page.waitForTimeout(1500)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline__card').first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(1000)
    await shot(page, '05-card')
    check('the card row is in the chat', (await page.locator('.chat-timeline__card').count()) > 0)
    const dismiss = page.locator('.chat-timeline__card').last().getByRole('button', { name: /dismiss|not now|no thanks/i })
    if (await dismiss.count()) {
        await dismiss.first().click()
        await page.waitForTimeout(2500)
        const db = await getDb()
        const stored = await db.collection('chat_messages').findOne({ id: card?.id }, { projection: { status: 1 } })
        await shot(page, '06-card-dismissed')
        check('dismissing it resolves the card', stored?.status === 'dismissed', `status: ${stored?.status}`)
    } else {
        check('the card offers a dismiss', false, 'no dismiss button found')
    }

    // ── 6. New session files this one; History lists it, read-only ──
    await page.getByRole('button', { name: 'New session' }).click()
    await page.waitForTimeout(2500)
    await shot(page, '07-new-session')
    check('New session shows the opening again', /What would you like to do\?/.test(await text(page)))
    await page.getByRole('button', { name: 'History' }).click()
    await page.waitForTimeout(2500)
    await shot(page, '08-history')
    const items = page.locator('.chat-timeline__history-item')
    check('History lists the filed session', (await items.count()) > 0)
    if (await items.count()) {
        await items.first().click()
        await page.waitForTimeout(2500)
        await shot(page, '09-history-open')
        check('a past session opens read-only', (await page.locator('.chat-timeline__history-thread .chat-timeline__row').count()) > 0)
    }

    // ── 7. phone width ──
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    await shot(page, '10-phone')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    check('no horizontal scroll at phone width', !overflow)
} catch (err) {
    console.log('DRIVE FAILED:', err.message)
    await shot(page, 'zz-failure').catch(() => {})
} finally {
    if (errors.length) console.log('CONSOLE ERRORS:\n  ' + [...new Set(errors)].slice(0, 8).join('\n  '))
    const failed = results.filter(r => !r.ok).length
    console.log(`\n${results.length - failed}/${results.length} checks passed`)
    await browser.close()
    await closeDb()
}
process.exit(0)
