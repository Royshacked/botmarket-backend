/* global document, window, getComputedStyle -- page.evaluate bodies run in the browser */
// DRIVE: THE PHONE'S MENU (Roy, 2026-11-02: "when opening menu in mobile — user profile and chat btns at the top; menu
// covers the screen; increase font size of the menu items").
//
//   node scripts/drive-phone-menu.mjs [baseUrl] [outDir]   (default http://localhost:5173 — the Vite dev server)
//
// A 390-px phone as `ui-smoke`, one sign-in. Proves: the open menu covers the screen under the bar; messages and the
// profile sit above the lists; the list items are 18px; the hamburger stays on top and closes it; a list still opens
// its window.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message.slice(0, 200)))

/** The open menu's geometry: the sheet's box, the bar's bottom, where its parts sit, the list items' font size. */
const menu = () => page.evaluate(() => {
    const box = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null
    const sheet = box('.app-header-axl__cluster.is-open')
    const item = document.querySelector('.app-header-axl__list')
    return {
        sheet: sheet && { top: Math.round(sheet.top), left: Math.round(sheet.left), right: Math.round(sheet.right), bottom: Math.round(sheet.bottom) },
        bar: Math.round(document.querySelector('.app-header-axl')?.getBoundingClientRect().bottom ?? 0),
        vw: window.innerWidth, vh: window.innerHeight,
        chat: box('.app-header-axl__chat')?.top ?? null, profile: box('.app-header-axl__profile')?.top ?? null,
        lists: box('.app-header-axl__lists')?.top ?? null, modes: box('.app-header-axl__modes')?.top ?? null,
        font: item ? getComputedStyle(item).fontSize : null,
        // What a tap on the hamburger's centre lands on.
        burgerOnTop: (() => {
            const b = document.querySelector('.app-header-axl__burger')?.getBoundingClientRect()
            return b ? Boolean(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('.app-header-axl__burger')) : false
        })(),
    }
})

try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline').waitFor({ timeout: 20000 })

    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.waitForTimeout(600)
    const m = await menu()
    await page.screenshot({ path: `${OUT}/phone-menu-open.png` })
    const s = m.sheet
    check('the menu covers the screen under the bar', Boolean(s && s.left === 0 && s.right === m.vw && s.bottom === m.vh && Math.abs(s.top - m.bar) <= 2), JSON.stringify({ ...s, bar: m.bar, vw: m.vw, vh: m.vh }))
    check('messages and the profile sit above the lists', m.chat != null && m.profile != null && m.chat < m.lists && m.profile < m.lists && m.lists < m.modes,
        `chat ${Math.round(m.chat)} · profile ${Math.round(m.profile)} · lists ${Math.round(m.lists)} · modes ${Math.round(m.modes)}`)
    check('the list items are 18px', m.font === '18px', m.font)
    check('the hamburger stays on top of the sheet', m.burgerOnTop)

    await page.getByRole('button', { name: 'Close menu' }).click()
    await page.waitForTimeout(400)
    check('the hamburger closes it', !(await menu()).sheet)

    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: 'Hotlist' }).click()
    await page.waitForSelector('.hot-panel', { timeout: 30000 })
    check('a list still opens its window, and the menu closes', !(await menu()).sheet)
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
    await page.screenshot({ path: `${OUT}/phone-menu-error.png` }).catch(() => {})
} finally {
    if (errors.length) check('no page errors', false, errors.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
}
