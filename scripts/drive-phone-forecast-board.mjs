// DRIVE: ON A PHONE THE FORECAST MAP'S "BOARD" BUTTON OPENS PYTHIA'S BOARD (Roy, 2026-11-01: "in mobile — in forecast —
// when clicking board — nothing happens").
//
// A phone viewport, Forecasts from the menu, the map's Board button. Proves the board window opens over the chat.
//
//   node scripts/drive-phone-forecast-board.mjs [baseUrl] [outDir]
//
// Against the Vite dev server (:5173) as `ui-smoke`. One sign-in, no model spend.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const shot = (page, name) => page.screenshot({ path: `${OUT}/phone-board-${name}.png` }).then(() => console.log('  shot:', name))

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message.slice(0, 200)))

/** A window on screen, by its class: rendered, with height, inside the viewport. */
const onScreen = sel => page.evaluate(sel => {
    const el = document.querySelector(sel)
    const r = el?.getBoundingClientRect()
    return Boolean(el && r.height > 40 && r.bottom > 0 && r.top < window.innerHeight && getComputedStyle(el).visibility !== 'hidden')
}, sel)

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
    await page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: 'Forecasts' }).click()
    await page.getByRole('button', { name: 'Board', exact: true }).waitFor({ timeout: 30000 })
    await shot(page, '1-map')
    await page.getByRole('button', { name: 'Board', exact: true }).click()
    await page.waitForTimeout(1500)
    await shot(page, '2-after-board')
    check('Board opens Pythia\'s board window', await onScreen('.floor-panel--board'))
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
