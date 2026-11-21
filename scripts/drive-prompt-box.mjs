// DRIVE THE SCREEN — the prompt box's layout (Roy, 2026-11-21): the field full width on top, every button in one row
// under it; the mode menu opens UP from its chip and stays on screen — on a phone too (it opened down, off the bottom).
//
//   node scripts/drive-prompt-box.mjs [baseUrl] [outDir]     (default http://localhost:5173 · .)
//
// As the throwaway QA user `ui-smoke-panel`. One login, two viewports (desktop, then a phone). No agent turns.
/* global document, window -- the page.evaluate bodies run in the browser */
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke-panel', password: 'Sm0ke!Drive#29' }

let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }

const browser = await chromium.launch({ channel: 'msedge' })
const errors = []
try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const desk = await ctx.newPage()
    desk.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
    await desk.goto(BASE, { waitUntil: 'domcontentloaded' })
    await desk.waitForTimeout(1500)
    if (await desk.locator('input[type="password"]').count()) {
        const inputs = desk.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await desk.keyboard.press('Enter')
        await desk.waitForTimeout(3500)
    }
    const state = await ctx.storageState()

    const check = async (page, name) => {
        console.log(name)
        await page.waitForSelector('.chat-timeline .chat-input-row', { timeout: 30_000 })
        const g = await page.evaluate(() => {
            const r = (s) => document.querySelector(`.chat-timeline ${s}`)?.getBoundingClientRect()
            const box = r('.chat-input-row'), ta = r('.chat-input-row__textarea'), bar = r('.chat-input-row__bar')
            const chip = r('.mode-picker__toggle'), mic = r('.chat-input-row__mic'), send = r('.chat-input-row__send')
            return { box, ta, bar, chip, mic, send }
        })
        expect(g.ta.bottom <= g.bar.top + 1, 'the field is above the buttons')
        expect(g.ta.width >= g.box.width - 24, `the field is the box's full width (${Math.round(g.ta.width)} of ${Math.round(g.box.width)})`)
        expect(g.chip.left < g.mic.left && g.mic.right < g.send.left, 'mode, mic on the left; send on the right')
        expect(Math.abs(g.send.right - g.box.right) < 24, 'send at the right edge')
        await page.screenshot({ path: `${OUT}/prompt-${name}-closed.png` })
        await page.locator('.chat-timeline .mode-picker__toggle').click()
        await page.waitForTimeout(400)
        const m = await page.evaluate(() => {
            const menu = document.querySelector('.mode-picker__menu')?.getBoundingClientRect()
            const chip = document.querySelector('.mode-picker__toggle')?.getBoundingClientRect()
            return menu && chip ? { above: menu.bottom <= chip.top + 2, top: menu.top, bottom: menu.bottom, vh: window.innerHeight, n: document.querySelectorAll('.mode-picker__option').length } : null
        })
        expect(m?.above, `the menu opens up from the chip (${JSON.stringify(m)})`)
        expect(m && m.top >= 0 && m.bottom <= m.vh, 'the whole menu is on screen')
        expect(m?.n === 3, 'the three other modes are listed')
        await page.screenshot({ path: `${OUT}/prompt-${name}-open.png` })
        await page.keyboard.press('Escape')
    }

    await check(desk, 'desktop')

    const phone = await browser.newContext({ storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    const mob = await phone.newPage()
    mob.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
    await mob.goto(BASE, { waitUntil: 'domcontentloaded' })
    await mob.waitForTimeout(3000)
    await check(mob, 'phone')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
