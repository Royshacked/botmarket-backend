// DRIVE THE FORECASTS MAP — the heat map that replaced the Forecasts list and the "Analyst companies" desk
// (Roy, 2026-10-14).
//
//   node scripts/drive-forecast-map.mjs [baseUrl] [outDir]
//
// Desktop (1600×900): the Forecasts header opens the map over the chat (no desk takes the column, and "Analyst
// companies" is gone); tiles by sector, coloured by the 3-month move, verdict letters on them; the window switch
// recolours; a filter dims. A tile opens Pythia's thesis and its companies; a covered company opens Prometheus's
// thesis; back returns to the industry, then the map. Needs the backend RUNNING the /map and /companies routes.
// LOOK at the screenshots.
/* global document -- page.evaluate bodies run in the browser */
import dns from 'dns'
import { existsSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { userService } = await import('../api/user/user.service.js')

const shot = async (page, name) => {
    await page.screenshot({ path: `${OUT}/forecast-${name}.png`, fullPage: false })
    console.log('  shot:', name)
}

async function signIn(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    const inputs = page.locator('input')
    if (await page.locator('input[type="password"]').count()) {
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
}

const panelState = (page) => page.evaluate(() => {
    const p = document.querySelector('.detail-panel')
    if (!p) return null
    const tiles = [...p.querySelectorAll('.fm-tile')]
    return {
        title: p.querySelector('.detail-panel__title')?.textContent,
        docked: p.classList.contains('detail-panel--docked'),
        sectors: [...p.querySelectorAll('.fm-sector__head')].map(h => h.firstChild?.textContent),
        tiles: tiles.length,
        coloured: tiles.filter(t => /fm-tile--(up|down)-/.test(t.className)).length,
        badges: tiles.filter(t => t.querySelector('.fm-tile__badge')).length,
        dimmed: tiles.filter(t => t.classList.contains('fm-tile--dim')).length,
        firstMove: tiles[0]?.querySelector('.fm-tile__move')?.textContent,
        companies: p.querySelectorAll('.fm-co').length,
        coveredRows: p.querySelectorAll('.fm-co--covered').length,
        text: p.querySelector('.detail-panel__body')?.textContent?.slice(0, 160),
    }
})

try { await userService.createUser(USER); console.log('qa user created') } catch (e) { console.log('qa user exists —', e.message) }

const browser = await chromium.launch({ channel: 'msedge' })
const errors = []
const results = []
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
let page
try {
    const session = `${OUT}/floor-session.json`
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2, ...(existsSync(session) ? { storageState: session } : {}) })
    page = await ctx.newPage()
    page.on('pageerror', e => errors.push(e.message))
    page.on('response', r => { if (r.url().includes('/api/strategy/') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`) })
    await signIn(page)
    await ctx.storageState({ path: session })
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.floor-lists', { timeout: 15000 }).catch(async e => { await shot(page, '0-no-floor'); throw e })
    await page.waitForTimeout(2000)

    const labels = await page.$$eval('.floor-desk__label', ls => ls.map(l => l.textContent))
    check('"Analyst companies" desk is gone', !labels.includes('Analyst companies'), labels.join(' | '))
    check('Forecasts desk is there', labels.includes('Forecasts'))

    // ── the map ──
    await page.locator('.floor-desk__head', { hasText: 'Forecasts' }).click()
    await page.waitForSelector('.fm-tile', { timeout: 20000 }).catch(async e => { await shot(page, '0-no-map'); throw e })
    await page.waitForTimeout(800)
    let s = await panelState(page)
    await shot(page, '1-map')
    check('the map opens docked over the chat', s?.docked && s.title === 'Industries', JSON.stringify({ docked: s?.docked, title: s?.title }))
    check('no desk took the column', !(await page.$('.floor-desk--open')))
    check('tiles by sector', s.tiles > 100 && s.sectors.length >= 10, `${s.tiles} tiles, ${s.sectors.length} sectors`)
    check('tiles are coloured by the move', s.coloured > s.tiles / 2, `${s.coloured}/${s.tiles}`)
    check('verdict letters on the assessed tiles', s.badges > 0, `${s.badges} badges`)
    // A close-up of the first row of tiles at 2× — the verdict letters must read at their real size.
    await page.locator('.fm-grid').first().screenshot({ path: `${OUT}/forecast-1c-tiles-closeup.png`, scale: 'device' })
    await page.locator('.fm-map').evaluate(el => el.closest('.detail-panel__body').scrollTo(0, 600))
    await page.waitForTimeout(300)
    await shot(page, '1b-map-scrolled')
    await page.locator('.fm-map').evaluate(el => el.closest('.detail-panel__body').scrollTo(0, 0))

    const before = s.firstMove
    await page.getByRole('button', { name: '12m', exact: true }).click()
    await page.waitForTimeout(300)
    s = await panelState(page)
    check('the window switch recolours', s.firstMove !== before || s.firstMove === '—', `${before} → ${s.firstMove}`)
    await shot(page, '2-map-12m')
    await page.getByRole('button', { name: '3m', exact: true }).click()

    await page.getByRole('button', { name: 'For swing', exact: true }).click()
    await page.waitForTimeout(300)
    s = await panelState(page)
    check('a verdict filter dims the rest', s.dimmed > 0 && s.dimmed < s.tiles, `${s.dimmed}/${s.tiles} dimmed`)
    await shot(page, '3-filter-swing')
    await page.getByRole('button', { name: 'All', exact: true }).click()

    // ── an industry: the assessed tile with the most covered names, so the company step has a door ──
    const code = await page.evaluate(() => {
        const ts = [...document.querySelectorAll('.fm-tile')].filter(t => t.querySelector('.fm-tile__badge') && t.querySelector('.fm-tile__cov'))
        ts.sort((a, b) => Number(b.querySelector('.fm-tile__cov').textContent.slice(1)) - Number(a.querySelector('.fm-tile__cov').textContent.slice(1)))
        return (ts[0] ?? document.querySelector('.fm-tile'))?.dataset.code
    })
    await page.locator(`.fm-tile[data-code="${code}"]`).click()
    await page.waitForSelector('.fm-co', { timeout: 20000 }).catch(async e => { await shot(page, '0-no-companies'); throw e })
    await page.waitForTimeout(1500)
    s = await panelState(page)
    await shot(page, '4-industry')
    check('an industry shows Pythia then its companies', s.companies > 0 && /Pythia/.test(s.text), `${s.title}: ${s.companies} companies, ${s.coveredRows} covered`)

    // ── a company ──
    if (s.coveredRows > 0) {
        const industry = s.title
        // Scrolled down to the list first — the company must still open at its top.
        await page.locator('.fm-co--covered').first().scrollIntoViewIfNeeded()
        await page.locator('.fm-co--covered').first().click()
        await page.waitForTimeout(800)
        s = await panelState(page)
        const top = await page.evaluate(() => document.querySelector('.detail-panel__body').scrollTop)
        check('a company opens at its top', top === 0, `scrollTop ${top}`)
        await shot(page, '5-company')
        check('a covered company opens its thesis', s.title && s.title !== industry && s.text.length > 40, `${s.title}: ${s.text.slice(0, 80)}`)
        await page.getByRole('button', { name: `‹ ${industry}` }).click()
        await page.waitForTimeout(500)
        s = await panelState(page)
        check('back returns to the industry', s.title === industry, s.title)
    } else check('a covered company opens its thesis', false, 'the chosen industry had no covered names')
    await page.getByRole('button', { name: '‹ Map' }).click()
    await page.waitForTimeout(300)
    s = await panelState(page)
    check('back again returns to the map', s.title === 'Industries', s.title)
    // ── the board: Pythia's tabs in a window of their own (2026-10-22), its rows opening their own panel over it ──
    await page.getByRole('button', { name: 'Board', exact: true }).click()
    await page.waitForTimeout(800)
    const board = await page.$('.floor-panel--board .industry-view')
    check('Board opens Pythia’s board in its window and closes the map', !!board && !(await page.$('.fm-map')))
    await shot(page, '6-board')
    await page.locator('.floor-panel--board .industry-view__line').first().click()
    await page.waitForTimeout(1200)
    s = await panelState(page)
    // The board is KEPT under the row's panel (detailPanel.store): mounted, hidden.
    check('a board row opens its panel over the board, which stays mounted under it', !!s?.title && !!(await page.$('.industry-view')), s?.title)
    await shot(page, '7-board-row')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    check('Esc on the row\'s panel steps back to the board', !!(await page.$('.floor-panel--board .industry-view')) && (await page.$eval('.detail-panel', p => p.getAttribute('aria-label')).catch(() => null)) === 'Forecast board')
    await page.getByRole('button', { name: 'Open the heat map' }).click()
    await page.waitForTimeout(800)
    s = await panelState(page)
    check('the board leads back to the map', s?.title === 'Industries', s?.title)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    check('Esc closes the panel', !(await page.$('.detail-panel')))
} catch (err) {
    errors.push(`DRIVE ${err.message}`)
    if (page) await shot(page, 'x-error').catch(() => {})
} finally {
    await browser.close()
    console.log(results.join('\n'))
    console.log(errors.length ? `ERRORS:\n  ${errors.join('\n  ')}` : 'no page errors')
    process.exit(0)
}
