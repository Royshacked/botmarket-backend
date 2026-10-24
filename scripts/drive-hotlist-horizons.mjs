/* global document -- page.evaluate bodies run in the browser */
// Drive the Hotlist's LIST PER HORIZON and the catalyst targets on This week (docs/design/horizon-chains.md §1, §3;
// Roy, 2026-10-23) in a real browser.
//
//   node scripts/drive-hotlist-horizons.mjs [baseUrl] [outDir]   (default http://localhost:5173 — the Vite dev server)
//
// Same rules as drive-hotlist-list.mjs: the page, the panel, the session and the clicks are real; the boards are
// fixtures served for /api/hotlist (Argus's picks PER COLUMN on them), the day list is built by the SERVER'S own
// `dayList`, and /api/hotlist/reads serves one catalyst read. One sign-in as `ui-smoke-panel` — run it alone.
// LOOK at the screenshots.
import dns from 'dns'
import { existsSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }
const { userService } = await import('../api/user/user.service.js')
const { dayList } = await import('../services/hotlist.service.js')

const PREOPEN = {
    id: 'hb_2026-10-23_preopen', day: '2026-10-23', checkpoint: 'preopen', status: 'done', columns: ['open', 'week'], finished_at: 1,
    unverified: true, unverified_columns: ['open', 'week'], regime: { breadth_above_sma20: 41, spy: { above_sma20: false } },
    argus: { summary: 'A weak tape: little for the open; the week list is run-ups into earnings.', model: 'gpt-6-luna', picks: 3 },
    rows: [
        { symbol: 'OPN', name: 'Open Co', price: 10, gap_pct: 6, pm_vol_pct: 4, atr_pct: 5, status: 'in_play',
          catalyst: { material: true, type: 'guidance', surprise: 'positive', headline: 'Open Co raises guidance' },
          cells: { open: { grade: 'A', why: ['+6% gap on 4% of a day pre-market'], range: { pct: 3, atr_mult: 0.6, level: 10.3 } } },
          picks: { open: { why: 'A real guidance raise with room to the prior high.', caution: 'A fade under the pre-market low.', rank: 1 } } },
        { symbol: 'LMT', name: 'Lockheed Martin', price: 480, gap_pct: -0.5, pm_vol_pct: 0.5, atr_pct: 2.5, status: 'setting_up',
          cells: { week: { grade: 'B', why: ['RS +3 vs SPY (20d)'], range: { pct: 3.8, atr_mult: 1.5, level: 498 } } },
          picks: { week: { why: 'The strongest week grade on the board.', caution: 'No identified catalyst.', rank: 2 } } },
        { symbol: 'RCL', name: 'Royal Caribbean', price: 260, gap_pct: -1, pm_vol_pct: 0.7, atr_pct: 3.2, status: 'setting_up', next_earnings: '2026-10-27',
          cells: { week: { grade: 'C', exit_before: '2026-10-27', why: ['earnings in 4 days — a run-up: out before the report'], range: { pct: 4.76, atr_mult: 1.48, level: 272.4 } } },
          picks: { week: { why: 'The earnings run-up has room.', caution: 'Out before the October 27 report.', rank: 1 } } },
        { symbol: 'XOM', name: 'Exxon', price: 115, gap_pct: 0.2, pm_vol_pct: 0.3, atr_pct: 1.8, status: 'setting_up',
          cells: { week: { grade: 'B', why: ['inside day'], range: { pct: 2.2, atr_mult: 1.2, level: 117.5 } } } },
    ],
}
const TODAY = { day: '2026-10-23', latest: PREOPEN, day_list: dayList([PREOPEN]), checkpoints: [
    { id: PREOPEN.id, checkpoint: 'preopen', status: 'done', columns: PREOPEN.columns, rows: 4, argus: true }] }
const READS = [{
    id: 'cr_RCL_1', symbol: 'RCL', status: 'active', verdict: 'credible', set_at: '2026-10-23T13:40:00Z', valid_until: '2026-10-26T13:40:00Z',
    read: 'Bookings strength into the report; about half of what it is worth is still open.', news_driven: true,
    event_risk: ['Q3 report 2026-10-27 — out before it'], kill: ['a guidance cut on fuel costs'],
    // A RUN-UP read (the report ahead): its target off the stock's own record into its reports, dated to the session before.
    exit_before: '2026-10-27', runup: { basis: 'run_up', report: '2026-10-27', lead_days: 2, n: 11, median_pct: 3.15, p25_pct: 1.6, p75_pct: 4.6, up_share: 0.73 },
    target: { value: 268.2, low: 264.1, high: 272.0, open_pct: 3.15, worth_pct: 3.15, moved_pct: 0, priced_share: null, spot: 260, basis: 'run_up' },
}]

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/hotlist-horizons-${name}.png` }); console.log('  shot:', name) }
const listOrder = (page) => page.evaluate(() => [...document.querySelectorAll('.hot-panel tr.hot-row')].map(r => r.dataset.symbol).join(','))

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
    const asked = []
    await page.route('**/api/hotlist**', route => {
        const url = route.request().url()
        // "Catalyst read" (a user's ask): recorded, answered as the server does when the read starts.
        if (route.request().method() === 'POST') {
            asked.push(route.request().postDataJSON())
            return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ outcome: 'started' }) })
        }
        const body = url.includes('/reads') ? READS : url.includes('/boards/') ? PREOPEN : TODAY
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })

    await signIn(page)
    await ctx.storageState({ path: sessionFile })
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.floor-lists', { timeout: 15000 })
    await page.waitForTimeout(2000)

    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForSelector('.hot-horizons', { timeout: 10000 }).catch(async e => { await shot(page, '0-no-tabs'); throw e })
    const tabs = await page.$$eval('.hot-horizons button', ts => ts.map(t => t.textContent))
    await shot(page, '1-all')
    check('a tab per horizon, with its count', tabs.join(' | ') === 'All 4 | Open 1 | Mid-day 0 | Into close 0 | Tomorrow 0 | This week 3', tabs.join(' | '))

    await page.getByRole('button', { name: 'This week 3' }).click()
    await page.waitForTimeout(400)
    const week = await listOrder(page)
    await shot(page, '2-this-week')
    check("This week: Argus's picks first in his order, then the grade", week === 'RCL,LMT,XOM', week)
    const target = await page.locator('tr[data-symbol="RCL"] .hot-target').textContent()
    check("Prometheus's catalyst target on the row, and what is still open", target === '268.20 · +3% open', target)
    const star = await page.locator('tr[data-symbol="RCL"] .hot-star').textContent()
    check("his rank in THIS horizon's list", star === '★1', star)

    await page.locator('tr[data-symbol="RCL"] td').nth(4).click()
    await page.waitForTimeout(300)
    const detail = await page.locator('.hot-detail').first().textContent()
    await shot(page, '3-rcl-read')
    check("the opened row: Argus's reason for the week, and Prometheus's read", /The earnings run-up has room/.test(detail) && /target 268\.20/.test(detail) && /Inside the window: Q3 report/.test(detail), detail.slice(0, 200))
    check('a run-up read says its record and the report it ends before', /its run-up into the last 11 reports: median \+3\.15%, up 73% of the time/.test(detail) && /out before the 2026-10-27 report/.test(detail) && !/moved/.test(detail), detail.slice(0, 300))

    // XOM — a week name Argus did not pick, no read: the user asks Prometheus for one.
    await page.locator('tr[data-symbol="XOM"] td').nth(4).click()
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: 'Catalyst read' }).click()
    await page.waitForTimeout(500)
    const xom = await page.locator('tr[data-symbol="XOM"] .hot-target').textContent()
    const said = await page.locator('.hot-detail', { hasText: 'Prometheus is reading it' }).count()
    await shot(page, '3b-xom-asked')
    check('"Catalyst read" asks on the week board of the row; the row says it is reading', asked.length === 1 && asked[0].symbol === 'XOM' && asked[0].board === 'hb_2026-10-23_preopen' && xom === 'reading…' && said === 1,
        `${JSON.stringify(asked)} · ${xom} · note ${said}`)

    // THE HEADERS sit over their data (Roy, 2026-10-24): a number's header right-aligned over its numbers, a word's left
    // over its words — measured from the header's label to the first row's text, column by column.
    const misaligned = await page.evaluate(() => {
        const ths = [...document.querySelectorAll('.hot-panel thead th')]
        const row = document.querySelector('.hot-panel tbody tr.hot-row')
        const tds = [...row.children]
        const out = []
        ths.forEach((th, i) => {
            const label = th.querySelector('button') ?? th
            if (!label.textContent.trim() || th.querySelector('.hot-sr') || !tds[i]) return
            const rg = document.createRange(); rg.selectNodeContents(tds[i])
            const text = rg.getBoundingClientRect()
            if (!text.width) return
            const lab = (() => { const r2 = document.createRange(); r2.selectNodeContents(label); return r2.getBoundingClientRect() })()
            const num = th.classList.contains('hot-table__num')
            const off = num ? Math.abs(lab.right - text.right) : Math.abs(lab.left - text.left)
            if (off > 4) out.push(`${label.textContent.trim()} ${num ? 'right' : 'left'} off ${off.toFixed(0)}px`)
        })
        return out
    })
    check('every header sits over its data — numbers right, words left', misaligned.length === 0, misaligned.join('; '))

    // INFO, the right column, explains the table while the Hotlist is open.
    const info = await page.locator('.floor-info').textContent()
    await page.locator('.floor-info').screenshot({ path: `${OUT}/hotlist-horizons-5-info.png` })
    check('the Info column explains the table', /The Hotlist/.test(info) && /Free range|free range/.test(info) && /Target/.test(info) && /Catalyst read/.test(info), info.slice(0, 160))

    await page.getByRole('button', { name: 'Open 1' }).click()
    await page.waitForTimeout(300)
    const open = await listOrder(page)
    const noTarget = await page.locator('.hot-panel th', { hasText: 'Target' }).count()
    await shot(page, '4-open')
    check('Open lists only the open names — and no Target column off the week', open === 'OPN' && noTarget === 0, `${open}, target headers ${noTarget}`)

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
