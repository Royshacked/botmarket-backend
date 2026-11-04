/* global document -- page.evaluate bodies run in the browser */
// DRIVE: REOPENING A SETUP ON A PHONE (Roy, 2026-11-04: "opened chat with mentor with user's first turn of the thesis, but
// no reply from Mentor").
//
//   node scripts/drive-setup-edit.mjs [baseUrl] [outDir]   (default http://localhost:5173 — the Vite dev server)
//
// A throwaway setup with a saved conversation on `ui-smoke` (axl_dev only), reopened with its pencil on a 390-px phone.
// Reports what the chat shows and whether a Mentor turn starts. Costs no model call. Removes its fixtures afterwards.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }

const { closeDb, getDb } = await import('../providers/mongodb.provider.js')
const { setupService } = await import('../api/setups/setups.service.js')
const { paperBrokerService } = await import('../api/broker/paperBroker.service.js')

if (process.env.DB_NAME !== 'axl_dev') throw new Error(`refusing to run on ${process.env.DB_NAME}`)
const db = await getDb()
const userId = (await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } }))?.id
if (!userId) throw new Error('the qa user has no id')
const paper = await paperBrokerService.getAccount(userId)
const accounts = paper ? [{ id: paper.accountId, broker: 'paper' }] : []
const made = await setupService.generateSetup({
    asset: 'NVDA', direction: 'long', type: 'swing', conditions: [{ id: 'c1', text: 'CHoCH up on the 15m' }],
    entry_legs: [{ price: 238.6, quantity: 100 }], stop_legs: [{ price: 234.8 }], target_legs: [{ price: 246 }],
}, { userId, accounts, mainAccountId: paper?.accountId ?? null })
const setupId = made?.ok ? made.doc.id : null
if (!setupId) throw new Error(`no fixture: ${made?.reason}`)
const now = Date.now()
const turn = (role, content, i) => ({ role, content, at: now - (10 - i) * 60000 })
await db.collection('agent_contexts').insertOne({
    userId, kind: 'setup', entityId: setupId, agent: 'mentor', summary: null, artifacts: [], sealedAt: now, updatedAt: now,
    messages: [
        turn('user', 'THE FIRST TURN: I think NVDA rebounds from here on the data centre numbers, long for a few weeks.', 1),
        turn('assistant', 'MENTOR ONE: the read holds, here is the entry.', 2),
        turn('user', 'THE SECOND TURN: make the stop deeper.', 3),
        turn('assistant', 'MENTOR TWO: done, the stop is at 234.80.', 4),
    ],
})

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
const page = await ctx.newPage()
const posts = []
page.on('request', r => { if (r.method() === 'POST' && /\/api\/sessions\//.test(r.url())) posts.push(r.url().replace(/.*\/sessions\/[^/]+/, '')) })
page.on('dialog', d => { console.log('DIALOG', d.message()); d.accept().catch(() => {}) })
try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        await page.locator('input').nth(0).fill(USER.username)
        await page.locator('input[type="password"]').fill(USER.password)
        await page.keyboard.press('Enter')
    }
    await page.locator('.chat-timeline').waitFor({ timeout: 20000 })
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: /^Your trades/ }).first().click()
    await page.waitForTimeout(900)
    const row = page.locator('.floor-rowhost', { hasText: 'NVDA' }).first()
    // The pencil is hidden without hover, so a real phone reaches it through a sticky hover. The press is the same.
    await row.locator('button[title="Edit setup in Mentor chat"]').evaluate(b => b.click())
    await page.waitForTimeout(5000)
    const seen = await page.evaluate(() => ({
        title: document.querySelector('.chat-timeline__title')?.textContent,
        toggle: document.querySelector('.chat-timeline__pane-toggle')?.textContent ?? null,
        sealed: [...document.querySelectorAll('.chat-timeline__sealed')].map(e => e.textContent),
        lastRow: [...document.querySelectorAll('.chat-timeline__body > *')].at(-1)?.textContent?.slice(0, 200),
        stopShown: !!document.querySelector('[aria-label="Stop response"]'),
    }))
    console.log('POSTS', JSON.stringify(posts))
    console.log('SEEN', JSON.stringify(seen, null, 1))
    await page.screenshot({ path: `${OUT}/edit-phone-reopened.png` })
} catch (err) {
    console.log('DRIVE ERROR', err.message.slice(0, 400))
} finally {
    await browser.close()
    await db.collection('agent_contexts').deleteMany({ kind: 'setup', entityId: setupId })
    await setupService.deleteSetup(setupId, userId).catch(() => {})
    await closeDb()
}
