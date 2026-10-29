/* global document, window -- page.evaluate bodies run in the browser */
// Drive the HOTLIST ON A PHONE, as a user and as the admin (Roy, 2026-10-29: "full table for admin only; for regular users
// only the table with the four tabs above — no explanations; in mobile — tables too wide").
//
//   node scripts/drive-hotlist-phone.mjs [baseUrl] [outDir]   (default http://localhost:5173 — the Vite dev server)
//
// A 390-px phone. /api/hotlist is answered IN THIS PROCESS from the DB in .env (as drive-hotlist-scorecard.mjs). The QA
// user is a regular user; the admin pass answers /api/auth/me with its role set to admin — the panel's view only, every
// admin route on the server still refuses it. One sign-in as `ui-smoke-panel` — run it alone. LOOK at the screenshots.
import dns from 'dns'
import { existsSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }
const { userService } = await import('../api/user/user.service.js')
const svc = await import('../services/hotlist.service.js')
const { houseBook } = await import('../services/houseBook.service.js')
const { prometheusCallsService } = await import('../services/prometheusCalls.service.js')

try { await userService.createUser(USER); console.log('qa user created') } catch (e) { console.log('qa user exists —', e.message) }

// Read once, served from memory: on a slow link a read takes 30–40 s (2026-10-29), and the panel reads each one again on
// every open. This drive measures the layout, not the reads.
const [book, card, today, outcomes] = await Promise.all([houseBook(), prometheusCallsService.scorecard(), svc.todayHotlist({}), svc.hotlistOutcomes()])
console.log('read the hotlist:', today.day, `${today.dayList?.length ?? 0} names on the day`)
const browser = await chromium.launch({ channel: 'msedge' })
const errors = [], results = []
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
const sessionFile = `${OUT}/hotlist-session.json`
let lastPage = null

/** Every visible table: does it fit its box, and does the page scroll sideways? */
const widths = (page) => page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    tables: [...document.querySelectorAll('.hot-panel .hot-table-wrap')].filter(w => w.offsetParent).map(w => ({
        over: w.scrollWidth - w.clientWidth, right: Math.round(w.getBoundingClientRect().right), cols: w.querySelectorAll('thead th').length,
        shown: [...w.querySelectorAll('thead th')].filter(th => getComputedStyle(th).display !== 'none').length,
    })),
    notes: document.querySelectorAll('.hot-panel .hot-note').length,
    switches: document.querySelectorAll('.hot-panel .hot-status-filter').length,
}))

async function pass(admin) {
    const who = admin ? 'admin' : 'user'
    // The phone's menu has no way to the lists (2026-10-29) — only an "Open the hotlist" card in the chat, when Axl offers
    // one: the Hotlist is opened from the lists column at a desktop width, and the window narrowed to the phone's.
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2,
        ...(existsSync(sessionFile) ? { storageState: sessionFile } : {}) })
    const page = lastPage = await ctx.newPage()
    page.on('pageerror', e => errors.push(`${who}: ${e.message}`))
    await page.route('**/api/hotlist**', async route => {
        const url = new URL(route.request().url())
        if (url.pathname.endsWith('/reads')) return route.fallback()
        const board = url.pathname.match(/\/boards\/([^/]+)$/)?.[1]
        const body = board ? await svc.boardWithResults(board)
            : url.pathname.endsWith('/outcomes') ? outcomes
            : url.pathname.endsWith('/book') ? book
            : url.pathname.endsWith('/scorecard') ? card
                : url.searchParams.get('day') ? await svc.todayHotlist({ day: url.searchParams.get('day') }) : today
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    if (admin) {
        await page.route('**/api/auth/me', async route => {
            const res = await route.fetch()
            const me = await res.json().catch(() => null)
            return route.fulfill({ response: res, body: JSON.stringify(me ? { ...me, role: 'admin', isAdmin: true } : me) })
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
    // A phone hides the lists column: the Hotlist opens from its own button.
    await page.waitForSelector('.floor-lists', { timeout: 15000 })
    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForSelector('.hot-horizons', { timeout: 150000 })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForSelector('.hot-horizons', { timeout: 15000 })
    await page.waitForTimeout(1000)

    const tabs = page.locator('.hot-horizons button')
    check(`${who}: four tabs`, await tabs.count() === 4, (await tabs.allTextContents()).join(' | '))
    for (const [i, name] of [[0, 'week'], [1, 'swing'], [2, 'long_term'], [3, 'covered']]) {
        if (await tabs.nth(i).isDisabled()) { check(`${who} ${name}: tab disabled — skipped`, true); continue }
        await tabs.nth(i).click()
        await page.waitForTimeout(700)
        const w = await widths(page)
        await page.screenshot({ path: `${OUT}/hotlist-phone-${who}-${name}.png`, fullPage: false })
        check(`${who} ${name}: no sideways page scroll`, w.page <= 0, `page over by ${w.page}px`)
        check(`${who} ${name}: every table fits the phone`, w.tables.every(t => t.over <= 1 && t.right <= 390), JSON.stringify(w.tables))
        if (!admin) check(`${who} ${name}: no notes or view switches`, w.notes === 0 && w.switches === 0, `notes ${w.notes}, switches ${w.switches}`)
        else if (name !== 'covered' && name !== 'week') check(`${who} ${name}: the view switch is there`, w.switches === 1)
    }
    if (admin) {
        // The admin's two wide tables: Argus's names on Swing, the scorecard on Covered companies.
        await tabs.nth(1).click()
        await page.getByRole('button', { name: /^Argus’s names/ }).click()
        await page.waitForTimeout(500)
        let w = await widths(page)
        await page.screenshot({ path: `${OUT}/hotlist-phone-admin-argus.png` })
        check('admin Argus’s names: scrolls in its box, the page does not', w.page <= 0, JSON.stringify(w.tables))
        await tabs.nth(3).click()
        await page.getByRole('button', { name: 'Prometheus’s scorecard' }).click()
        await page.waitForSelector('.hot-score', { timeout: 15000 })
        w = await widths(page)
        await page.screenshot({ path: `${OUT}/hotlist-phone-admin-scorecard.png` })
        check('admin scorecard: scrolls in its box, the page does not', w.page <= 0, JSON.stringify(w.tables))
    }
    await ctx.close()
}

try {
    await pass(false)
    await pass(true)
} catch (e) {
    errors.push(e.message)
    await lastPage?.screenshot({ path: `${OUT}/hotlist-phone-error.png` }).catch(() => {})
} finally {
    await browser.close()
    for (const r of results) console.log(r)
    if (errors.length) console.log('ERRORS:', errors)
    process.exitCode = results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0
    process.exit()
}
