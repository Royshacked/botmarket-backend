// DRIVE THE SCREEN — Mentor's ONE QUESTION (docs/design/argus-rework.md §2.2): in the real chat, ask for a swing trade,
// answer Mentor's one question (position size, risk, R:R), and watch the build end "saved and armed" — then the setup in
// the trades list. Screenshots at each step; the user's own marked account is what the turn carries (the screen's).
//
//   node scripts/drive-mentor-oneq-ui.mjs [baseUrl] [outDir] [TICKER]      (default http://localhost:5173 · . · EQPT)
//
// As the throwaway QA user `ui-smoke`. Leaves a real ARMED setup on its paper account. One login per run (the auth
// limiter counts the developer's IP); never run while another drive is using `ui-smoke` (they share its session).
/* global document, window -- page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const TICKER = (process.argv[4] ?? 'EQPT').toUpperCase()
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/oneq-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true; return ok }
const timeline = (page) => page.locator('.chat-timeline').innerText().catch(() => '')
const waitText = (page, re, ms) => page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('.chat-timeline')?.innerText ?? ''), re.source, { timeout: ms }).then(() => true).catch(() => false)

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
    // A fresh session, so the timeline is this drive's alone.
    const fresh = page.locator('button:has-text("New session") >> visible=true').first()
    if (await fresh.count()) { await fresh.click().catch(() => {}); await page.waitForTimeout(1500) }
    await shot(page, '01-start')

    const box = page.locator('.chat-timeline textarea')
    await box.fill(`Let's swing on ${TICKER}.`)
    await box.press('Enter')
    const asked = await waitText(page, /position size/, 240_000)
    await page.waitForTimeout(3000)
    expect(asked, 'Mentor asked for position size, risk and R:R')
    const ask = (await timeline(page)).replace(/\s+/g, ' ')
    console.log('  ask:', ask.slice(-600))
    expect(!/all the way|checkpoints|A, B or both|how long should|let it go\?/i.test(ask.slice(-1200)), '…and nothing else')
    await shot(page, '02-the-question')

    await box.fill('Position size $5,000, risk $100, R:R 2.')
    await box.press('Enter')
    // Built, maybe held for Prometheus's read, then generated and armed: the session closes and Axl's line says so.
    const done = await waitText(page, /saved and armed/, 480_000)
    await page.waitForTimeout(2000)
    const after = (await timeline(page)).replace(/\s+/g, ' ')
    expect(done, `"saved and armed" on screen${done ? '' : ` — last: ${after.slice(-500)}`}`)
    await shot(page, '03-saved-and-armed')

    // The setup in the trades list.
    await page.locator('text=Your trades >> visible=true').first().click().catch(() => {})
    await page.waitForTimeout(2500)
    const list = await page.locator('body').innerText()
    expect(new RegExp(TICKER).test(list), `${TICKER} in Your trades`)
    await shot(page, '04-your-trades')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(1500)
    expect(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'no sideways scroll at 390px')
    await shot(page, '05-phone')
} catch (err) {
    console.error('drive error:', err.message.split('\n')[0])
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
