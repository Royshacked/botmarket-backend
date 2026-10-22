/* global document -- page.evaluate bodies run in the browser */
// Drive the Hotlist's TODAY'S LIST — the watchlist view (Roy, 2026-10-22) — in a real browser.
//
//   node scripts/drive-hotlist-list.mjs [baseUrl] [outDir]   (default http://localhost:5173 — the Vite dev server)
//
// Same rules as drive-hotlist.mjs: the page, the panel, the session and the clicks are real; the
// boards are fixtures served for /api/hotlist, and the day list is built from them by the SERVER'S
// own `dayList` (hotlist.service), so the drive reads what the API would send. The Mentor turn is
// captured and aborted. One sign-in as `ui-smoke-panel` — run it alone, not in a batch of drives.

import dns from 'node:dns'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'

const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { closeDb } = await import('../providers/mongodb.provider.js')
const { userService } = await import('../api/user/user.service.js')
const { dayList } = await import('../services/hotlist.service.js')

const PREMARKET = {
    id: 'hb_2026-10-21_premarket', day: '2026-10-21', checkpoint: 'premarket', status: 'done', columns: ['open', 'week'], finished_at: 1,
    unverified: true, unverified_columns: ['open', 'week'], regime: { breadth_above_sma20: 58, spy: { above_sma20: true } }, argus: null,
    rows: [
        { symbol: 'DXC', name: 'DXC Technology', price: 20.5, gap_pct: 0.4, pm_vol_pct: 0.8, atr_pct: 3.1, next_earnings: '2026-10-29', quoted_at: Date.parse('2026-10-21T12:04:00Z'),
          spark: [18, 18.4, 18.9, 19.2, 19.1, 19.6, 20, 20.3, 20.1, 20.4], status: 'setting_up',
          cells: { open: { grade: null }, week: { grade: 'B', path: 'scheduled', exit_before: '2026-10-29',
              why: ['NR7 · RS +40.86 vs SPY (20d) · earnings in 8 days — a run-up: out before the report'], range: { level: 22, pct: 7.3, atr_mult: 2.3 } } } },
        { symbol: 'ACC', name: 'Accumulating Co', price: 55, gap_pct: 1.2, pm_vol_pct: 1.4, atr_pct: 2.6, quoted_at: Date.parse('2026-10-21T12:05:00Z'), status: 'building',
          cells: { open: { grade: null }, week: { grade: 'A', path: 'accumulation',
              why: ['near the 20-day high · RS +5.2 vs SPY (20d) · volume 1.8× its 50-day pace (5d)'], range: { open_sky: true } } } },
        { symbol: 'SPCX', name: 'SpaceX', price: 150, gap_pct: 2, pm_vol_pct: 2, atr_pct: 5, status: 'setting_up',
          cells: { week: { grade: 'C', path: 'scheduled', why: ['inside day · RS +2 vs SPY (20d) · earnings in 9 days — a run-up: out before the report'], range: { level: 152, pct: 1.3, atr_mult: 0.3 } } } },
    ],
}
const MID = {
    ...PREMARKET, id: 'hb_2026-10-21_mid', checkpoint: 'mid', columns: ['mid'], finished_at: 2, unverified_columns: ['mid'],
    argus: { summary: 'Breadth is healthy; the room is in SPCX, and the week list is mostly run-ups into earnings.', model: 'gpt-6-luna', picks: 1 },
    rows: [
        { symbol: 'SPCX', name: 'SpaceX', price: 162.77, gap_pct: 10.14, rvol: 3.39, atr_pct: 5.07, quoted_at: Date.parse('2026-10-21T14:31:00Z'), status: 'in_play',
          catalyst: { material: true, type: 'drift', surprise: 'mixed', headline: 'SpaceX swings to profit on AI infrastructure boom' },
          cells: { mid: { grade: 'B', why: ['3.39× normal volume, above the open'], range: { level: 166.18, pct: 2.09, atr_mult: 0.45 } } },
          pick: { symbol: 'SPCX', column: 'mid', why: 'A real profit swing on heavy volume with room to the prior high.', caution: 'A fade back under the open says the market disagrees.', rank: 1 } },
        { symbol: 'TSLA', name: 'Tesla', price: 450.1, gap_pct: 3.66, rvol: 1.31, atr_pct: 4.1, next_earnings: '2026-10-28', status: 'in_play',
          cells: { mid: { grade: 'C', why: ['1.6× normal volume, above the open'], range: { level: 451.5, pct: 0.31, atr_mult: 0.08 } } },
          avoid: 'No catalyst, modest volume, and 0.31% of room.' },
    ],
}
const TODAY = { day: '2026-10-21', latest: MID, day_list: dayList([PREMARKET, MID]), checkpoints: [
    { id: PREMARKET.id, checkpoint: 'premarket', status: 'done', columns: PREMARKET.columns, rows: 3, argus: false },
    { id: MID.id, checkpoint: 'mid', status: 'done', columns: MID.columns, rows: 2, argus: true }] }

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/hotlist-list-${name}.png` }); console.log('  shot:', name) }
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
const errors = [], results = [], turns = []
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
let page
try {
    const sessionFile = `${OUT}/hotlist-session.json`
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, ...(existsSync(sessionFile) ? { storageState: sessionFile } : {}) })
    page = await ctx.newPage()
    page.on('pageerror', e => errors.push(e.message))
    page.on('dialog', d => d.accept())

    await page.route('**/api/hotlist**', route => {
        const url = route.request().url()
        const body = url.includes('/boards/') ? (url.includes('premarket') ? PREMARKET : MID) : TODAY
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.route('**/api/sessions/*/turn', route => {
        try { turns.push(JSON.parse(route.request().postData() || '{}')) } catch { /* not JSON */ }
        return route.abort()
    })

    await signIn(page)
    await ctx.storageState({ path: sessionFile })
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.floor-lists', { timeout: 15000 })
    await page.waitForTimeout(2500)

    const desk = page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) })
    await desk.click()
    await page.waitForSelector('.hot-panel .hot-table--list', { timeout: 10000 })
    await page.waitForTimeout(600)
    await shot(page, '1-open')

    const view = await page.evaluate(() => {
        const p = document.querySelector('.hot-panel')
        const row = (s) => p.querySelector(`tr.hot-row[data-symbol="${s}"]`)
        const wrap = p.querySelector('.hot-table-wrap')
        return {
            title: p.querySelector('.detail-panel__title')?.textContent ?? '',
            listTab: p.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
            filters: [...p.querySelectorAll('.hot-status-filter__btn')].map(b => b.textContent),
            spcxStatus: row('SPCX')?.querySelector('.hot-status')?.textContent,
            spcxBest: row('SPCX')?.querySelector('.hot-best__col')?.textContent,
            spcxPriceTitle: row('SPCX')?.querySelectorAll('.hot-table__num')[0]?.getAttribute('title'),
            dxcReason: row('DXC')?.querySelector('.hot-reason')?.textContent,
            dxcEarn: row('DXC')?.querySelector('.hot-earn')?.textContent,
            dxcFound: [...(row('DXC')?.querySelectorAll('.hot-sub') ?? [])].map(s => s.textContent).find(t => t.startsWith('since')),
            accStatus: row('ACC')?.querySelector('.hot-status')?.textContent,
            argus: p.querySelector('.hot-argus__who')?.textContent,
            asOf: /Prices as of each name’s last checkpoint/.test(p.textContent),
            overflow: wrap.scrollWidth > wrap.clientWidth + 1,
            widths: `${wrap.scrollWidth}/${wrap.clientWidth}`,
        }
    })
    check('opens on Today\'s list', view.listTab === 'Today’s list' && /today’s list/.test(view.title), `${view.listTab} | ${view.title}`)
    check('every name once, in play first, then building, then setting up', await listOrder(page) === 'SPCX,TSLA,ACC,DXC', await listOrder(page))
    check('the filter has a count per status', view.filters.join('|') === 'All 4|In play 2|Building 1|Setting up 1', view.filters.join('|'))
    check('SPCX was setting up at 08:00, in play by 10:30 — the list says in play', view.spcxStatus === 'In play', view.spcxStatus)
    check('its best column is named on the row', view.spcxBest === 'Mid-day', view.spcxBest)
    check('the price says when it was read', /^As of /.test(view.spcxPriceTitle ?? ''), view.spcxPriceTitle)
    check('the why is on the row in plain words', /earnings in 8 days — a run-up: out before the report/.test(view.dxcReason ?? ''), view.dxcReason)
    check('an earnings run-up says out before', view.dxcEarn === 'E 10-29 · out before', view.dxcEarn)
    check('found at 08:00', view.dxcFound === 'since 08:00', view.dxcFound)
    check('money arriving reads as Building', view.accStatus === 'Building', view.accStatus)
    check('Argus\'s read is labelled with its checkpoint', view.argus === 'Argus · 10:30', view.argus)
    check('prices are marked as of the checkpoint, not live', view.asOf)
    check('the table fits the panel at 1600 px', !view.overflow, view.widths)

    // ── Filter and sort ──
    await page.getByRole('button', { name: 'Setting up 1' }).click()
    check('the status filter narrows the list', await listOrder(page) === 'DXC', await listOrder(page))
    await page.getByRole('button', { name: 'All 4' }).click()
    await page.locator('.hot-panel').getByRole('button', { name: 'Price', exact: true }).click()
    check('Price sorts high first', await listOrder(page) === 'TSLA,SPCX,ACC,DXC', await listOrder(page))
    await page.locator('.hot-panel').getByRole('button', { name: /^Price/ }).click()
    check('a second click flips it', await listOrder(page) === 'DXC,ACC,SPCX,TSLA', await listOrder(page))
    await shot(page, '2-sorted')

    // ── Boards view still there ──
    await page.getByRole('tab', { name: 'Boards' }).click()
    await page.waitForTimeout(400)
    const boards = await page.evaluate(() => ({
        tabs: [...document.querySelectorAll('.hot-panel [role="tab"]')].map(b => b.textContent),
        rows: [...document.querySelectorAll('.hot-panel tr.hot-row')].map(r => r.dataset.symbol).join(','),
    }))
    check('Boards shows one checkpoint with its tabs', boards.tabs.includes('10:30') && boards.rows === 'SPCX,TSLA', `${boards.tabs.join('|')} → ${boards.rows}`)
    await page.getByRole('tab', { name: 'Today’s list' }).click()
    await page.waitForTimeout(300)

    // ── Build with Mentor from the list: the week cell lives on the 08:00 board ──
    await page.locator('.hot-panel tr.hot-row[data-symbol="DXC"]').getByRole('button', { name: 'Build with Mentor' }).click()
    await page.waitForTimeout(1500)
    const t = turns.find(x => x.agent === 'mentor')
    check('the panel closes before Mentor gets the name', !(await page.locator('.hot-panel').isVisible().catch(() => false)))
    check('Mentor gets the cell\'s OWN board (08:00) and column (week)', t?.seed?.hotlist?.board === PREMARKET.id && t?.seed?.hotlist?.column === 'week', JSON.stringify(t?.seed?.hotlist))
    check('the opening read is the run-up reason', /out before the report/.test(t?.seed?.thesis ?? ''), t?.seed?.thesis)

    // ── A laptop width ──
    await page.setViewportSize({ width: 1366, height: 768 })
    await desk.click()
    await page.waitForSelector('.hot-panel .hot-table--list', { timeout: 10000 })
    await page.waitForTimeout(500)
    await shot(page, '3-laptop')
    const lap = await page.evaluate(() => { const w = document.querySelector('.hot-panel .hot-table-wrap'); return `${w.scrollWidth}/${w.clientWidth}` })
    const [sw, cw] = lap.split('/').map(Number)
    // Not a pass/fail: a wide list may scroll inside its frame on a laptop — the screenshot says how it reads.
    console.log(`  1366 px: table ${sw} wide in a ${cw} frame${sw > cw + 1 ? ' (scrolls sideways)' : ' (fits)'}`)

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
