// DRIVE: ON A PHONE A DESK OPENS WITH ITS WORK LOWERED (Roy, 2026-11-01: "in mobile — when chatting with an agent — by
// default at the beginning of the chat it opens the agent's work window, which covers all the chat box — open it only
// if the user chooses to").
//
// A phone viewport, the Hotlist from the menu, a name's page, Build with Mentor (a DOORWAY, MainPage.openDesk). Proves:
// the chat stays in view with its input; the header offers "Show Mentor's work" (the pane is open, lowered); pressing it
// raises the sheet; the sheet's ✕ lowers it again.
//
//   node scripts/drive-phone-pane-lowered.mjs [baseUrl] [outDir]
//
// Against the Vite dev server (:5173) as `ui-smoke`. The Mentor TURN is answered by the drive (no model spend): what is
// driven is the pane, which opens client-side whatever the turn does. One sign-in.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const shot = (page, name) => page.screenshot({ path: `${OUT}/phone-pane-${name}.png` }).then(() => console.log('  shot:', name))

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message.slice(0, 200)))
// The doorway's turn is not the subject: answered here, so the drive spends nothing on a model.
await page.route(/\/api\/sessions\/[^/]+\/turn/, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"drive"}' }))

/** The side pane's sheet, as the user sees it: on screen and covering the chat's input, or not. */
const sheet = () => page.evaluate(() => {
    const pane = document.querySelector('.side-pane')
    const input = document.querySelector('.chat-timeline textarea')
    const r = pane?.getBoundingClientRect()
    const i = input?.getBoundingClientRect()
    const shown = Boolean(pane && r.height > 40 && r.bottom > 0 && r.top < window.innerHeight && getComputedStyle(pane).visibility !== 'hidden')
    // The input is covered when the point at its centre belongs to something that is not inside the chat.
    const hit = i ? document.elementFromPoint(i.left + i.width / 2, i.top + i.height / 2) : null
    return { shown, inputCovered: Boolean(i && hit && !hit.closest('.chat-timeline')) }
})

try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline').waitFor({ timeout: 20000 })

    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: 'Hotlist' }).click()
    await page.waitForSelector('.hot-panel', { timeout: 60000 })
    await page.locator('.hot-panel').getByRole('button', { name: /^Swing/ }).click()
    await page.waitForSelector('.hot-panel tr.hot-row', { timeout: 60000 })
    await page.locator('.hot-panel tr.hot-row').first().locator('td').nth(0).click()   // a phone: the first cell opens the row's page
    await page.waitForSelector('.hot-page', { timeout: 10000 })
    await page.locator('.hot-panel').getByRole('button', { name: 'Build with Mentor' }).first().click()
    await page.waitForTimeout(2500)
    await shot(page, '1-after-doorway')

    let s = await sheet()
    check('the doorway leaves the work LOWERED — the chat is not covered', !s.shown && !s.inputCovered, JSON.stringify(s))
    const toggle = page.locator('.chat-timeline__pane-toggle')
    const label = (await toggle.textContent().catch(() => '')) ?? ''
    check('the header offers to SHOW Mentor\'s work', /^Show /.test(label.trim()), label)

    await toggle.click()
    await page.waitForTimeout(1200)
    s = await sheet()
    check('pressing Show raises the sheet (the user chose it)', s.shown, JSON.stringify(s))
    await shot(page, '2-shown')

    // The raised sheet sits over the chat header, so it lowers from its own ✕ (SidePane `lower`).
    await page.locator('.side-pane__close').click()
    await page.waitForTimeout(1200)
    s = await sheet()
    const again = ((await page.locator('.chat-timeline__pane-toggle').textContent().catch(() => '')) ?? '').trim()
    check('the sheet\'s ✕ lowers it again — the desk stays open, "Show" offered', !s.shown && !s.inputCovered && /^Show /.test(again), `${JSON.stringify(s)} · ${again}`)
    await shot(page, '3-hidden')
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
    await shot(page, 'error').catch(() => {})
} finally {
    if (errors.length) check('no page errors', false, errors.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
}
