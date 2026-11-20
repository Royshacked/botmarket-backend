// DRIVE THE SCREEN AT 390px — modes and builders on a phone (docs/design/modes-and-builders.md step 10): the mode picker
// and its menu, the trader's question card (it scrolls inside itself, Build it in reach), then the build in the background
// — the chat back on General, the status line, the pane lowered with its dot — and no sideways scroll anywhere.
//
//   node scripts/drive-builds-phone.mjs [baseUrl] [outDir] [TICKER]     (default http://localhost:5173 · . · MSFT)
//
// As the throwaway QA user `ui-smoke` (paper). One login (the auth limiter). Starts a real trader build and does not wait
// for it to finish — the desktop drives cover the end (drive-lanes, drive-build-summary).
/* global document, window -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const TICKER = (process.argv[4] ?? 'MSFT').toUpperCase()
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/phone-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

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
    expect(await page.locator('.mode-picker__toggle').count() > 0, 'signed in')
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    await page.locator('.mode-picker__toggle').click()
    await page.waitForTimeout(400)
    const menu = await page.locator('.mode-picker__menu').boundingBox()
    expect(menu && menu.x >= 0 && menu.x + menu.width <= 390, `the mode menu fits (${JSON.stringify(menu)})`)
    await shot(page, '01-menu')
    await page.locator('.mode-picker__option', { hasText: 'Trader' }).click()
    await page.waitForSelector('.question-card', { timeout: 30_000 })
    await page.waitForTimeout(1000)
    const card = await page.locator('.question-card').boundingBox()
    expect(card && card.x >= 0 && card.x + card.width <= 390, `the card fits (${JSON.stringify(card)})`)
    expect(await noSideways(page), 'no sideways scroll with the card')
    await shot(page, '02-card')

    await page.getByLabel('Name: other').fill(TICKER)
    const q = (h) => page.locator('.question-card__q', { has: page.locator('.question-card__chip', { hasText: h }) })
    const picked = async (h) => (await q(h).locator('.question-card__option[aria-checked="true"]').count()) > 0
    if (!(await picked('Account'))) await q('Account').locator('.question-card__option').first().click()
    if (!(await picked('Size'))) await page.getByLabel('Size: other').fill('$10,000')
    if (!(await picked('Risk'))) await q('Risk').locator('.question-card__option', { hasText: '1% of the account' }).click()
    await q('Min R:R').locator('.question-card__option', { hasText: /^2$/ }).click()
    await q('If it breaks').locator('.question-card__option', { hasText: 'Redraw it' }).click()
    await q('Surprises').locator('.question-card__option', { hasText: 'Decide for me' }).click()
    // Build it must be reachable without leaving the card (its foot stays on screen).
    const submit = await page.locator('.question-card__submit').boundingBox()
    expect(submit && submit.y + submit.height <= 844, `Build it is on screen (${JSON.stringify(submit)})`)
    await page.locator('.question-card__submit').click()

    const general = await page.waitForFunction(() => document.querySelector('.mode-picker__toggle')?.getAttribute('aria-label') === 'Mode: General', null, { timeout: 30_000 }).then(() => true).catch(() => false)
    expect(general, 'back on General by itself')
    const line = await page.waitForFunction(() => document.querySelector('.chat-timeline__row--behind')?.innerText ?? null, null, { timeout: 30_000 }).then(h => h.jsonValue()).catch(() => null)
    expect(/building .* in the background/i.test(line ?? ''), `the status line: "${line}"`)
    // The pane on a phone is a sheet: lowered, its toggle carries the dot (SidePane: collapse on handheld).
    const sheetUp = await page.evaluate(() => !!document.querySelector('.side-pane--sheet'))
    console.log('  the pane sheet is', sheetUp ? 'up' : 'down')
    expect(await noSideways(page), 'no sideways scroll while it builds')
    await shot(page, '03-building')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
