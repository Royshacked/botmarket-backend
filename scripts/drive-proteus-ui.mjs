// DRIVE THE SCREEN — Proteus (docs/design/proteus.md): ask Axl how a stock behaves in the real chat, watch the route
// land on Proteus and his answer render, on a desktop and a phone width. Screenshots to look at, not just assertions.
//
//   node scripts/drive-proteus-ui.mjs [baseUrl] [outDir] [TICKER]     (default http://localhost:5173 · . · NVDA)
//
// As the throwaway QA user `ui-smoke` (it must exist — drive-mentor-ui.mjs creates it). One login per run: drives share
// the developer's IP for the auth limiter.
/* global document, window -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const TICKER = (process.argv[4] ?? 'NVDA').toUpperCase()
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/proteus-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
page.on('console', m => { if (m.type() === 'error') errors.push(`console ${m.text().slice(0, 200)}`) })

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
    await shot(page, '01-home')

    const box = page.locator('.chat-timeline textarea')
    await box.fill(`How does ${TICKER} behave? Does it respect any moving average?`)
    await box.press('Enter')
    // Axl routes, Proteus answers: wait for his measured answer or give up after 4 minutes.
    const answered = await page.waitForFunction(() => {
        const t = document.querySelector('.chat-timeline')?.innerText ?? ''
        return /PROTEUS/i.test(t) && /measured/i.test(t)
    }, null, { timeout: 240_000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(4000)
    expect(answered, 'Proteus answered in the chat (his name and a MEASURED read on screen)')
    const text = await page.locator('.chat-timeline').innerText()
    console.log('  timeline tail:', text.replace(/\s+/g, ' ').slice(-700))
    expect(!/<route>|<open>|<ticker>/.test(text), 'no raw tags in the chat')
    await shot(page, '02-desktop-answer')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(1500)
    await shot(page, '03-phone-answer')
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
