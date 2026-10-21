/* global document -- page.evaluate bodies run in the browser */
// Drive the Floor's HOTLIST in a real browser (docs/design/daily-names.md §8, build phase 6).
//
//   node scripts/drive-hotlist.mjs [baseUrl] [outDir]      (default http://localhost:5173 — the Vite dev server)
//
// WHAT IS REAL AND WHAT IS NOT. The page, the Floor, the panel, the session and the clicks are real.
// The BOARD is a fixture served for /api/hotlist — the screener is off and its boards come from a
// checkpoint run, so nothing is staged in the database. The hand-offs' TURNS are captured and then
// aborted: the drive checks what Mentor and Argus would be sent (the seed's board reference, the
// question) without paying for a model call or writing a turn. Everything else reaches the backend.
//
// Uses the drive account `ui-smoke-panel` (created on first run, like drive-floor-lists). The auth
// limiter counts these sign-ins against this machine's IP — run it alone, not in a batch of drives.

import dns from 'dns'
import { existsSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { closeDb } = await import('../providers/mongodb.provider.js')
const { userService } = await import('../api/user/user.service.js')

const MID = {
    id: 'hb_2026-10-21_mid', day: '2026-10-21', checkpoint: 'mid', status: 'done', columns: ['mid'],
    unverified: true, unverified_columns: ['mid'], finished_at: 2,
    regime: { breadth_above_sma20: 58, spy: { above_sma20: true, ret5: 1.2 } },
    argus: { summary: 'Breadth is healthy and the room is in two names; most of the gappers have already run into resistance.', model: 'gpt-6-luna', picks: 1 },
    rows: [
        { symbol: 'SPCX', name: 'SpaceX', sector: 'Industrials', price: 162.77, gap_pct: 10.14, rvol: 3.39, atr_pct: 5.07, next_earnings: null,
          catalyst: { material: true, type: 'drift', surprise: 'mixed', magnitude: 'major', headline: 'SpaceX swings to profit on AI infrastructure boom' },
          cells: { mid: { grade: 'B', why: ['3.39× normal volume, above the open'], range: { level: 166.18, pct: 2.09, atr_mult: 0.45, open_sky: false } } },
          pick: { symbol: 'SPCX', column: 'mid', why: 'A real profit swing on heavy volume with room to the prior high.', caution: 'The capex bill is the bear case — a fade back under the open says the market agrees.', rank: 1 } },
        { symbol: 'TSLA', name: 'Tesla', sector: 'Consumer Discretionary', price: 450.1, gap_pct: 3.66, rvol: 1.31, atr_pct: 4.1, next_earnings: '2026-10-28', catalyst: null,
          cells: { mid: { grade: 'C', why: ['1.6× normal volume, above the open'], range: { level: 451.5, pct: 0.31, atr_mult: 0.08, open_sky: false } } },
          avoid: 'No catalyst, modest volume, and 0.31% of room before resistance.' },
        { symbol: 'NVDA', name: 'NVIDIA', sector: 'Technology', price: 219.9, gap_pct: 1.8, rvol: 1.7, atr_pct: 3.1, catalyst: { material: false, type: 'none', surprise: 'none' },
          cells: { mid: { grade: 'A', why: ['1.7× normal volume, above the open'], range: { open_sky: true, level: null, pct: null, atr_mult: null } } } },
    ],
}
const PREMARKET = {
    ...MID, id: 'hb_2026-10-21_premarket', checkpoint: 'premarket', columns: ['open', 'week'], finished_at: 1, argus: null,
    rows: [{ symbol: 'ABC', name: 'Abc Corp', price: 104, gap_pct: 4, pm_vol_pct: 3, atr_pct: 4, next_earnings: '2026-10-27',
        catalyst: { material: true, type: 'drift', surprise: 'positive', headline: 'Abc wins a contract' },
        cells: { open: { grade: 'B', why: ['gap +4% on 3% of a day\'s volume pre-market'], range: { level: 106, pct: 1.92, atr_mult: 0.5 } },
                 week: { grade: 'C', why: ['NR7 · RS +3 vs SPY (20d) · earnings in 6 days'], range: { level: 106, pct: 1.92, atr_mult: 0.5 } } } }],
}
const TODAY = { day: '2026-10-21', latest: MID, checkpoints: [
    { id: PREMARKET.id, checkpoint: 'premarket', status: 'done', columns: PREMARKET.columns, rows: 1, argus: false },
    { id: MID.id, checkpoint: 'mid', status: 'done', columns: MID.columns, rows: 3, argus: true }] }

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/hotlist-${name}.png` }); console.log('  shot:', name) }

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

    // The board: a fixture. The turns: captured, then aborted (no model call, no turn written).
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
    check('the Floor lists a Hotlist row', await desk.count() === 1)
    const order = await page.evaluate(() => [...document.querySelectorAll('.floor-lists .floor-desk__label')].map(l => l.textContent))
    check('it sits after Watchlists', order.indexOf('Hotlist') === order.indexOf('Watchlists') + 1, order.join(' · '))

    // ── Open it ──
    await desk.click()
    await page.waitForSelector('.hot-panel .hot-board', { timeout: 10000 })
    await page.waitForTimeout(600)
    await shot(page, '1-open')
    const view = await page.evaluate(() => {
        const p = document.querySelector('.hot-panel')
        return {
            title: p.querySelector('.detail-panel__title')?.textContent ?? p.textContent.slice(0, 80),
            argus: p.querySelector('.hot-argus__text')?.textContent,
            rows: [...p.querySelectorAll('tr.hot-row')].map(r => r.dataset.symbol),
            star: p.querySelector('.hot-star')?.textContent,
            unverified: !!p.querySelector('.hot-note'),
            sky: [...p.querySelectorAll('.hot-range')].map(r => r.textContent),
            avoid: !!p.querySelector('.hot-row--avoid'),
            tabs: [...p.querySelectorAll('.hot-nav__btn')].map(b => b.textContent),
            overflow: p.querySelector('.hot-table-wrap').scrollWidth > p.querySelector('.hot-table-wrap').clientWidth + 1,
            overChat: !!document.querySelector('.chat-panel .hot-panel, .chat-column .hot-panel') || !!p.closest('.detail-panel'),
        }
    })
    check('opens on the latest board (10:30)', /10:30/.test(view.title), view.title)
    check('Argus\'s summary is on top', /Breadth is healthy/.test(view.argus ?? ''))
    check('every row is listed in the board\'s order', view.rows.join(',') === 'SPCX,TSLA,NVDA', view.rows.join(','))
    check('Argus\'s pick is starred', view.star === '★1')
    check('the unverified note is shown', view.unverified)
    check('free range reads as % · × ATR, and open sky', view.sky.includes('2.1% · 0.45× ATR') && view.sky.includes('open sky'), view.sky.join(' | '))
    check('a trap is marked', view.avoid)
    check('the day\'s checkpoints are tabs', view.tabs.join('|') === '08:00 pre-market|10:30', view.tabs.join('|'))
    check('the table fits the panel without a sideways scroll', !view.overflow)

    // ── Picks only ──
    await page.getByLabel(/Argus’s picks only/).check()
    await page.waitForTimeout(300)
    const onlyPicks = await page.evaluate(() => [...document.querySelectorAll('.hot-panel tr.hot-row')].map(r => r.dataset.symbol))
    check('"Argus\'s picks only" narrows to the stars', onlyPicks.join(',') === 'SPCX', onlyPicks.join(','))
    await page.getByLabel(/Argus’s picks only/).uncheck()

    // ── Another checkpoint ──
    await page.getByRole('tab', { name: '08:00 pre-market' }).click()
    await page.waitForSelector('.hot-panel tr.hot-row[data-symbol="ABC"]', { timeout: 5000 })
    await shot(page, '2-premarket')
    const pre = await page.evaluate(() => [...document.querySelectorAll('.hot-panel thead th')].map(t => t.textContent))
    check('the pre-market board shows its own columns', pre.includes('Open') && pre.includes('This week'), pre.join('|'))
    await page.getByRole('tab', { name: '10:30' }).click()
    await page.waitForSelector('.hot-panel tr.hot-row[data-symbol="SPCX"]', { timeout: 5000 })

    // ── Build with Mentor ──
    await page.locator('.hot-panel tr.hot-row[data-symbol="SPCX"]').getByText('Build with Mentor').click()
    await page.waitForTimeout(1500)
    await shot(page, '3-mentor')
    const mentorTurn = turns.find(t => t.agent === 'mentor')
    check('the panel closes before Mentor gets the name', !(await page.locator('.hot-panel').isVisible().catch(() => false)))
    check('Mentor is sent the name as the user\'s turn', /SPCX/.test(mentorTurn?.text ?? ''), mentorTurn?.text)
    check('the seed carries the board REFERENCE — board id and column', mentorTurn?.seed?.hotlist?.board === MID.id && mentorTurn?.seed?.hotlist?.column === 'mid', JSON.stringify(mentorTurn?.seed?.hotlist))
    check('no board facts ride in the seed', !('grade' in (mentorTurn?.seed?.hotlist ?? {})) && !mentorTurn?.seed?.hotlist_facts)
    check('the opening read is Argus\'s pick note', /real profit swing/.test(mentorTurn?.seed?.thesis ?? ''), mentorTurn?.seed?.thesis)
    const pane = await page.evaluate(() => document.querySelector('.side-pane')?.textContent?.slice(0, 120) ?? null)
    check('Mentor\'s desk opens beside the chat', /Mentor/i.test(pane ?? ''), pane)

    // ── Ask Argus ──
    await desk.click()
    await page.waitForSelector('.hot-panel tr.hot-row[data-symbol="TSLA"]', { timeout: 10000 })
    await page.locator('.hot-panel tr.hot-row[data-symbol="TSLA"]').getByText('Ask Argus').click()
    await page.waitForTimeout(2500)
    await shot(page, '4-argus')
    const argusTurn = turns.find(t => t.agent === 'scanner')
    check('Argus is asked about the row, in the user\'s words', /^From today's hotlist: TSLA — Mid-day C/.test(argusTurn?.text ?? ''), argusTurn?.text)

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
