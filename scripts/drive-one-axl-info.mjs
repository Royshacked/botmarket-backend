// DRIVE THE SCREEN — One Axl step 5 (docs/design/one-axl.md §6): Info is a DIAGRAM of the flow the user is in, the
// step they are on lit. The Hotlist (pick a horizon → pick a name → build the trade → arm it), then a trade being built
// from it, on a desktop (the Info column) and a phone (the chat's Info sheet).
//
//   node scripts/drive-one-axl-info.mjs [baseUrl] [outDir] [TICKER]     (default http://localhost:5173 · . · NVDA)
//
// As the throwaway QA user `ui-smoke`. ONE login per run — drives share the developer's IP for the auth limiter.
/* global document, window -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const TICKER = (process.argv[4] ?? 'NVDA').toUpperCase()
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/one-axl-info-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const diagram = (page) => page.evaluate(() => {
    const d = document.querySelector('.floor-info .flow-diagram, .chat-info .flow-diagram')
    if (!d) return null
    return { title: d.querySelector('.flow-diagram__title')?.textContent, here: d.querySelector('[aria-current="step"] .flow-diagram__label')?.textContent }
})

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
    if (!(await page.locator('.chat-timeline textarea').count())) await page.waitForTimeout(5000)
    if (!(await page.locator('.chat-timeline textarea').count())) { await shot(page, '00-not-signed-in'); throw new Error('not signed in — the auth limiter? wait 15 minutes') }
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    // The Hotlist: picking a name.
    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForTimeout(2500)
    let d = await diagram(page)
    console.log('  info:', JSON.stringify(d))
    expect(d?.title === 'From the Hotlist' && d?.here === 'Pick a name', 'Hotlist open → "From the Hotlist", on "Pick a name"')
    await shot(page, '01-hotlist')

    // A trade from it: the diagram moves to "Build the trade".
    const box = page.locator('.chat-timeline textarea')
    await box.fill(`I want to build a long swing trade on ${TICKER}`)
    await box.press('Enter')
    const moved = await page.waitForFunction(() => document.querySelector('.floor-info [aria-current="step"] .flow-diagram__label')?.textContent === 'Build the trade',
        null, { timeout: 300_000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(2000)
    d = await diagram(page)
    console.log('  info:', JSON.stringify(d))
    expect(moved, 'a trade on the table → the diagram is on "Build the trade"')
    await shot(page, '02-hotlist-building')

    // Close the Hotlist: the flow becomes the trade build itself.
    await page.locator('.detail-panel__close').first().click()   // the panel's × (DetailPanel)
    await page.waitForTimeout(1500)
    d = await diagram(page)
    console.log('  info:', JSON.stringify(d))
    expect(d?.title === 'Building a trade', 'Hotlist closed, trader at work → "Building a trade"')
    await shot(page, '03-trade')

    // Phone: the chat's Info sheet draws the same diagram.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(1500)
    // On a phone the work pane is a bottom sheet OVER the app — lower it (Esc closes the top sheet) to reach the chat's Info.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
    await page.getByRole('button', { name: 'Info', exact: true }).click({ timeout: 20000 })
    await page.waitForTimeout(800)
    d = await diagram(page)
    console.log('  phone info:', JSON.stringify(d))
    expect(Boolean(d?.title && d?.here), 'the phone Info sheet opens on the diagram')
    await shot(page, '04-phone-info')
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
