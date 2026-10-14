// DRIVE THE FLOOR LISTS — the desk strip, dimmed empty desks, the pinned heading and the Calendar
// (Roy, 2026-10-14).
//
//   node scripts/drive-floor-lists.mjs [baseUrl] [outDir]
//
// Desktop (1600×900): all desks closed → every header, the empty ones dimmed, no strip; a short
// window scrolls the column under a pinned "Lists" heading. One desk open → the strip shows every
// desk with its count, the open one marked, and a chip switches desks. Calendar → a month grid over
// the chat with per-day counts and the important Fed days named; a day opens its page, back returns,
// Esc closes. Needs the backend RUNNING the calendar routes. LOOK at the screenshots.
/* global document, getComputedStyle -- page.evaluate bodies run in the browser */
import dns from 'dns'
import { existsSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { closeDb } = await import('../providers/mongodb.provider.js')
const { userService } = await import('../api/user/user.service.js')

const shot = async (page, name) => {
    await page.screenshot({ path: `${OUT}/floor-${name}.png`, fullPage: false })
    console.log('  shot:', name)
}

async function signIn(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    // The sign-in form is the page with a password field — a signed-in app has other inputs (chat).
    const inputs = page.locator('input')
    if (await page.locator('input[type="password"]').count()) {
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
}

const columnState = (page) => page.evaluate(() => {
    const col = document.querySelector('.floor-lists')
    const strip = col?.querySelector('.floor-strip')
    const desks = [...(col?.querySelectorAll('.floor-desk') ?? [])].map(d => ({
        label: d.querySelector('.floor-desk__label')?.textContent,
        open: d.classList.contains('floor-desk--open'),
        folded: d.classList.contains('floor-desk--folded'),
        empty: d.classList.contains('floor-desk--empty'),
        labelColor: getComputedStyle(d.querySelector('.floor-desk__label')).color,
    }))
    const body = col?.querySelector('.floor-desk--open .floor-desk__body')
    return {
        strip: strip ? {
            chips: [...strip.querySelectorAll('.floor-strip__chip')].map(c => c.textContent),
            active: strip.querySelector('[aria-current="true"]')?.textContent,
            height: Math.round(strip.getBoundingClientRect().height),
        } : null,
        desks,
        bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : null,
        columnScrolls: col ? col.scrollHeight > col.clientHeight + 1 : null,
    }
})

try { await userService.createUser(USER); console.log('qa user created') } catch (e) { console.log('qa user exists —', e.message) }

const browser = await chromium.launch({ channel: 'msedge' })
const errors = []
const results = []
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
let page
try {
    // Reuse the last run's session: sign-in is rate-limited (RATE_LIMIT_AUTH_PER_15M), and a few
    // reruns in a row would otherwise lock the QA user out for fifteen minutes.
    const session = `${OUT}/floor-session.json`
    const ctx = await browser.newContext({
        viewport: { width: 1600, height: 900 },
        ...(existsSync(session) ? { storageState: session } : {}),
    })
    page = await ctx.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await signIn(page)   // fills the form only when one is showing
    await ctx.storageState({ path: session })
    // The Floor is a stored design choice (designService), read at load.
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.floor-lists', { timeout: 15000 })
        .catch(async e => { await shot(page, '0-no-floor'); throw e })
    await page.waitForTimeout(2500)

    let s = await columnState(page)
    await shot(page, '1-closed')
    check('no strip while every desk is closed', !s.strip)
    const heights = await page.evaluate(() => ({
        desk: Math.round(document.querySelector('.floor-desk__head').getBoundingClientRect().height),
        heading: Math.round(document.querySelector('.floor-lists > .floor-sec').getBoundingClientRect().height),
    }))
    check('desk titles are shorter than the column heading', heights.desk < heights.heading && heights.desk <= 40, JSON.stringify(heights))
    const empties = s.desks.filter(d => d.empty)
    const fulls = s.desks.filter(d => !d.empty)
    check('empty desks are still in the column', empties.length > 0, empties.map(d => d.label).join(', '))
    check('an empty label is dimmed vs a full one',
        !fulls.length || !empties.length || empties[0].labelColor !== fulls[0].labelColor,
        `${empties[0]?.labelColor} vs ${fulls[0]?.labelColor}`)

    // A short window: every desk closed overflows the column, so the column scrolls — the "Lists"
    // header must stay pinned at its top while the desk buttons go under it.
    await page.setViewportSize({ width: 1600, height: 420 })
    await page.waitForTimeout(500)
    const pin = await page.evaluate(() => {
        const col = document.querySelector('.floor-lists')
        const head = col.querySelector(':scope > .floor-sec')
        const scrolls = col.scrollHeight > col.clientHeight + 1
        col.scrollTop = col.scrollHeight
        const top = Math.round(head.getBoundingClientRect().top - col.getBoundingClientRect().top)
        return { scrolls, scrolled: col.scrollTop, top }
    })
    await shot(page, '1b-closed-scrolled')
    check('closed column scrolls in a short window', pin.scrolls, JSON.stringify(pin))
    check('header stays pinned while it scrolls', pin.scrolled > 0 && Math.abs(pin.top) <= 1, `${pin.top}px from the top`)
    await page.evaluate(() => { document.querySelector('.floor-lists').scrollTop = 0 })
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.waitForTimeout(500)

    await page.locator('.floor-desk__head').filter({ hasText: 'Your trades' }).click()
    await page.waitForTimeout(1200)
    s = await columnState(page)
    await shot(page, '2-open-trade')
    check('strip shows every desk', s.strip?.chips.length === s.desks.length, s.strip?.chips.join(' · '))
    check('strip marks the open desk', s.strip?.active?.startsWith('Your trades'), s.strip?.active)
    check('strip is short', s.strip && s.strip.height <= 110, `${s.strip?.height}px`)
    check('open desk still gets most of the column', s.bodyHeight > 450, `${s.bodyHeight}px`)
    check('column itself does not scroll', s.columnScrolls === false)

    await page.locator('.floor-strip__chip').filter({ hasText: 'Watchlists' }).click()
    await page.waitForTimeout(1200)
    s = await columnState(page)
    await shot(page, '3-chip-to-scans')
    check('chip switched to Watchlists', s.desks.find(d => d.open)?.label === 'Watchlists')

    await page.locator('.floor-strip__chip--active').click()
    await page.waitForTimeout(1000)
    s = await columnState(page)
    check('active chip closes the desk', !s.strip && !s.desks.some(d => d.open))

    // ── The Calendar desk: a month grid in the detail panel over the chat ───────────────────────
    await page.locator('.floor-desk__head').filter({ hasText: 'Calendar' }).click()
    await page.waitForSelector('.cal-grid', { timeout: 10000 })
    await page.waitForFunction(() => !document.querySelector('.cal-grid__note'), null, { timeout: 30000 }).catch(() => {})
    const cal = await page.evaluate(() => {
        const p = document.querySelector('.detail-panel')
        const chat = document.querySelector('.workspace__chat')?.getBoundingClientRect()
        const r = p.getBoundingClientRect()
        const cells = [...document.querySelectorAll('.cal-cell')]
        const busiest = cells
            .map(c => ({ label: c.getAttribute('aria-label'), n: Number((c.getAttribute('aria-label').match(/(\d+) earnings/) || [])[1] || 0) }))
            .sort((a, b) => b.n - a.n)[0]
        return {
            title: p.querySelector('.detail-panel__title')?.textContent,
            overChat: chat ? Math.abs(r.left - chat.left) < 2 && Math.abs(r.width - chat.width) < 2 : false,
            cells: cells.length,
            withCounts: cells.filter(c => c.querySelector('.cal-cell__line')).length,
            today: document.querySelector('.cal-cell--today')?.getAttribute('aria-label'),
            busiest,
            cellWidth: Math.round(cells[0].getBoundingClientRect().width),
            // Vertical centre of each header item: the title block, every nav button, the ✕.
            headMids: [p.querySelector('.detail-panel__titles'), ...p.querySelectorAll('.cal-nav__btn'), p.querySelector('.detail-panel__close')]
                .map(el => { const b = el.getBoundingClientRect(); return Math.round(b.top + b.height / 2) }),
            navLabels: [...p.querySelectorAll('.cal-nav__btn')].map(b => b.textContent.trim()),
            key: [...document.querySelectorAll('.cal-cell--key')].map(c => `${c.querySelector('.cal-cell__num').textContent}:${c.querySelector('.cal-cell__key').textContent}`),
        }
    })
    await shot(page, '4-calendar-month')
    check('calendar opens over the chat column', cal.overChat, cal.title)
    check('grid is whole weeks with counts', cal.cells % 7 === 0 && cal.withCounts > 5, `${cal.cells} cells, ${cal.withCounts} with counts, ${cal.cellWidth}px wide`)
    check('today is marked', !!cal.today, cal.today)
    check('header nav reads ‹ Month ›', cal.navLabels[1] === cal.title.split(' ')[0], cal.navLabels.join(' '))
    check('header items share one centre line', Math.max(...cal.headMids) - Math.min(...cal.headMids) <= 1, cal.headMids.join(','))
    check('important Fed days are marked and named', cal.key.length > 0, cal.key.join('  '))

    // The busiest day of the month — its page replaces the grid.
    await page.locator('.cal-cell', { has: page.locator('.cal-cell__line--earnings') }).filter({ hasText: String(cal.busiest.n) }).first().click()
    await page.waitForSelector('.cal-day__sec, .floor-empty', { timeout: 60000 })
    await page.waitForFunction(() => !document.querySelector('.detail-panel .floor-empty')?.textContent?.includes('Loading'), null, { timeout: 60000 })
    const dayPage = await page.evaluate(() => ({
        title: document.querySelector('.detail-panel__title')?.textContent,
        grid: !!document.querySelector('.cal-grid'),
        heads: [...document.querySelectorAll('.cal-day__head')].map(h => h.textContent),
        first: [...document.querySelectorAll('.detail-panel .floor-cal__sym')].slice(0, 5).map(s => s.textContent),
    }))
    await shot(page, '5-calendar-day')
    check('a date page replaces the grid', !dayPage.grid && dayPage.heads.length > 0, `${dayPage.title}: ${dayPage.heads.join(' · ')}`)
    check('the day lists the busiest count', dayPage.heads.some(h => h.includes(`(${cal.busiest.n})`)), `${cal.busiest.label} → ${dayPage.first.join(', ')}`)

    await page.locator('.cal-nav__btn').first().click()
    await page.waitForSelector('.cal-grid', { timeout: 10000 })
    check('back returns to the month', true)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    check('Esc closes the calendar', !(await page.locator('.detail-panel').count()))
} catch (e) {
    results.push(`FAIL  threw — ${e.message.split('\n')[0]}`)
    if (page) await shot(page, 'x-failure').catch(() => {})
} finally {
    await browser.close()
    await closeDb?.()
}
console.log(results.join('\n'))
if (errors.length) console.log('page errors:\n' + errors.join('\n'))
