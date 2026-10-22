// DRIVE THE FLOOR LISTS — every list opens in the DETAIL WINDOW over the chat, with no header; the column is the
// launcher (Roy, 2026-10-22: "all floor lists, when opened, should be presented in the detail window, without header").
//
//   node scripts/drive-floor-lists.mjs [baseUrl] [outDir]
//
// Desktop (1600×900): the column lists every desk with its count; a header opens its list in the window over the chat
// and the column does not change (no fold, no strip); the window has no header — a corner ✕, or for a list with its own
// controls (Hotlist, Calendar, Forecasts) one thin row; another header switches lists, its own header and Esc close it;
// the Forecast board opens from the map as a window, and a row's panel opened from it steps back to it. Real data for
// the drive account — empty lists are fine. One sign-in at most (the session file is reused). LOOK at the screenshots.
/* global document -- page.evaluate bodies run in the browser */
import dns from 'dns'
import { existsSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }
const LISTS = ['Awaiting orders', 'Your trades', 'Your portfolios', 'Watchlists', 'Hotlist', 'Calendar', 'Forecasts']
const BARE = ['Awaiting orders', 'Your trades', 'Your portfolios', 'Watchlists']   // no controls of their own

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { closeDb } = await import('../providers/mongodb.provider.js')
const { userService } = await import('../api/user/user.service.js')

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/floor-${name}.png` }); console.log('  shot:', name) }

async function signIn(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
}

const head = (page, label) => page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: new RegExp(`^${label}$`) }) })
const panel = (page) => page.evaluate(() => {
    const p = document.querySelector('.detail-panel--docked')
    return p ? {
        name: p.getAttribute('aria-label'),
        header: !!p.querySelector('.detail-panel__head'),
        corner: !!p.querySelector('.detail-panel__close--corner'),
        bar: !!p.querySelector('.detail-panel__bar'),
        overChat: !!p.closest('.workspace__chat'),
        // It COVERS the chat column, whatever its content's height — not a box in the flow above the chat.
        covers: Math.abs(p.getBoundingClientRect().height - document.querySelector('.workspace__chat').getBoundingClientRect().height) <= 2,
    } : null
})
const column = (page) => page.evaluate(() => ({
    folded: document.querySelectorAll('.floor-desk--folded').length,
    focused: !!document.querySelector('.floor-lists--focused'),
    strip: !!document.querySelector('.floor-lists .floor-strip'),
}))

try { await userService.createUser(USER); console.log('qa user created') } catch (e) { console.log('qa user exists —', e.message) }

const browser = await chromium.launch({ channel: 'msedge' })
const errors = [], results = []
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
let page
try {
    const session = `${OUT}/floor-session.json`
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, ...(existsSync(session) ? { storageState: session } : {}) })
    page = await ctx.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await signIn(page)
    await ctx.storageState({ path: session })
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.floor-lists', { timeout: 15000 }).catch(async e => { await shot(page, '0-no-floor'); throw e })
    await page.waitForTimeout(2500)
    await shot(page, '1-page')

    const labels = await page.evaluate(() => [...document.querySelectorAll('.floor-lists .floor-desk__label')].map(l => l.textContent))
    check('the column lists every desk', LISTS.every(l => labels.includes(l)), labels.join(' · '))
    check('nothing is open on a fresh load', !(await panel(page)))

    for (const label of LISTS) {
        await head(page, label).click()
        await page.waitForTimeout(900)
        const p = await panel(page)
        const c = await column(page)
        check(`${label} opens in the window over the chat, covering it`, !!p && p.overChat && p.covers && (p.name ?? '').length > 0, p ? `${p.name} · covers ${p.covers}` : '')
        check(`…with no header`, !!p && !p.header && (BARE.includes(label) ? p.corner : p.bar), p ? `corner ${p.corner} · row ${p.bar}` : '')
        check(`…and the column stays as it is`, c.folded === 0 && !c.focused && !c.strip, JSON.stringify(c))
        check(`…its header marked open`, (await head(page, label).getAttribute('aria-expanded')) === 'true')
        if (label === 'Your trades' || label === 'Hotlist') await shot(page, `2-${label.replace(/\s/g, '-').toLowerCase()}`)
    }
    // Its own header closes it…
    await head(page, 'Forecasts').click()
    await page.waitForTimeout(500)
    check('the open list\'s own header closes it', !(await panel(page)))
    // …so do the corner ✕ and Esc.
    await head(page, 'Your trades').click()
    await page.waitForTimeout(600)
    await page.locator('.detail-panel__close--corner').click()
    await page.waitForTimeout(500)
    check('the corner ✕ closes it', !(await panel(page)))
    await head(page, 'Watchlists').click()
    await page.waitForTimeout(600)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    check('Esc closes it', !(await panel(page)))

    // ── The Forecast board: a window; a row's panel steps back to it ──
    await head(page, 'Forecasts').click()
    await page.waitForSelector('.fm-tile', { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(1200)
    const boardBtn = page.locator('.detail-panel--docked').getByRole('button', { name: 'Board', exact: true })
    if (await boardBtn.count()) {
        await boardBtn.click()
        await page.waitForTimeout(1200)
        check('the map\'s Board opens the board in the window', (await panel(page))?.name === 'Forecast board', (await panel(page))?.name)
        check('…with a header in the column while open', (await head(page, 'Forecast board').count()) === 1)
        await shot(page, '3-board')
        const row = page.locator('.detail-panel--docked .industry-view__line').first()
        if (await row.count()) {
            await row.click()
            await page.waitForTimeout(1200)
            const over = await panel(page)
            check('a board row opens its own panel over the board', !!over && over.name !== 'Forecast board', over?.name)
            await page.keyboard.press('Escape')
            await page.waitForTimeout(800)
            check('…and closing it steps back to the board', (await panel(page))?.name === 'Forecast board', (await panel(page))?.name)
        } else console.log('  (no board row for this account — the step-back is covered by DetailPanel.test.jsx)')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(500)
        check('closing the board takes its header away', (await head(page, 'Forecast board').count()) === 0)
    } else console.log('  (no Board button for this account — skipped)')

    check('no page errors', errors.length === 0, errors.join(' | '))
} catch (err) {
    check('the drive ran to the end', false, err.message)
    if (page) await shot(page, 'x-error').catch(() => {})
} finally {
    await browser.close()
    await closeDb().catch(() => {})
}

console.log('\n' + results.join('\n'))
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
