/* global document, window -- page.evaluate bodies run in the browser */
// Drive the Hotlist's ECHO tab (docs/design/echo-desk.md step 2) — desk and phone widths.
//
//   AETHER_DB=test node scripts/drive-hotlist-echo.mjs [outDir]
//
// The page, panel, session and clicks are real; /api/hotlist/echo* is answered IN THIS PROCESS by the server's own
// echo.service (so a dev backend started before the route still drives) from the engine's db — AETHER_DB=test reads
// prod's forward test, read only. Signs in as `ui-smoke`. LOOK at the screenshots.
import dns from 'node:dns'
import { existsSync } from 'node:fs'
import 'dotenv/config'
import { chromium } from 'playwright'
import { echoService } from '../services/echo.service.js'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [OUT = '.'] = process.argv.slice(2)
const BASE = 'http://localhost:5173'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }

const list = await echoService.listEvents()
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
        await page.route('**/api/hotlist/echo**', async route => {
            const id = new URL(route.request().url()).pathname.match(/\/echo\/([^/]+)$/)?.[1]
            const body = id ? await echoService.getEvent(decodeURIComponent(id)) : list
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        })
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
        check(`${tag}: label first`, /Forward test — unproven/.test(await page.locator('.echo-label').textContent()))
        await page.waitForSelector('.echo .hot-table tbody tr', { timeout: 15000 })
        const rows = await page.locator('.echo-events > tbody > tr:not(.echo-open)').allTextContents()
        check(`${tag}: one row per event`, rows.length === list.events.length, rows.join(' || '))
        await page.screenshot({ path: `${OUT}/echo-${tag}-list.png`, fullPage: false })
        await page.locator('.echo tbody tr', { hasText: 'CSCO' }).first().click()
        await page.waitForSelector('.echo-links', { timeout: 15000 })
        const links = await page.locator('.echo-links tbody tr').count()
        check(`${tag}: CSCO opens to its links`, links > 0, `${links} rows`)
        check(`${tag}: direction explained`, /fell on the event/.test(await page.locator('.echo-detail').textContent()))
        await page.screenshot({ path: `${OUT}/echo-${tag}-open.png`, fullPage: false })
        const width = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
        check(`${tag}: no sideways page scroll`, width[0] <= width[1], `${width[0]} vs ${width[1]}`)
        await ctx.close()
    }
} finally { await browser.close() }
console.log(results.join('\n'))
console.log('errors:', errors.length ? errors.join('\n  ') : 'none')
process.exit(0)
