/* global document, window, getComputedStyle -- page.evaluate bodies run in the browser */
// DRIVE: THE CHAT HEADER ON A PHONE (Roy, 2026-11-04: "when chatting on mobile the new session button is hidden to the
// right; maybe a carousel for the buttons on top").
//
//   node scripts/drive-chat-header-phone.mjs [baseUrl] [outDir]   (default http://localhost:5173 — the Vite dev server)
//
// Phones of 320, 390 and 430 px as `ui-smoke`, one sign-in, the longest desk name in the title. Proves: the page does not
// scroll sideways; every header button can be reached by swiping the row, and is then fully on screen and is what a tap
// there lands on; the title stays readable. A desktop width stays one fixed row that does not scroll.
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

const measure = () => page.evaluate(() => {
    const row = document.querySelector('.chat-timeline__actions')
    const title = document.querySelector('.chat-timeline__title')
    if (!row) return null
    // The longest desk name, and the desk's button as it reads while working with one. A real turn is not worth its cost for a row's width.
    title.innerHTML = '<span class="chat-timeline__title-lead">Talking with </span>Prometheus'
    if (!row.querySelector('.chat-timeline__pane-toggle')) {
        const toggle = row.querySelector('button').cloneNode(true)
        toggle.className = 'chat-timeline__action chat-timeline__pane-toggle'
        toggle.textContent = 'Hide Prometheus’s work'
        row.prepend(toggle)
    }
    const vw = window.innerWidth
    const r = row.getBoundingClientRect()
    return {
        vw, pageOverflow: document.documentElement.scrollWidth - vw,
        rowLeft: Math.round(r.left), rowRight: Math.round(r.right), scrollable: row.scrollWidth - row.clientWidth,
        titleWidth: Math.round(title.getBoundingClientRect().width), titleFull: title.scrollWidth <= title.clientWidth,
        fade: getComputedStyle(row).getPropertyValue('--chat-actions-fade').trim(),
        buttons: [...row.querySelectorAll('button')].map(b => b.textContent.trim()),
    }
})

/** Swipe the row to each button in turn: is it wholly on screen, and does a tap at its centre land on it? */
const reach = (label) => page.evaluate((text) => {
    const row = document.querySelector('.chat-timeline__actions')
    const b = [...row.querySelectorAll('button')].find(x => x.textContent.trim() === text)
    if (!b) return { found: false }
    // The ROW scrolls, as a finger would. scrollIntoView also scrolls clipped ancestors, and passed on the broken header.
    const edge = () => row.getBoundingClientRect()
    let r = b.getBoundingClientRect()
    if (r.right > edge().right) row.scrollLeft += r.right - edge().right
    if (r.left < edge().left) row.scrollLeft -= edge().left - r.left
    r = b.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { found: true, left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, onTop: Boolean(top?.closest('button') === b) }
}, label)

try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await page.locator('input[type="password"]').fill(USER.password)
        await page.keyboard.press('Enter')
    }
    await page.waitForSelector('.chat-timeline__actions', { timeout: 20000 })
    await page.waitForTimeout(800)

    for (const width of [320, 390, 430]) {
        await page.setViewportSize({ width, height: 844 })
        await page.waitForTimeout(300)
        const m = await measure()
        console.log(JSON.stringify(m))
        check(`${width}px: the page does not scroll sideways`, m.pageOverflow <= 0, `overflow ${m.pageOverflow}px`)
        check(`${width}px: the row stays inside the screen`, m.rowRight <= width && m.rowLeft >= 0, `${m.rowLeft}..${m.rowRight}`)
        check(`${width}px: the desk's name shows in full`, m.titleFull && m.titleWidth >= 60, `${m.titleWidth}px`)
        check(`${width}px: the row swipes, and fades while there is more`, m.scrollable > 0 && m.fade === '28px', `${m.scrollable}px, fade ${m.fade}`)
        for (const label of m.buttons) {
            const r = await reach(label)
            check(`${width}px: "${label}" can be reached`, r.found && r.left >= 0 && r.right <= r.vw && r.onTop, JSON.stringify(r))
        }
        await page.screenshot({ path: `${OUT}/chat-header-${width}.png`, clip: { x: 0, y: 0, width, height: 220 } })
        // All the way: the row's own padding sits past the last button.
        await page.evaluate(() => { const row = document.querySelector('.chat-timeline__actions'); row.scrollLeft = row.scrollWidth })
        await page.waitForTimeout(150)
        await page.screenshot({ path: `${OUT}/chat-header-${width}-end.png`, clip: { x: 0, y: 0, width, height: 220 } })
        const atEnd = await page.evaluate(() => getComputedStyle(document.querySelector('.chat-timeline__actions')).getPropertyValue('--chat-actions-fade').trim())
        check(`${width}px: no fade at the end of the row`, atEnd === '0px', atEnd)
        await page.evaluate(() => { document.querySelector('.chat-timeline__actions').scrollLeft = 0 })
        await page.waitForTimeout(100)
        await page.screenshot({ path: `${OUT}/chat-header-${width}-start.png`, clip: { x: 0, y: 0, width, height: 220 } })
    }

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(400)
    const desk = await measure()
    console.log(JSON.stringify(desk))
    check('desktop: the row does not scroll', desk.scrollable <= 0, `${desk.scrollable}px`)
} catch (err) {
    check('drive finished', false, err.message.slice(0, 300))
} finally {
    await browser.close()
}
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exitCode = 1
