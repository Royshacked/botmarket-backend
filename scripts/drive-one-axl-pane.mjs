// DRIVE THE SCREEN — One Axl step 4 (docs/design/one-axl.md §5): the work pane names the ITEM being built
// ("NVDA · long swing trade"), never who builds it, and Info lists things to do, not desks.
//
//   node scripts/drive-one-axl-pane.mjs [baseUrl] [outDir] [TICKER]     (default http://localhost:5173 · . · NVDA)
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
const NAMES = /\b(Mentor|Prometheus|Atlas|Argus|Proteus|Pythia|Aether|Talos|Themis|Daedalus)\b|\b\w+ Desk\b/
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/one-axl-pane-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }

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
    const signedIn = await page.locator('.chat-timeline textarea').count()
    expect(signedIn > 0, 'signed in (the login limiter let us through)')
    if (!signedIn) throw new Error('not signed in — the auth limiter? wait 15 minutes')
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    const box = page.locator('.chat-timeline textarea')
    await box.fill(`I want to build a long swing trade on ${TICKER}`)
    await box.press('Enter')
    // The trader takes it; wait for his turn to settle and the pane tab to name the trade.
    const titled = await page.waitForFunction((t) => {
        const tabs = [...document.querySelectorAll('[role="tab"]')].map(n => n.textContent)
        return tabs.some(x => x.includes(`${t} ·`)) && !document.querySelector('.chat-timeline__row--live')
    }, TICKER, { timeout: 300_000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(3000)
    const tabs = await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map(n => n.textContent))
    console.log('  pane tabs:', JSON.stringify(tabs))
    expect(titled, `the pane tab names the trade (${tabs.join(' | ')})`)
    expect(tabs.every(t => !NAMES.test(t)), 'no agent or desk name on a tab')
    await shot(page, '01-desktop-trade')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: 'Info' }).click()
    await page.waitForTimeout(800)
    const info = await page.locator('.chat-info').innerText()
    expect(/What I can do/.test(info) && /Build a trade/.test(info), 'Info lists things to do')
    expect(!NAMES.test(info), 'Info names no agent and no desk')
    await shot(page, '02-phone-info')
    const body = await page.evaluate(() => document.body.innerText)
    const hit = body.match(NAMES)
    expect(!hit, `no agent or desk name anywhere on the page${hit ? ` — found "${hit[0]}"` : ''}`)
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
