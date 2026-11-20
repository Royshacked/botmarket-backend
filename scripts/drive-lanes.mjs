// DRIVE THE SCREEN — lanes (docs/design/modes-and-builders.md step 5a): Axl's turns no longer wait behind a builder's.
// Start a trade build (the question card), switch to General while the trader works, ask Axl a question — he answers
// at once, while the status line says the trader is working in the background, and the trader's words never stream into
// Axl's bubble.
//
//   node scripts/drive-lanes.mjs [baseUrl] [outDir]     (default http://localhost:5173 · .)
//
// As the throwaway QA user `ui-smoke` (paper). One login per run (the auth limiter). Runs a real trader build.
/* global document -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/lanes-${name}.png` }); console.log('  shot:', name) }
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
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    // A trade build from the picker's card.
    await page.locator('.mode-picker__toggle').click()
    await page.locator('.mode-picker__option', { hasText: 'Trader' }).click()
    await page.waitForSelector('.question-card', { timeout: 30_000 })
    await page.getByLabel('Name: other').fill('AMD')
    const acct = page.locator('.question-card__q', { hasText: 'Account' }).locator('.question-card__option').first()
    if ((await acct.getAttribute('aria-checked')) !== 'true') await acct.click()
    const size = page.locator('.question-card__q', { hasText: 'Size' }).locator('.question-card__option').first()
    if (!(await size.count())) await page.getByLabel('Size: other').fill('$10,000 position, 1% risk, R:R 1.5')
    else if ((await size.getAttribute('aria-checked')) !== 'true') await size.click()
    await page.locator('.question-card__q', { hasText: 'If it breaks' }).locator('.question-card__option', { hasText: 'Redraw it' }).click()
    await page.locator('.question-card__q', { hasText: 'Surprises' }).locator('.question-card__option', { hasText: 'Decide for me' }).click()
    await page.locator('.question-card__submit').click()
    const started = await page.waitForFunction(() => document.querySelector('.chat-timeline__row--live'), null, { timeout: 60_000 }).then(() => true).catch(() => false)
    expect(started, 'the trader started building')
    await page.waitForTimeout(4000)

    // Switch to General mid-build — it lands at once, not after the trader.
    const t0 = Date.now()
    await page.locator('.mode-picker__toggle').click()
    await page.locator('.mode-picker__option', { hasText: 'General' }).click()
    const switched = await page.waitForFunction(() => document.querySelector('.mode-picker__toggle')?.getAttribute('aria-label') === 'Mode: General'
        && !document.querySelector('.mode-picker__toggle.is-pending'), null, { timeout: 30_000 }).then(() => true).catch(() => false)
    expect(switched, `General landed in ${Math.round((Date.now() - t0) / 1000)}s, while the trader works`)
    await page.waitForTimeout(1500)
    const line = await page.evaluate(() => document.querySelector('.chat-timeline__row--behind')?.innerText ?? null)
    console.log('  status line:', line)
    expect(/trader is working in the background/i.test(line ?? ''), 'the status line says the trader works in the background')
    await shot(page, '01-behind')

    const box = page.locator('.chat-timeline textarea')
    const t1 = Date.now()
    await box.fill('Quick one — is the US market open right now?')
    await box.press('Enter')
    const answered = await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll('.chat-timeline__row--user')]
        const asked = rows.findIndex(r => /market open right now/.test(r.innerText))
        if (asked < 0) return false
        const after = document.querySelector('.chat-timeline__messages')?.innerText.split('market open right now?')[1] ?? ''
        return /\bopen|closed\b/i.test(after) && !document.querySelector('.chat-timeline__row--live')
    }, null, { timeout: 120_000 }).then(() => true).catch(() => false)
    const secs = Math.round((Date.now() - t1) / 1000)
    const stillBehind = await page.evaluate(() => !!document.querySelector('.chat-timeline__row--behind'))
    expect(answered, `Axl answered in ${secs}s${stillBehind ? ', the trader still working behind' : ''}`)
    const tail = (await page.locator('.chat-timeline').innerText()).split('market open right now?')[1] ?? ''
    console.log('  after the question:', tail.replace(/\s+/g, ' ').slice(0, 400))
    await shot(page, '02-axl-answered')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
