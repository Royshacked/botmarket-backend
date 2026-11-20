// DRIVE THE SCREEN — Build trade off the Hotlist (Roy, 2026-11-20): the click moves the chat to Trader, opens the
// questions with the name ALREADY PICKED, the user fills the rest, and the trader builds in the background on the
// Hotlist's context. Desktop screenshots.
//
//   node scripts/drive-hotlist-build-trade.mjs [baseUrl] [outDir]     (default http://localhost:5173 · .)
//
// As the throwaway QA user `ui-smoke-panel` (paper). One login per run (the auth limiter). Runs one real trader build.
/* global document */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke-panel', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/build-trade-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }

const browser = await chromium.launch({ channel: 'msedge' })
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

    // Paper: the QA user has a paper account (live has none — the Account question would have nothing to pick).
    await page.getByRole('button', { name: /^paper$/i }).first().click().catch(() => {})
    await page.waitForTimeout(1500)
    await page.waitForSelector('.floor-lists', { timeout: 15000 })
    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForSelector('.hot-horizons', { timeout: 150000 })
    await page.waitForTimeout(1000)

    // The first list with a row that offers a build: its row page, then the build button.
    let sym = null
    for (const tab of ['Swing', 'Long term', 'This week']) {
        await page.locator('.hot-horizons button', { hasText: tab }).first().click()
        await page.waitForTimeout(800)
        const rows = page.locator('.hot-panel tr.hot-row')
        const n = Math.min(await rows.count(), 6)
        for (let i = 0; i < n && !sym; i++) {
            const row = rows.nth(i)
            const s = await row.getAttribute('data-symbol')
            await row.locator('td').nth(3).click()
            await page.waitForSelector('.hot-page', { timeout: 5000 }).catch(() => {})
            const btn = page.locator('.hot-page .floor-queued__btn')
            if (await btn.count()) { sym = s; console.log(`  ${tab}: ${s} — "${await btn.first().innerText()}"`); await shot(page, '01-row'); await btn.first().click() }
            else await page.getByRole('button', { name: '‹ Back to the list' }).click().catch(() => {})
        }
        if (sym) break
    }
    expect(!!sym, 'found a Hotlist name with a build button')
    if (!sym) throw new Error('no buildable row')

    const shown = await page.waitForSelector('.question-card', { timeout: 120_000 }).then(() => true).catch(() => false)
    expect(shown, '1–2. the click moves to Trader and opens the questions')
    await page.waitForTimeout(1200)
    expect(await page.locator('.mode-picker__toggle').getAttribute('aria-label') === 'Mode: Trader', 'the mode is Trader')
    const nameQ = page.locator('.question-card__q').first()
    const picked = await nameQ.locator('.question-card__option[aria-checked="true"] .question-card__option-label').allInnerTexts()
    expect(picked.length === 1 && picked[0] === sym, `3. the name is already filled in (${picked.join(', ') || 'none'})`)
    await shot(page, '02-card')

    // 4. The rest of the fields.
    const q = (h) => page.locator('.question-card__q', { has: page.locator('.question-card__chip', { hasText: h }) })
    const acct = q('Account').locator('.question-card__option').first()
    if (await acct.count() && (await acct.getAttribute('aria-checked')) !== 'true') await acct.click()
    if (!(await q('Size').locator('.question-card__option[aria-checked="true"]').count())) await page.getByLabel('Size: other').fill('$10,000')
    if (!(await q('Risk').locator('.question-card__option[aria-checked="true"]').count())) await q('Risk').locator('.question-card__option', { hasText: '1% of the account' }).click()
    await q('Min R:R').locator('.question-card__option', { hasText: /^1\.5$/ }).click()
    await q('If it breaks').locator('.question-card__option', { hasText: 'Redraw it' }).click()
    await q('Surprises').locator('.question-card__option', { hasText: 'Decide for me' }).click()
    expect(await page.locator('.question-card__submit').isEnabled(), '4. every question answered → Build it is on')
    await shot(page, '03-answered')
    await page.locator('.question-card__submit').click()

    const gone = await page.waitForFunction(() => !document.querySelector('.question-card'), null, { timeout: 30_000 }).then(() => true).catch(() => false)
    expect(gone, 'the card goes once answered')

    // 5. The build in the background — its bar when it is done (ready / declined / failed).
    const bar = await page.waitForSelector('.build-bar', { timeout: 900_000 }).then(() => true).catch(() => false)
    expect(bar, '5. the trader built it in the background')
    if (bar) {
        const text = (await page.locator('.build-bar').first().innerText()).replace(/\s+/g, ' ')
        console.log('  build bar:', text)
        expect(text.includes(sym), `the build is on ${sym}`)
        expect(!/did not finish/.test(text), 'the build did not fail')
    }
    await shot(page, '04-built')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
