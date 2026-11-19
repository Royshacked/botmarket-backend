/* global document, window -- page.evaluate bodies run in the browser */
// Drive the Hotlist's ECHO tab (docs/design/echo-pipeline.md "The app") — desk and phone widths.
//
//   node scripts/drive-hotlist-echo.mjs [outDir] [--build]
//
// Real page, panel, session, backend and data: the dev backend serves the pipeline's own events (echo_events in the dev
// db) — store a scored event there first. Opens the Cisco event, its ranked links, a name's page ("Why it scores"), and
// Back; with --build (desk only), "Build with the trader" — one real Mentor turn. Signs in as `ui-smoke`. LOOK at the
// screenshots.
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const OUT = args.find(a => !a.startsWith('--')) ?? '.'
const BUILD = args.includes('--build')
const BASE = 'http://localhost:5173'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }

const errors = []
const check = (label, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
const browser = await chromium.launch({ channel: 'msedge' })
try {
    for (const [tag, viewport] of [['desk', { width: 1600, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
        const sessionFile = `${OUT}/session.json`
        const ctx = await browser.newContext({ viewport, ...(existsSync(sessionFile) ? { storageState: sessionFile } : {}) })
        const page = await ctx.newPage()
        page.on('pageerror', e => errors.push(e.message))
        page.on('console', m => { if (m.type() === 'error' || /Warning:/.test(m.text())) errors.push(m.text().slice(0, 200)) })
        await page.goto(BASE, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(2000)
        if (await page.locator('input[type="password"]').count()) {
            const inputs = page.locator('input')
            await inputs.nth(0).fill(USER.username); await inputs.nth(1).fill(USER.password)
            await page.keyboard.press('Enter'); await page.waitForTimeout(3500)
            await ctx.storageState({ path: sessionFile })
        }
        await page.evaluate(() => localStorage.setItem('design', 'floor'))
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(2500)
        if (tag === 'phone') {
            await page.getByRole('button', { name: 'Open menu' }).click({ timeout: 20000 })
            await page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: 'Hotlist' }).click()
        } else {
            await page.waitForSelector('.floor-lists', { timeout: 20000 })
            await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
        }
        await page.waitForSelector('.hot-horizons', { timeout: 45000 })
        await page.waitForTimeout(800)
        const tabs = await page.locator('.hot-horizons button').allTextContents()
        check(`${tag}: Echo tab last`, tabs.at(-1) === 'Echo · test', tabs.join(' | '))
        await page.locator('.hot-horizons button', { hasText: 'Echo · test' }).click()
        await page.waitForSelector('.echo-label', { timeout: 10000 })
        check(`${tag}: label first`, /Echo — unproven/.test(await page.locator('.echo-label').textContent()))
        await page.waitForSelector('.echo-events tbody tr', { timeout: 15000 })
        const rows = await page.locator('.echo-events > tbody > tr:not(.echo-open)').allTextContents()
        check(`${tag}: the events, every kind`, rows.length > 0, rows.slice(0, 5).join(' || '))
        await page.screenshot({ path: `${OUT}/echo-${tag}-list.png`, fullPage: false })
        await page.locator('.echo-events tbody tr', { hasText: 'CSCO' }).first().click()
        await page.waitForSelector('.echo-links', { timeout: 15000 })
        const linkRows = await page.locator('.echo-links tbody tr').evaluateAll(trs => trs.map(tr => [tr.getAttribute('data-symbol'), tr.children[3]?.textContent]))
        const scores = linkRows.map(r => Number.parseInt(r[1], 10)).filter(Number.isFinite)
        check(`${tag}: Cisco's links ranked by score`, scores.length > 0 && scores.every((s, i) => i === 0 || s <= scores[i - 1]), linkRows.slice(0, 6).map(r => r.join(' ')).join(', '))
        check(`${tag}: the record and its durability`, /Durability: price spike/.test(await page.locator('.echo-detail').textContent()))
        await page.screenshot({ path: `${OUT}/echo-${tag}-open.png`, fullPage: false })
        const width = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
        check(`${tag}: no sideways page scroll`, width[0] <= width[1], `${width[0]} vs ${width[1]}`)
        // The top name → its page: why it scores, how it trades, the analyst; Back to the event.
        const sym = (await page.locator('.echo-links tbody .hot-sym').first().textContent()).trim()
        await page.locator('.echo-links tbody .hot-sym').first().click()
        await page.waitForSelector('.hot-page', { timeout: 15000 })
        const body = await page.locator('.hot-page').textContent()
        check(`${tag}: ${sym} opens its page`, (await page.locator('.hot-page__sym').textContent()) === sym)
        check(`${tag}: why it scores, factor by factor`, /Why it scores \d+ \/ 12/.test(body) && /Lock-in/.test(body) && /Bottleneck/.test(body) && /Coverage/.test(body))
        check(`${tag}: how it trades`, (await page.locator('.hot-profile').count()) === 1)
        check(`${tag}: a lead, not a pick`, /a lead, not a pick/.test(body))
        await page.waitForTimeout(5000)
        await page.screenshot({ path: `${OUT}/echo-${tag}-name.png`, fullPage: false })
        await page.locator('.echo-factors').scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${OUT}/echo-${tag}-factors.png`, fullPage: false })
        const width2 = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
        check(`${tag}: the page, no sideways scroll`, width2[0] <= width2[1], `${width2[0]} vs ${width2[1]}`)
        if (BUILD && tag === 'desk') {
            await page.getByRole('button', { name: 'Build with the trader' }).click()
            await page.waitForTimeout(4000)
            const chat = await page.locator('body').textContent()
            check('desk: to the trader with the name', new RegExp(`work on a ${sym} trade`).test(chat))
            await page.waitForTimeout(40000)
            await page.screenshot({ path: `${OUT}/echo-desk-mentor.png`, fullPage: false })
        } else {
            await page.getByRole('button', { name: /Back/ }).first().click()
            await page.waitForSelector('.echo-links', { timeout: 15000 })
            check(`${tag}: back to the opened event`, (await page.locator('.echo-links tbody tr').count()) === linkRows.length)
        }
        await ctx.close()
    }
} finally { await browser.close() }
console.log('errors:', errors.length ? errors.join('\n  ') : 'none')
process.exit(0)
