/* global document -- page.evaluate bodies run in the browser */
// Drive PROMETHEUS'S SCORECARD in the Hotlist's Book (Roy, 2026-10-27; services/prometheusCalls.service.js) on LIVE data.
//
//   node scripts/drive-hotlist-scorecard.mjs [baseUrl] [outDir]   (default http://localhost:5173 — the Vite dev server)
//
// The page, the panel, the session and the clicks are real; /api/hotlist is answered IN THIS PROCESS from the DB in .env
// (the board, the book and the scorecard by the server's own services), so a dev backend started before the route still
// drives. One sign-in as `ui-smoke-panel` — run it alone. LOOK at the screenshots.
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

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/hotlist-scorecard-${name}.png` }); console.log('  shot:', name) }

try { await userService.createUser(USER); console.log('qa user created') } catch (e) { console.log('qa user exists —', e.message) }

const card = await prometheusCallsService.scorecard()
const browser = await chromium.launch({ channel: 'msedge' })
const errors = [], results = []
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
let page
try {
    const sessionFile = `${OUT}/hotlist-session.json`
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, ...(existsSync(sessionFile) ? { storageState: sessionFile } : {}) })
    page = await ctx.newPage()
    page.on('pageerror', e => errors.push(e.message))
    let asked = 0
    await page.route('**/api/hotlist**', async route => {
        const url = new URL(route.request().url())
        if (url.pathname.endsWith('/reads')) return route.fallback()
        if (url.pathname.endsWith('/scorecard')) asked++
        const board = url.pathname.match(/\/boards\/([^/]+)$/)?.[1]
        const body = board ? await svc.boardWithResults(board)
            : url.pathname.endsWith('/outcomes') ? await svc.hotlistOutcomes()
            : url.pathname.endsWith('/book') ? await houseBook()
            : url.pathname.endsWith('/scorecard') ? card
                : await svc.todayHotlist({ day: url.searchParams.get('day') })
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
    // Wait for the tabs, not a fixed time: on a slow link the in-process reads take seconds (2026-10-28, 4–7 s a read).
    await page.waitForSelector('.hot-horizons', { timeout: 45000 })
    await page.waitForTimeout(1000)

    // Four tabs (Roy, 2026-10-28): This week · Swing · Long term · Covered companies — no All; opens on This week.
    const tabs = await page.locator('.hot-horizons button').allTextContents()
    check('four tabs, This week first and pressed', tabs.length === 4 && /^This week/.test(tabs[0]) && /^Swing/.test(tabs[1]) && /^Long term/.test(tabs[2]) && /^Covered companies \d+/.test(tabs[3])
        && await page.locator('.hot-horizons button').first().getAttribute('aria-pressed') === 'true', tabs.join(' | '))
    // No Status column or status filter (Roy, 2026-10-28) — read on the week's whole list.
    const runUp = page.getByRole('button', { name: /^(Run-up names|All screened) \d+/ })
    if (await runUp.count()) { await runUp.click(); await page.waitForTimeout(500) }
    const heads = await page.locator('.hot-panel thead th').allTextContents()
    check('no Status column, no status filter', !heads.some(h => /Status/.test(h)) && await page.getByRole('group', { name: 'Show' }).count() === 0, heads.map(h => h.trim()).filter(Boolean).join(' | '))
    await shot(page, '0-this-week')
    await page.getByRole('button', { name: /^Long term \d+/ }).click()
    await page.waitForTimeout(1500)
    check('Long term is the chain’s lists only — no whole book, no scorecard', await page.getByRole('button', { name: /^All coverage/ }).count() === 0
        && await page.getByRole('button', { name: 'Prometheus’s scorecard' }).count() === 0)
    await page.getByRole('button', { name: /^Covered companies \d+/ }).click()
    await page.waitForTimeout(1500)
    const covered = await page.locator('.hot-panel tr.hot-row').count()
    const coveredTab = Number((tabs[3].match(/(\d+)$/) ?? [])[1])
    check('Covered companies opens on the whole book, both horizons', covered === coveredTab && covered > 0, `${covered} rows, tab says ${coveredTab}`)
    await shot(page, '0b-covered')
    const btn = page.getByRole('button', { name: 'Prometheus’s scorecard' })
    check('Covered companies has the scorecard view', await btn.count() === 1)
    await btn.click()
    await page.waitForSelector('.hot-score', { timeout: 10000 })
    await page.waitForTimeout(500)
    await shot(page, '1-long-term')
    const rowText = await page.evaluate(() => [...document.querySelectorAll('.hot-score tr.hot-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()))
    const seeded = rowText.find(t => t.startsWith('Before it (seeded)')) ?? ''
    const m1 = card.coverage.backfill.marks['1m']?.calls
    check('the seeded calls: their count and the 1-month mark vs SPY', /230 calls/.test(seeded) && (!m1 || seeded.includes(`${m1.n}`)), seeded)
    check('the ratings under it, the hold unsigned', rowText.some(t => /^buy/.test(t)) && rowText.some(t => /^hold · vs SPY, unsigned/.test(t)), rowText.filter(t => /^(buy|hold|sell|strong)/.test(t)).join(' | '))
    check('no forward row while nothing has been logged since', card.coverage.forward.calls ? rowText.some(t => t.startsWith('Since the scorecard')) : !rowText.some(t => t.startsWith('Since the scorecard')))
    const cat = await page.locator('.hot-score').textContent()
    check('the catalyst table, or its empty line', /Backed — a target/.test(cat) || /No catalyst reads settled yet/.test(cat), cat.slice(-160))
    const dim = await page.locator('.hot-score .hot-result--dim').count()
    check('a number under the bar is dim', dim > 0, `${dim} dim cells`)

    // Back to the book is one click; the scorecard asked again on its next opening.
    await page.getByRole('button', { name: /^All coverage \d+/ }).click()
    await page.waitForTimeout(500)
    check('All coverage brings the book back', await page.locator('.hot-score').count() === 0 && await page.locator('.hot-panel tr.hot-row').count() > 0)
    await page.getByRole('button', { name: 'Prometheus’s scorecard' }).click()
    await page.waitForSelector('.hot-score', { timeout: 10000 })
    check('the scorecard was asked of the server once per opening', asked === 2, `${asked} requests`)
    // Argus's names read the book's `picks` — the FE service once dropped them, so the list always said "could not be loaded".
    await page.getByRole('button', { name: /^Swing \d+/ }).click()
    await page.waitForTimeout(800)
    // A name Pythia no longer calls swing is off the list, named in the note — and still in Covered companies (2026-10-28).
    const book = await houseBook()
    const gone = book.swing.filter(r => r.origin?.source === 'pythia' && r.origin.still === false).map(r => r.symbol)
    const swingRows = await page.locator('.hot-panel tr.hot-row').evaluateAll(trs => trs.map(t => t.dataset.symbol))
    const note = await page.locator('.hot-note', { hasText: 'Off this list' }).textContent().catch(() => '')
    check('names Pythia no longer calls are off Swing and named in its note', gone.every(s => !swingRows.includes(s) && note.includes(s)) && (gone.length === 0 || note !== ''),
        `${gone.join(', ') || 'none'} — ${note.slice(0, 120)}`)
    await shot(page, '2b-swing-left')
    await page.getByRole('button', { name: /^Argus’s names/ }).click()
    await page.waitForTimeout(500)
    await shot(page, '3-argus-names')
    const argus = await page.locator('.hot-panel').textContent()
    check('Argus’s names load (the book’s picks reach the list)', !/could not be loaded/.test(argus), argus.slice(0, 160))
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
