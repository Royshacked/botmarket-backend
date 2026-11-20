// DRIVE THE SCREEN — the mode picker in the prompt box (docs/design/modes-and-builders.md M4, step 3): it shows General;
// picking Trader moves the chat to the trader (the header and the placeholder follow); picking General brings it back to
// Axl; and asking Axl to build a trade switches the mode by itself. Desktop + 390px screenshots, the menu open on both.
//
//   node scripts/drive-mode-picker.mjs [baseUrl] [outDir]     (default http://localhost:5173 · .)
//
// As the throwaway QA user `ui-smoke`. One login per run (the auth limiter). The last step runs one real Axl + trader turn.
/* global document, window -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/mode-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const chip = (page) => page.locator('.mode-picker__toggle').getAttribute('aria-label')
const header = async (page) => (await page.locator('.chat-timeline__title').innerText()).replace(/\s+/g, ' ')
const waitChip = (page, label, ms = 20_000) => page.waitForFunction((l) => document.querySelector('.mode-picker__toggle')?.getAttribute('aria-label') === l && !document.querySelector('.mode-picker__toggle.is-pending'), label, { timeout: ms }).then(() => true).catch(() => false)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
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
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    expect(await chip(page) === 'Mode: General', `the picker starts on General (${await chip(page)})`)
    await page.locator('.mode-picker__toggle').click()
    await page.waitForTimeout(400)
    const options = await page.locator('.mode-picker__option-label').allInnerTexts()
    expect(options.join('|') === 'General|Trader|Portfolio manager|Analyst', `the menu: ${options.join(' · ')}`)
    await shot(page, '01-menu-desktop')

    await page.locator('.mode-picker__option', { hasText: 'Trader' }).click()
    expect(await waitChip(page, 'Mode: Trader'), 'picking Trader switches the mode')
    await page.waitForTimeout(800)
    const ph = await page.locator('.chat-timeline textarea').getAttribute('placeholder')
    expect(/Tell the trader/.test(ph ?? ''), `the placeholder follows: "${ph}"`)
    await shot(page, '02-trader')

    await page.locator('.mode-picker__toggle').click()
    await page.locator('.mode-picker__option', { hasText: 'General' }).click()
    expect(await waitChip(page, 'Mode: General'), 'picking General brings it back to Axl')

    // Axl switches it himself on an ask to build.
    const box = page.locator('.chat-timeline textarea')
    await box.fill("I'd like to build a swing trade on NVDA.")
    await box.press('Enter')
    expect(await waitChip(page, 'Mode: Trader', 240_000), 'asking Axl to build a trade switches the mode to Trader')
    await page.waitForFunction(() => !document.querySelector('.chat-timeline__row--live'), null, { timeout: 300_000 }).catch(() => {})
    await page.waitForTimeout(2000)
    console.log('  header:', await header(page))
    await shot(page, '03-axl-switched')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(1500)
    await page.locator('.mode-picker__toggle').click()
    await page.waitForTimeout(400)
    const menuBox = await page.locator('.mode-picker__menu').boundingBox()
    expect(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, `the menu fits the phone (${JSON.stringify(menuBox)})`)
    await shot(page, '04-menu-phone')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    expect(!overflow, 'no sideways scroll at 390px')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
