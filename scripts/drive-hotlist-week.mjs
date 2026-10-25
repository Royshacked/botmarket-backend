/* global document -- page.evaluate bodies run in the browser */
// Drive THIS WEEK on the run-up rule (docs/design/hotlist-day-archive.md, 2026-10-25) in a real browser, against the
// REAL server: the day's list is the overnight week board the dev database holds (scripts: runWeekBoard — build one
// first), served by /api/hotlist as it is. Only /api/hotlist/reads is stubbed, with one confirmed read on the board's
// first name, so the confirmed list has something on it. One sign-in as `ui-smoke-panel` — run it alone.
//
//   node scripts/drive-hotlist-week.mjs [baseUrl] [outDir]   (default http://localhost:5173 — the Vite dev server)
//
// LOOK at the screenshots.
import dns from 'dns'
import { existsSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }
const { userService } = await import('../api/user/user.service.js')
const { latestBoard } = await import('../services/hotlist.boards.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const board = await latestBoard()
await closeDb()
if (board?.checkpoint !== 'overnight' || !board.rows?.length) { console.log(`FAIL  the latest board is not an overnight week board with names (${board?.id ?? 'none'}) — build one first`); process.exit(1) }
const N = board.rows.length
const first = board.rows[0].symbol
const READS = [{ symbol: first, status: 'live', verdict: 'credible', set_at: new Date().toISOString(), valid_until: board.rows[0].cells.week.exit_before,
    price_at_read: board.rows[0].price, context: { day: board.day, board: board.id },
    target: { value: Math.round(board.rows[0].price * 1.04 * 100) / 100, spot: board.rows[0].price, open_pct: 4, basis: 'prometheus' } }]

const shot = (page, name) => page.screenshot({ path: `${OUT}/hotlist-week-${name}.png` })
const listOrder = (page) => page.$$eval('tr.hot-row', trs => trs.map(t => t.dataset.symbol).join(','))
async function signIn(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    const inputs = page.locator('input')
    if (await inputs.count() >= 2 && await page.locator('input[type="password"]').count()) {
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
}

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
    await page.route('**/api/hotlist/reads**', route => route.request().method() === 'GET'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(READS) }) : route.continue())

    await signIn(page)
    await ctx.storageState({ path: sessionFile })
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.floor-lists', { timeout: 15000 })
    await page.waitForTimeout(2000)

    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForSelector('.hot-horizons', { timeout: 10000 }).catch(async e => { await shot(page, '0-no-tabs'); throw e })
    await page.waitForTimeout(800)
    const tabs = await page.$$eval('.hot-horizons button', ts => ts.map(t => t.textContent))
    await shot(page, '1-all')
    check('no day horizons — All, This week, Swing, Long term', tabs.length === 4 && /^All /.test(tabs[0]) && /^This week /.test(tabs[1]) && /^Swing/.test(tabs[2]) && /^Long term/.test(tabs[3]), tabs.join(' | '))
    check('This week counts the confirmed names', tabs[1] === 'This week 1', tabs[1])
    check('no Boards view on a day with only the week board', await page.getByRole('tab', { name: 'Boards' }).count() === 0)

    await page.getByRole('button', { name: /^This week/ }).click()
    await page.waitForTimeout(500)
    const views = await page.$$eval('.hot-meta .hot-status-filter[aria-label="Names"] button', bs => bs.map(b => b.textContent))
    check('the views: Prometheus confirmed and the rule’s names — no Argus', views.join(' | ') === `Prometheus confirmed 1 | Run-up names ${N}`, views.join(' | '))
    const confirmed = await listOrder(page)
    await shot(page, '2-confirmed')
    check('the list opens on Prometheus’s confirmed name', confirmed === first, confirmed)
    const note = await page.locator('.hot-note').first().textContent()
    check('the note says the rule', /run-up rule/.test(note) && /last three reports all beat/.test(note) && /200-day/.test(note), note.slice(0, 120))

    await page.getByRole('button', { name: `Run-up names ${N}` }).click()
    await page.waitForTimeout(400)
    const all = (await listOrder(page)).split(',')
    const heads = await page.$$eval('.hot-panel thead th', ths => ths.map(t => t.textContent.trim()).filter(Boolean))
    await shot(page, '3-run-up-names')
    check('every run-up name listed', all.length === N, `${all.length} of ${N}`)
    check('no tape and no room on the run-up list (Chg%, RVol, Room)', !heads.includes('Chg%') && !heads.includes('RVol') && !heads.includes('Room') && heads.includes('Earn') && heads.includes('Target'), heads.join(' · '))
    const strips = await page.$$eval('.hot-record__who', ws => ws.map(w => w.textContent))
    check('no Argus record and no old-rule backtest over it', !strips.some(t => /Argus|Backtest/.test(t)), strips.join(' | ') || 'no strips (an empty track record is a plain line)')
    const target = await page.locator(`tr[data-symbol="${first}"] .hot-target`).textContent()
    check('Prometheus’s target on its row', /^\d+\.\d\d · \+4\.0% from /.test(target), target)
    const earn = await page.locator(`tr[data-symbol="${all[1]}"] .hot-earn`).textContent()
    check('the report it is out before, amber', /!$/.test(earn), earn)

    // The headers sit over their data (the list's own check, as drive-hotlist-horizons).
    const misaligned = await page.evaluate(() => {
        const ths = [...document.querySelectorAll('.hot-panel thead th')]
        const tds = [...document.querySelector('.hot-panel tbody tr.hot-row').children]
        const out = []
        ths.forEach((th, i) => {
            const label = th.querySelector('button') ?? th
            if (!label.textContent.trim() || th.querySelector('.hot-sr') || !tds[i]) return
            const rg = document.createRange(); rg.selectNodeContents(tds[i])
            const text = rg.getBoundingClientRect()
            if (!text.width) return
            const r2 = document.createRange(); r2.selectNodeContents(label)
            const lab = r2.getBoundingClientRect()
            const num = th.classList.contains('hot-table__num')
            const off = num ? Math.abs(lab.right - text.right) : Math.abs(lab.left - text.left)
            if (off > 4) out.push(`${label.textContent.trim()} ${num ? 'right' : 'left'} off ${off.toFixed(0)}px`)
        })
        return out
    })
    check('every header sits over its data', misaligned.length === 0, misaligned.join('; '))

    const info = await page.locator('.floor-info').textContent()
    await page.locator('.floor-info').screenshot({ path: `${OUT}/hotlist-week-4-info.png` })
    check('the Info column explains the run-up rule and the archive', /This week — the run-up rule/.test(info) && /archived on 2026-10-25/.test(info), info.slice(0, 160))
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
