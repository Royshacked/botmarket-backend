/* global document -- page.evaluate bodies run in the browser */
// Drive the Hotlist's DID IT WORK on LIVE data (Roy, 2026-10-24): the Result column, a horizon's track record, and
// stepping back a day — the dev database's own boards and outcome log, no fixtures.
//
//   node scripts/drive-hotlist-results.mjs [baseUrl] [outDir] [--in-process]   (default http://localhost:5173 — Vite)
//
// --in-process: /api/hotlist (the day list, a board, the record) is answered by THIS checkout's hotlist.service, run in
// the drive against the real database — for when the dev backend on :3030 runs older code (it is `npm start`, no
// watcher). The page, the session and the clicks are real either way.
//
// Needs a day whose windows have closed and been scored (hotlist_outcomes). One sign-in as `ui-smoke-panel`, reused
// from the session file the other hotlist drives keep — run it alone. LOOK at the screenshots.
import dns from 'dns'
import { existsSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const IN_PROCESS = process.argv.includes('--in-process')
const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2).filter(a => !a.startsWith('--'))
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }
const { userService } = await import('../api/user/user.service.js')

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/hotlist-results-${name}.png` }); console.log('  shot:', name) }
const marks = (page) => page.evaluate(() => [...document.querySelectorAll('.hot-panel tr.hot-row')].map(r => `${r.dataset.symbol}:${r.querySelector('.hot-result')?.textContent ?? '?'}`))

try { await userService.createUser(USER); console.log('qa user created') } catch (e) { console.log('qa user exists —', e.message) }

const browser = await chromium.launch({ channel: 'msedge' })
const errors = [], results = []
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
let page
try {
    const sessionFile = `${OUT}/hotlist-session.json`
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, ...(existsSync(sessionFile) ? { storageState: sessionFile } : {}) })
    page = await ctx.newPage()
    page.on('pageerror', e => errors.push(e.message))
    if (IN_PROCESS) {
        const svc = await import('../services/hotlist.service.js')
        const { houseBook } = await import('../services/houseBook.service.js')
        await page.route('**/api/hotlist**', async route => {
            const url = new URL(route.request().url())
            if (url.pathname.endsWith('/reads')) return route.fallback()
            const board = url.pathname.match(/\/boards\/([^/]+)$/)?.[1]
            const body = board ? await svc.boardWithResults(board)
                : url.pathname.endsWith('/outcomes') ? await svc.hotlistOutcomes()
                : url.pathname.endsWith('/book') ? await houseBook()
                    : await svc.todayHotlist({ day: url.searchParams.get('day') })
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        })
    }
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
        await ctx.storageState({ path: sessionFile })
    }
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.floor-lists', { timeout: 15000 })
    await page.waitForTimeout(1500)
    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForSelector('.hot-panel tr.hot-row', { timeout: 15000 })

    const today = await marks(page)
    await shot(page, '1-latest')
    check('the latest day: every row has a Result cell', today.every(m => !m.endsWith(':?')), today.slice(0, 6).join(' '))

    await page.getByRole('button', { name: 'The day before' }).click()
    await page.waitForTimeout(2000)
    const title = await page.locator('.hot-panel').locator('text=/the day’s list/').count()
    const past = await marks(page)
    await shot(page, '2-day-before')
    const scored = past.filter(m => /[✓✗↑↓]/.test(m))
    check('a day back: its list, with results the outcome log scored', title > 0 && scored.length > 0, `${scored.length} scored of ${past.length}: ${scored.slice(0, 6).join(' ')}`)

    const mid = page.getByRole('button', { name: /^Mid-day \d/ })
    if (await mid.count() && !(await mid.isDisabled())) {
        await mid.click()
        await page.waitForTimeout(500)
        const strip = await page.locator('.hot-record').first().textContent()
        await shot(page, '3-mid-record')
        check("Mid-day's list carries its track record", /Track record · mid-day/.test(strip) && /(reached|up) \d+% of \d+/.test(strip), strip)
        // Argus's record (2026-10-24): his picks, avoids and unmarked names on this horizon, by how they ended.
        const argus = (await page.locator('.hot-record').allTextContents()).find(t => /Argus/.test(t)) ?? ''
        check("Argus's record over the horizon: picks, avoids, unmarked", /picks up \d+% · avg [+-]?\d/.test(argus) && /avoids/.test(argus) && /unmarked/.test(argus), argus)
        const first = page.locator('.hot-panel tr.hot-row').first()
        await first.locator('td').nth(4).click()
        await page.waitForTimeout(300)
        const line = await page.locator('.hot-detail').first().textContent()
        check('the opened row says the result in full', /Result \(Mid-day\):/.test(line) || /open|scoring/.test(await first.locator('.hot-result').textContent()), line.slice(0, 220))
    } else check("Mid-day's list carries its track record", false, 'no mid-day names that day')

    // THE HOUSE'S BOOK (2026-10-24): Swing and Long term — the live coverage by its target's horizon.
    await page.getByRole('button', { name: 'The day after' }).click().catch(() => {})
    await page.waitForTimeout(1500)
    const long = page.getByRole('button', { name: /^Long term \d+/ })
    const longLabel = await long.textContent()
    await long.click()
    await page.waitForTimeout(500)
    const bookRows = await page.locator('.hot-panel tr.hot-row').count()
    const strip = await page.locator('.hot-record').first().textContent().catch(() => '')
    await shot(page, '4-long-term')
    check('Long term lists the buy-rated coverage of the house, with its track record', bookRows > 0 && /Track record · long term/.test(strip), `${longLabel}: ${bookRows} buys · ${strip}`)
    const first = page.locator('.hot-panel tr.hot-row').first()
    const cells = await first.locator('td').allTextContents()
    check('a book row: last, rating, target, upside, by, since set, to target, from', cells.length === 10 && /\d/.test(cells[4]) && /%/.test(cells[5]), cells.join(' | '))
    await first.locator('td').nth(2).click()
    await page.waitForTimeout(400)
    const detail = await page.locator('.hot-detail').first().textContent()
    await shot(page, '5-long-term-open')
    check('the opened book row is the thesis, with the hand-offs', /Build with Mentor/.test(detail) && /Ask Argus/.test(detail) && detail.length > 200, detail.slice(0, 200))
    const swing = page.getByRole('button', { name: /^Swing \d+/ })
    await swing.click()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: /^All \d+$/ }).last().click()
    await page.waitForTimeout(300)
    const swingRows = await page.locator('.hot-panel tr.hot-row').count()
    await shot(page, '6-swing-all')
    check('Swing, All: the holds and sells too', swingRows > 0, `${await swing.textContent()}: ${swingRows} rows`)

    check('no page errors', errors.length === 0, errors.join(' | '))
} catch (err) {
    results.push(`FAIL  the drive stopped — ${err.message}`)
    if (page) await shot(page, 'x-stopped').catch(() => {})
} finally {
    await browser.close()
    console.log(results.join('\n'))
    process.exitCode = results.some(r => r.startsWith('FAIL')) ? 1 : 0
    process.exit()
}
