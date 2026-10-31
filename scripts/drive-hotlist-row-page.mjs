/* global document, window -- page.evaluate bodies run in the browser */
// Drive the HOTLIST, SIMPLE — and a row's PAGE over the window (Roy, 2026-10-31: "the user should see simple things … when
// clicking a row I want it to cover the whole chatbox like the detail window").
//
//   node scripts/drive-hotlist-row-page.mjs [baseUrl] [outDir]   (default http://localhost:5173 — the Vite dev server)
//
// Desktop as the admin (the most there is to hide), then a 390-px phone. /api/hotlist is answered IN THIS PROCESS from the
// DB in .env (as drive-hotlist-phone.mjs); the admin pass answers /api/auth/me with its role set to admin — the panel's
// view only. One sign-in as `ui-smoke-panel` — run it alone. LOOK at the screenshots.
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

const [book, card, today, outcomes] = await Promise.all([houseBook(), prometheusCallsService.scorecard(), svc.todayHotlist({}), svc.hotlistOutcomes()])
console.log('read the hotlist:', today.day, `${today.dayList?.length ?? 0} names on the day`)
const browser = await chromium.launch({ channel: 'msedge' })
const errors = [], results = []
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
const sessionFile = `${OUT}/hotlist-session.json`
let lastPage = null

/** What sits between the tabs and the table: explanation notes (a warning is allowed), and the page when one is open. */
const layout = (page) => page.evaluate(() => {
    const panel = document.querySelector('.hot-panel')
    const table = panel?.querySelector('.hot-table-wrap')
    const tabs = panel?.querySelector('.hot-horizons')
    const before = (el) => table && (el.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING)
    return {
        notesAbove: [...(panel?.querySelectorAll('.hot-note:not(.hot-note--warn)') ?? [])].filter(before).map(n => n.textContent.slice(0, 60)),
        argusAbove: [...(panel?.querySelectorAll('.hot-argus') ?? [])].filter(before).length,
        tabs: Boolean(tabs), table: Boolean(table),
        pageOpen: Boolean(panel?.querySelector('.hot-page')),
        title: document.querySelector('.hot-panel')?.closest('[role="dialog"]')?.getAttribute('aria-label') ?? null,
        facts: [...(panel?.querySelectorAll('.hot-page__fact dt') ?? [])].map(d => d.textContent),
        chart: Boolean(panel?.querySelector('.hot-page__chart .chart-surface')),
        over: document.documentElement.scrollWidth - window.innerWidth,
    }
})

async function pass({ phone }) {
    const who = phone ? 'phone' : 'desktop'
    const ctx = await browser.newContext({
        ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1600, height: 900 } }),
        ...(existsSync(sessionFile) ? { storageState: sessionFile } : {}),
    })
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
    await page.route('**/api/auth/me', async route => {
        const res = await route.fetch()
        const me = await res.json().catch(() => null)
        return route.fulfill({ response: res, body: JSON.stringify(me ? { ...me, role: 'admin', isAdmin: true } : me) })
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
    if (phone) {
        await page.getByRole('button', { name: 'Open menu' }).click({ timeout: 20000 })
        await page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: 'Hotlist' }).click()
    } else {
        await page.waitForSelector('.floor-lists', { timeout: 15000 })
        await page.waitForTimeout(1500)
        await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    }
    await page.waitForSelector('.hot-horizons', { timeout: 150000 })
    await page.waitForTimeout(1000)

    const tabs = page.locator('.hot-horizons button')
    for (const [i, name] of [[0, 'week'], [1, 'swing'], [3, 'covered']]) {
        await tabs.nth(i).click()
        await page.waitForTimeout(700)
        let l = await layout(page)
        await page.screenshot({ path: `${OUT}/hotlist-simple-${who}-${name}.png` })
        check(`${who} ${name}: no explanation and no Argus read above the table`, !l.table || (!l.notesAbove.length && !l.argusAbove), JSON.stringify(l.notesAbove))
        const row = page.locator('.hot-panel tr.hot-row').first()
        if (!await row.count()) { check(`${who} ${name}: no rows — the page skipped`, true); continue }
        const sym = await row.getAttribute('data-symbol')
        // A cell that is not the symbol (that one opens the chart alone): the row's page.
        await row.locator('td').nth(phone ? 0 : 3).click()
        await page.waitForSelector('.hot-page', { timeout: 5000 })
        await page.waitForTimeout(1200)
        l = await layout(page)
        await page.screenshot({ path: `${OUT}/hotlist-simple-${who}-${name}-page.png` })
        check(`${who} ${name}: a row opens its page over the window — no tabs, no table`, l.pageOpen && !l.tabs && !l.table, `title ${l.title}`)
        check(`${who} ${name}: the page carries the numbers and the daily chart`, l.facts.length >= 4 && l.chart, l.facts.join(' | '))
        check(`${who} ${name}: the page is titled by the name`, l.title === sym, `${l.title} vs ${sym}`)
        check(`${who} ${name}: nothing scrolls sideways`, l.over <= 0, `${l.over}px`)
        await page.getByRole('button', { name: '‹ Back to the list' }).click()
        await page.waitForTimeout(500)
        l = await layout(page)
        check(`${who} ${name}: Back returns to the tabs and the list`, l.tabs && l.table && !l.pageOpen)
    }
    await ctx.close()
}

try {
    await pass({ phone: false })
    await pass({ phone: true })
} catch (e) {
    errors.push(e.message)
    await lastPage?.screenshot({ path: `${OUT}/hotlist-simple-error.png` }).catch(() => {})
} finally {
    await browser.close()
    for (const r of results) console.log(r)
    if (errors.length) console.log('ERRORS:', errors)
    process.exitCode = results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0
    process.exit()
}
