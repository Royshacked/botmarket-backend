// DRIVE THE FLOOR — the chat on the left, the STAGE on the right (docs/design/floor-stage.md; Roy,
// 2026-10-22), and the strip of list chips under the chat header.
//
//   node scripts/drive-floor-lists.mjs [baseUrl] [outDir]
//
// Desktop (1600×900): no side columns; the chat column splits 50/50 into the chat and the stage; the
// strip sits under the chat header, Positions first; each chip puts its list on the stage under a thin
// bar (its name, no kicker); a list's own chip and Esc close it. THE STACK: a list, then Mentor's
// surface, then a chart — each covers the last; closing the chart shows Mentor, Esc closes Mentor (not
// the list under it) and the list is back; a covered list's chip brings it back to the front. The
// Forecast board keeps its chip while open, and a row's panel opened from it steps back to it. Mentor's
// surface and the chart are opened through the app's own modules (no model call). Real data for the
// drive account — empty lists are fine. One sign-in at most (the session file is reused). LOOK at the
// screenshots.
/* global document -- page.evaluate bodies run in the browser */
import dns from 'dns'
import { existsSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }
const LISTS = ['Positions', 'Awaiting orders', 'Your trades', 'Your portfolios', 'Watchlists', 'Hotlist', 'Calendar', 'Forecasts']

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

const chip = (page, label) => page.locator('.floor-strip--top .floor-strip__chip').filter({ hasText: new RegExp(`^${label}(\\(\\d+\\))?$`) })
// The panel ON SCREEN (a covered one is in a hidden layer), and where it sits.
const panel = (page) => page.evaluate(() => {
    const p = [...document.querySelectorAll('.detail-panel--docked')].find(e => e.getClientRects().length)
    return p ? {
        title: p.querySelector('.detail-panel__title')?.textContent ?? null,
        inStage: !!p.closest('.stage'),
        compact: !!p.querySelector('.detail-panel__head--compact'),
        kicker: !!p.querySelector('.detail-panel__kicker'),
    } : null
})
const stageTop = (page) => page.evaluate(() => [...(document.querySelector('.stage')?.classList ?? [])].find(c => c.startsWith('stage--')) ?? null)
// The app's OWN module instance (Vite serves an edited module under a ?t= URL; a bare import would load a second copy).
const appCall = (page, file, fn, ...args) => page.evaluate(async ({ file, fn, args }) => {
    const url = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes(file))
    return (await import(url))[fn](...args)
}, { file, fn, args })

try { await userService.createUser(USER); console.log('qa user created') } catch (e) { console.log('qa user exists —', e.message) }

const browser = await chromium.launch({ channel: 'msedge' })
const errors = [], results = []
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
let page
try {
    // Reuse the last run's session: sign-in is rate-limited and counts against this machine's IP.
    const session = `${OUT}/floor-session.json`
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, ...(existsSync(session) ? { storageState: session } : {}) })
    page = await ctx.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await signIn(page)
    await ctx.storageState({ path: session })
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.floor-strip--top', { timeout: 15000 }).catch(async e => { await shot(page, '0-no-strip'); throw e })
    await page.waitForTimeout(2500)
    await shot(page, '1-page')

    // ── The layout ──
    const layout = await page.evaluate(() => {
        const timeline = document.querySelector('.chat-with-stage > .chat-timeline')?.getBoundingClientRect()
        const stage = document.querySelector('.chat-with-stage > .stage')?.getBoundingClientRect()
        const head = document.querySelector('.chat-timeline__header').getBoundingClientRect()
        const strip = document.querySelector('.floor-strip--top').getBoundingClientRect()
        return {
            sides: document.querySelectorAll('.workspace__left, .workspace__right').length,
            chat: Math.round(timeline?.width ?? 0), stage: Math.round(stage?.width ?? 0),
            stageRight: !!stage && !!timeline && stage.left >= timeline.right - 1,
            stripUnderHeader: strip.top >= head.bottom - 1 && strip.top - head.bottom < 40 && strip.right <= (timeline?.right ?? 0) + 1,
            chips: [...document.querySelectorAll('.floor-strip--top .floor-strip__chip')].map(b => b.textContent.replace(/\(\d+\)$/, '')),
            empty: !!document.querySelector('.stage__empty'),
        }
    })
    check('no side columns', layout.sides === 0)
    check('the chat column splits 50/50 — the chat left, the stage right', layout.stageRight && Math.abs(layout.chat - layout.stage) <= 2, `${layout.chat} | ${layout.stage}`)
    check('the strip sits under the chat header, on the chat side', layout.stripUnderHeader)
    check('every list is a chip, Positions first', LISTS.every((l, i) => layout.chips[i] === l), layout.chips.join(' · '))
    check('nothing is open on a fresh load — the stage shows its placeholder', !(await panel(page)) && layout.empty)

    // ── Every list opens on the stage, under a thin bar ──
    for (const label of LISTS) {
        await chip(page, label).click()
        await page.waitForTimeout(900)
        const p = await panel(page)
        const expected = { Calendar: /20\d\d/, Forecasts: /Industries|Forecast/, Hotlist: /Today|today’s list|·/ }[label] ?? new RegExp(`^${label}$`)
        check(`${label} opens on the stage`, !!p && p.inStage && expected.test(p.title ?? ''), p?.title)
        check(`…under a thin bar — its name, no kicker, no count`, !!p && p.compact && !p.kicker)
        check(`…and its chip is marked open`, (await chip(page, label).getAttribute('aria-expanded')) === 'true')
        if (label === 'Positions' || label === 'Your trades') await shot(page, `2-${label.replace(/\s/g, '-').toLowerCase()}`)
    }
    // Switching was the loop above (each chip replaced the open list). Its own chip closes it…
    await chip(page, 'Forecasts').click()
    await page.waitForTimeout(500)
    check('the open list\'s own chip closes it', !(await panel(page)))
    // …and so does Esc.
    await chip(page, 'Your trades').click()
    await page.waitForTimeout(600)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    check('Esc closes it', !(await panel(page)))

    // ── The stack (Roy): a list, then Mentor, then a chart — closing steps back down ──
    await chip(page, 'Your trades').click()
    await page.waitForTimeout(700)
    await appCall(page, '/SidePane/sidePane.store.js', 'openSurface', 'mentor')
    await page.waitForTimeout(900)
    check('Mentor\'s surface covers the list', (await stageTop(page)) === 'stage--surface')
    check('…and the covered list\'s chip is no longer marked', (await chip(page, 'Your trades').getAttribute('aria-expanded')) === 'false')
    await appCall(page, '/services/chartSurface.service.js', 'openChart', { ticker: 'AAPL', timeframe: 'day' })
    await page.waitForTimeout(2000)
    check('a chart covers Mentor', (await stageTop(page)) === 'stage--chart')
    await shot(page, '4-chart')
    await page.locator('.stage .chart-surface').getByRole('button', { name: /close/i }).last().click()
    await page.waitForTimeout(700)
    check('closing the chart shows Mentor again', (await stageTop(page)) === 'stage--surface')
    // A covered list's chip brings it back to the front instead of closing it.
    await chip(page, 'Your trades').click()
    await page.waitForTimeout(600)
    check('a covered list\'s chip brings it to the front', (await stageTop(page)) === 'stage--panel' && (await panel(page))?.title === 'Your trades')
    await appCall(page, '/SidePane/sidePane.store.js', 'showSurface', 'mentor')
    await page.waitForTimeout(300)
    await appCall(page, '/SidePane/sidePane.store.js', 'openSurface', 'portfolio')
    await page.waitForTimeout(900)
    check('a desk taking the floor covers the list again', (await stageTop(page)) === 'stage--surface')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(700)
    check('Esc closes the surface on screen — not the list under it — and the list is back', (await stageTop(page)) === 'stage--panel' && (await panel(page))?.title === 'Your trades')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    check('Esc again closes the list: the placeholder', (await stageTop(page)) === 'stage--empty')

    // ── The Forecast board: a chip while open; a row's panel steps back to it ──
    await chip(page, 'Forecasts').click()
    await page.waitForSelector('.fm-tile, .detail-panel--docked', { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(1200)
    const boardBtn = page.locator('.detail-panel--docked').getByRole('button', { name: 'Board', exact: true })
    if (await boardBtn.count()) {
        await boardBtn.click()
        await page.waitForTimeout(1200)
        check('the map\'s Board opens the board as a list window', (await panel(page))?.title === 'Forecast board', (await panel(page))?.title)
        check('…with a chip of its own while open', (await chip(page, 'Forecast board').count()) === 1)
        await shot(page, '3-board')
        // A row that opens a panel of its own (an assessed industry).
        const row = page.locator('.detail-panel--docked .floor-row, .detail-panel--docked [aria-haspopup="dialog"]').first()
        if (await row.count()) {
            await row.click()
            await page.waitForTimeout(1200)
            const over = await panel(page)
            check('a board row opens its own panel over the board', !!over && over.title !== 'Forecast board', over?.title)
            await page.keyboard.press('Escape')
            await page.waitForTimeout(800)
            check('…and closing it steps back to the board', (await panel(page))?.title === 'Forecast board', (await panel(page))?.title)
        } else {
            console.log('  (no board row to open for this account — the step-back is covered by DetailPanel.test.jsx)')
        }
        await page.keyboard.press('Escape')
        await page.waitForTimeout(500)
        check('closing the board takes its chip away', (await chip(page, 'Forecast board').count()) === 0)
    } else {
        console.log('  (no Board button for this account — skipped)')
    }

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
