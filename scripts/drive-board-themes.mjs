/* global document -- page.evaluate bodies run in the browser */
// DRIVE THE THEMES — on the Forecast map (a row above the sectors) and on Pythia's board (bug 2026-10-23: a board
// theme never opened its panel).
//
//   node scripts/drive-board-themes.mjs [baseUrl] [outDir]
//
// Desktop (1600×900): Forecasts opens the map; Board opens Pythia's board over it; the Themes tab lists the approved
// themes; a theme opens its own panel (the board kept under it); ✕ goes back to the board ON the Themes tab. The bug
// was the board remounting when it went under (DetailPanel rendered its content in two different trees), which reset
// the tab and closed the theme's panel as it opened. Needs approved themes in the database (axl_dev has four).
// LOOK at the screenshots.
import dns from 'dns'
import { existsSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { userService } = await import('../api/user/user.service.js')

const shot = async (page, name) => {
    await page.screenshot({ path: `${OUT}/board-themes-${name}.png`, fullPage: false })
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

const panel = (page) => page.evaluate(() => {
    const p = [...document.querySelectorAll('.detail-panel')].find(x => !x.closest('[hidden]'))
    if (!p) return null
    return {
        title: p.querySelector('.detail-panel__title')?.textContent ?? null,
        tab: p.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null,
        themes: p.querySelectorAll('.industry-view__row').length,
        text: p.querySelector('.detail-panel__body')?.textContent?.slice(0, 140) ?? null,
        // A theme's chain, by order (ThemesView): "1 · Direct", "2 · Suppliers"…
        orders: [...p.querySelectorAll('.industry-view__answer-q')].map(q => q.textContent.trim()),
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
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, ...(existsSync(session) ? { storageState: session } : {}) })
    page = await ctx.newPage()
    page.on('pageerror', e => errors.push(e.message))
    page.on('response', r => { if (r.url().includes('/api/strategy/') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`) })
    await signIn(page)
    await ctx.storageState({ path: session })
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.floor-lists', { timeout: 15000 }).catch(async e => { await shot(page, '0-no-floor'); throw e })
    await page.waitForTimeout(1500)

    await page.locator('.floor-desk__head', { hasText: 'Forecasts' }).click()
    await page.waitForSelector('.fm-tile', { timeout: 20000 }).catch(async e => { await shot(page, '0-no-map'); throw e })

    // ── the map's Themes row (Roy, 2026-10-23: "I want to see it in Forecast") ──
    const row = page.locator('section.fm-sector--themes')
    const themeTiles = await row.locator('.fm-tile').count()
    const firstSection = await page.locator('.fm-sector').first().getAttribute('aria-label')
    await shot(page, '0a-map-themes-row')
    check('the map opens with a Themes row first', firstSection === 'Themes' && themeTiles > 0, `${firstSection}, ${themeTiles} theme tiles`)
    const tileName = (await row.locator('.fm-tile__name').first().textContent())?.trim()
    await row.locator('.fm-tile').first().click()
    await page.waitForTimeout(500)
    let m = await panel(page)
    await shot(page, '0b-map-theme-page')
    check('a theme tile opens its page in the Forecast window', m?.title?.trim() === tileName && m?.orders?.length > 0, `${m?.title} · ${(m?.orders ?? []).join(' | ')}`)
    const link = page.locator('.themes-view__link').first()
    const linkName = (await link.textContent())?.trim()
    await link.click()
    await page.waitForTimeout(1200)
    m = await panel(page)
    await shot(page, '0c-map-link-industry')
    check('a link opens that industry', m?.title?.trim() === linkName, `wanted ${linkName}, got ${m?.title}`)
    await page.getByRole('button', { name: `‹ ${tileName}` }).click()
    await page.waitForTimeout(400)
    m = await panel(page)
    check('the industry\'s back returns to the theme', m?.title?.trim() === tileName, m?.title)
    await page.getByRole('button', { name: '‹ Map' }).click()
    await page.waitForTimeout(400)

    await page.getByRole('button', { name: 'Board', exact: true }).click()
    await page.waitForSelector('[role="tab"]', { timeout: 10000 }).catch(async e => { await shot(page, '0-no-board'); throw e })
    await page.getByRole('tab', { name: 'Themes' }).click()
    await page.waitForTimeout(600)
    let s = await panel(page)
    await shot(page, '1-themes-tab')
    check('the board opens on the Themes tab when asked', s?.tab === 'Themes', JSON.stringify(s))
    check('the approved themes are listed', s?.themes > 0, `${s?.themes} rows`)

    const first = page.locator('.industry-view__row .industry-view__line').first()
    const name = (await first.locator('.industry-view__name').textContent())?.trim()
    await first.click()
    await page.waitForTimeout(800)
    s = await panel(page)
    await shot(page, '2-theme-open')
    check('a theme opens ITS panel', s?.title?.trim() === name, `wanted "${name}", got ${JSON.stringify(s?.title)}`)
    check('the theme panel shows its chain by order', s?.orders?.length > 0 && /direct/i.test(s.orders[0]), (s?.orders ?? []).join(' | '))

    await page.locator('.detail-panel:not([hidden]) .detail-panel__close').last().click()
    await page.waitForTimeout(600)
    s = await panel(page)
    await shot(page, '3-back-to-board')
    check('✕ goes back to the board, still on Themes', s?.tab === 'Themes' && s?.themes > 0, JSON.stringify(s))

    check('no page errors or failed strategy calls', errors.length === 0, errors.join(' | '))
} catch (err) {
    results.push(`FAIL  the drive stopped — ${err.message}`)
    if (page) await shot(page, 'x-stopped').catch(() => {})
} finally {
    await browser.close()
    console.log(results.join('\n'))
    process.exitCode = results.some(r => r.startsWith('FAIL')) ? 1 : 0
    process.exit()
}
