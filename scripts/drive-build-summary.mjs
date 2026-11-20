// DRIVE THE SCREEN — the build's SUMMARY (docs/design/modes-and-builders.md step 6), after the background build (step 5): answer the trader's
// card → the chat goes back to General by itself, the pane says the trader is building, the chat's status line says it;
// Axl answers a question at once meanwhile, and knows how the build is going; the build ends READY (announced, never saved
// on its own) or comes back needing the user. Desktop screenshots.
//
//   node scripts/drive-lanes.mjs [baseUrl] [outDir] [TICKER]     (default http://localhost:5173 · . · AMD)
//
// As the throwaway QA user `ui-smoke` (paper). One login per run (the auth limiter). Runs a real trader build.
/* global document -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const TICKER = (process.argv[4] ?? 'AMD').toUpperCase()
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/summary-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }

// The three numbers (2026-11-20: each its own question). Last time's option stays when it is there.
async function answerNumbers(page) {
    const q = (h) => page.locator('.question-card__q', { has: page.locator('.question-card__chip', { hasText: h }) })
    const picked = async (h) => (await q(h).locator('.question-card__option[aria-checked="true"]').count()) > 0
    if (!(await picked('Size'))) await page.getByLabel('Size: other').fill('$10,000')
    if (!(await picked('Risk'))) await q('Risk').locator('.question-card__option', { hasText: '1% of the account' }).click()
    await q('Min R:R').locator('.question-card__option', { hasText: /^1\.5$/ }).click()
}

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
    expect(await page.locator('.mode-picker__toggle').count() > 0, 'signed in (the auth limiter let us in)')
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    await page.locator('.mode-picker__toggle').click()
    await page.locator('.mode-picker__option', { hasText: 'Trader' }).click()
    await page.waitForSelector('.question-card', { timeout: 30_000 })
    await page.getByLabel('Name: other').fill(TICKER)
    const acct = page.locator('.question-card__q', { hasText: 'Account' }).locator('.question-card__option').first()
    if ((await acct.getAttribute('aria-checked')) !== 'true') await acct.click()
    await answerNumbers(page)
    await page.locator('.question-card__q', { hasText: 'If it breaks' }).locator('.question-card__option', { hasText: 'Redraw it' }).click()
    await page.locator('.question-card__q', { hasText: 'Surprises' }).locator('.question-card__option', { hasText: 'Decide for me' }).click()
    await page.locator('.question-card__submit').click()

    const ready = async (ms) => page.waitForFunction(() => /is ready/.test(document.querySelector('.build-bar__text')?.innerText ?? ''), null, { timeout: ms }).then(() => true).catch(() => false)
    const status = () => page.evaluate(() => document.querySelector('.side-pane__build-status')?.innerText ?? null)
    expect(await ready(600_000), `built: the bar says it is ready (${await status()})`)
    await page.locator('.build-bar__btn', { hasText: 'Watch summary' }).click()
    await page.waitForSelector('.build-summary', { timeout: 10_000 })
    await page.waitForTimeout(2500)
    const reasoning = await page.evaluate(() => document.querySelector('.build-summary__reasoning')?.innerText ?? '')
    console.log('  reasoning:', reasoning.replace(/\s+/g, ' ').slice(0, 300))
    expect(reasoning.length > 40, "the summary holds the trader's reasoning")
    expect(await page.locator('.build-summary__chart').count() > 0, 'and the live trade chart')
    await shot(page, '01-summary')

    // Change → back to work in the background → ready again.
    await page.locator('.build-summary__btn', { hasText: 'Change' }).click()
    await page.getByLabel('The change').fill('Keep only scenario A, the pullback entry.')
    await page.locator('.build-summary__btn', { hasText: 'Rebuild it' }).click()
    const back = await page.waitForFunction(() => /is building/.test(document.querySelector('.side-pane__build-status')?.innerText ?? ''), null, { timeout: 30_000 }).then(() => true).catch(() => false)
    expect(back, 'Change sent it back to the background')
    expect(await page.locator('.build-summary').count() === 0, 'the summary closed while it rebuilds')
    expect(await ready(600_000), `rebuilt: ready again (${await status()})`)
    await page.locator('.build-bar__btn', { hasText: 'Watch summary' }).click()
    await page.waitForSelector('.build-summary', { timeout: 10_000 })
    await page.waitForTimeout(2000)
    const again = await page.evaluate(() => document.querySelector('.build-summary__reasoning')?.innerText ?? '')
    console.log('  after the change:', again.replace(/\s+/g, ' ').slice(0, 300))
    await shot(page, '02-changed')

    // Confirm → saved and armed: the session ends with the line saying so (act.endAfterCommit).
    await page.locator('.build-summary__btn--primary').click()
    const saved = await page.waitForFunction(() => /saved and armed|saved —|watching/i.test(document.querySelector('.chat-timeline')?.innerText ?? ''), null, { timeout: 60_000 }).then(() => true).catch(() => false)
    const line = await page.evaluate(() => (document.querySelector('.chat-timeline')?.innerText ?? '').match(/[^\n]*(saved and armed|saved —)[^\n]*/i)?.[0] ?? null)
    expect(saved, `Confirm saved it: "${line}"`)
    await shot(page, '03-confirmed')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
