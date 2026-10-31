/* global document */
// Drive THIS WEEK on the run-up reads (docs/design/runup-reads.md; Roy, 2026-10-31: "in hotlist - week run up - why no
// names?"): a USER's This week opens on Prometheus's confirmed names — now the ones he says are worth the run-up, target
// or not — each row reads "run-up", and a row's page carries his two answers.
//
//   node scripts/drive-hotlist-runup-reads.mjs [baseUrl] [outDir]   (default http://localhost:5173 — the Vite dev server)
//
// /api/hotlist is answered IN THIS PROCESS from the DB in .env (as drive-hotlist-row-page.mjs); the reads come from the
// dev backend. A plain user (no admin override): the list a user sees. One sign-in as `ui-smoke-panel` — run it alone.
import dns from 'dns'
import { existsSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }
const { userService } = await import('../api/user/user.service.js')
const svc = await import('../services/hotlist.service.js')
const { catalystReadService } = await import('../services/catalystRead.service.js')

try { await userService.createUser(USER); console.log('qa user created') } catch (e) { console.log('qa user exists —', e.message) }

const today = await svc.todayHotlist({})
// The FE's own pick (hotlist.utils readsBySymbol / isConfirmedRead — code review 2026-10-31: a copy that differed failed a
// correct page): an active read from any day, a settled one only from this list's day; the active one, else the newest.
const { readsBySymbol, isConfirmedRead } = await import('../../botmarket-frontend/src/cmps/Floor/hotlist.utils.js')
const byRead = readsBySymbol(await catalystReadService.listReads(), today.day)
const week = (today.day_list ?? []).filter(r => r.cells?.week?.grade).map(r => r.symbol)
const confirmed = week.filter(s => isConfirmedRead(byRead.get(s))).sort()
console.log('the hotlist:', today.day, `${today.day_list?.length ?? 0} names; Prometheus confirmed ${confirmed.length}: ${confirmed.join(' ')}`)

const browser = await chromium.launch({ channel: 'msedge' })
const errors = [], results = []
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
const sessionFile = `${OUT}/hotlist-session.json`
let page = null

try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, ...(existsSync(sessionFile) ? { storageState: sessionFile } : {}) })
    page = await ctx.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/api/hotlist**', async route => {
        const url = new URL(route.request().url())
        if (url.pathname.endsWith('/reads')) return route.fallback()
        const board = url.pathname.match(/\/boards\/([^/]+)$/)?.[1]
        const body = board ? await svc.boardWithResults(board) : url.searchParams.get('day') ? await svc.todayHotlist({ day: url.searchParams.get('day') }) : today
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
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
    await page.waitForSelector('.hot-horizons', { timeout: 150000 })
    await page.locator('.hot-horizons button').nth(0).click()
    await page.waitForTimeout(2500)
    await page.screenshot({ path: `${OUT}/hotlist-runup-week.png` })

    const shown = await page.evaluate(() => [...document.querySelectorAll('.hot-panel tr.hot-row')].map(r => r.getAttribute('data-symbol')).filter(Boolean).sort())
    const tab = await page.locator('.hot-horizons button').nth(0).textContent()
    check('This week lists the names Prometheus confirmed — no longer empty', shown.length > 0 && shown.join(' ') === confirmed.join(' '), `shown ${shown.join(' ')}`)
    check('the tab count is the list it opens on', new RegExp(`\\b${confirmed.length}\\b`).test(tab ?? ''), tab)
    const cells = await page.evaluate(() => document.querySelector('.hot-panel .hot-table-wrap')?.textContent ?? '')
    check('a confirmed row with no target reads "run-up"', /run-up/.test(cells))
    check('no row says hold (every read is an exit)', !/\d{2}-\d{2} hold/.test(cells))

    const row = page.locator('.hot-panel tr.hot-row').first()
    if (await row.count()) {
        await row.locator('td').nth(3).click()
        await page.waitForSelector('.hot-page', { timeout: 5000 })
        await page.waitForTimeout(1200)
        await page.screenshot({ path: `${OUT}/hotlist-runup-page.png` })
        const text = await page.evaluate(() => document.querySelector('.hot-page')?.textContent ?? '')
        check('the row page shows (a): worth the run-up — yes, with why', /Worth the run-up:\s*yes\s*—/.test(text))
        check('the row page shows (b): the report — out before it, with why', /The report:\s*out before it/.test(text))
    }
    await ctx.close()
} catch (e) {
    errors.push(e.message)
    await page?.screenshot({ path: `${OUT}/hotlist-runup-error.png` }).catch(() => {})
} finally {
    await browser.close()
    for (const r of results) console.log(r)
    if (errors.length) console.log('ERRORS:', errors)
    process.exitCode = results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0
    process.exit()
}
