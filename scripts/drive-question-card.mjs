// DRIVE THE SCREEN — a builder's question card (docs/design/modes-and-builders.md step 4): asking Axl for a trade on NVDA
// switches to Trader and shows the card above the prompt box, NVDA offered first; answering it runs the trader on the
// answers — and he must NOT ask the size, risk or R:R again; the answered card stays in the thread as "Your answers".
// Then the picker's Portfolio manager shows the portfolio card. Desktop + 390px screenshots.
//
//   node scripts/drive-question-card.mjs [baseUrl] [outDir]     (default http://localhost:5173 · .)
//
// As the throwaway QA user `ui-smoke` (paper). One login per run (the auth limiter). Runs one real Axl and trader turn.
/* global document, window -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/card-${name}.png` }); console.log('  shot:', name) }
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

    const box = page.locator('.chat-timeline textarea')
    await box.fill("I'd like to build a swing trade on NVDA.")
    await box.press('Enter')
    const shown = await page.waitForSelector('.question-card', { timeout: 240_000 }).then(() => true).catch(() => false)
    expect(shown, 'the card shows above the prompt box')
    await page.waitForTimeout(1500)
    expect(await page.locator('.mode-picker__toggle').getAttribute('aria-label') === 'Mode: Trader', 'the mode is Trader')
    const names = await page.locator('.question-card__q').first().locator('.question-card__option-label').allInnerTexts()
    expect(names[0] === 'NVDA', `NVDA offered first (${names.join(' · ')})`)
    const heads = await page.locator('.question-card__chip').allInnerTexts()
    console.log('  questions:', heads.join(' · '))
    await shot(page, '01-card')

    await page.locator('.question-card__option', { hasText: 'NVDA' }).first().click()
    const acct = page.locator('.question-card__q', { hasText: 'Account' }).locator('.question-card__option').first()
    if (await acct.count()) { if ((await acct.getAttribute('aria-checked')) !== 'true') await acct.click() }
    await page.getByLabel('Size: other').fill('$10,000 position, 1% risk, R:R 1.5')
    await page.locator('.question-card__q', { hasText: 'If it breaks' }).locator('.question-card__option', { hasText: 'Redraw it' }).click()
    await page.locator('.question-card__q', { hasText: 'Surprises' }).locator('.question-card__option', { hasText: 'Decide for me' }).click()
    expect(await page.locator('.question-card__submit').isEnabled(), 'every question answered → Build it is on')
    await shot(page, '02-answered')
    await page.locator('.question-card__submit').click()

    const gone = await page.waitForFunction(() => !document.querySelector('.question-card'), null, { timeout: 30_000 }).then(() => true).catch(() => false)
    expect(gone, 'the card goes once answered')
    const summary = await page.waitForSelector('.chat-timeline__answered', { timeout: 30_000 }).then(() => true).catch(() => false)
    expect(summary, '"Your answers" stays in the thread')
    // The trader's turns on the answers (a read landing runs him again) — settled when nothing has run for 25 s.
    const t0 = Date.now()
    let quietSince = Date.now()
    while (Date.now() - t0 < 600_000 && Date.now() - quietSince < 25_000) {
        const live = await page.evaluate(() => !!document.querySelector('.chat-timeline__row--live') || /thinking…|Pulling|reading/i.test(document.querySelector('.chat-timeline__messages')?.innerText.slice(-200) ?? ''))
        if (live) quietSince = Date.now()
        await page.waitForTimeout(2000)
    }
    const text = await page.locator('.chat-timeline').innerText()
    const at = text.toLowerCase().lastIndexOf('your answers')
    expect(at >= 0, 'found the answers in the thread')
    const after = text.slice(at)
    console.log('  after the answers:', after.replace(/\s+/g, ' ').slice(0, 900))
    // A QUESTION about what was answered — not his rules block ("Your numbers: your position size, your risk and the R:R
    // you want set the highest entry…", which explains, never asks).
    expect(!/(give me|tell me|what('s| is)|how much is) your (position size|risk|R:R)[^.]*\?|all the way, or (go through it )?step by step\?/i.test(after), 'the trader does not ask the answered questions again')
    await shot(page, '03-trader')

    // The picker's Portfolio manager: its own card.
    await page.locator('.mode-picker__toggle').click()
    await page.locator('.mode-picker__option', { hasText: 'Portfolio manager' }).click()
    const pm = await page.waitForFunction(() => /Objective/.test(document.querySelector('.question-card')?.innerText ?? ''), null, { timeout: 120_000 }).then(() => true).catch(() => false)
    expect(pm, "picking Portfolio manager shows the mandate's card")
    await shot(page, '04-portfolio-card')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(1500)
    await shot(page, '05-phone')
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
