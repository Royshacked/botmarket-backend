/* global document, getComputedStyle, requestAnimationFrame, window -- page.evaluate bodies run in the browser */
// DRIVE: THE DETAIL WINDOW'S ONE MOTION, IN AND OUT (Roy, 2026-11-02: the Positions window's small animation "on every
// mounting or unmounting of the detail window" — "and do not duplicate").
//
//   node scripts/drive-detail-window-motion.mjs [baseUrl] [outDir]   (default http://localhost:5173 — Vite)
//
// As `ui-smoke`, one sign-in: a desktop (docked over the chat), then the same page at a phone's width (full page).
// For Positions, the Calendar and the Hotlist: opening plays detail-panel-in on the window; closing leaves an inert
// copy playing detail-panel-out that is gone a moment later; Positions' book no longer plays its own.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message.slice(0, 200)))

/** The windows on screen: the open one's animation, a leaving copy's, and the book's own inside Positions. */
const motion = () => page.evaluate(() => {
    const open = document.querySelector('.detail-panel[role="dialog"]')
    const copy = document.querySelector('.detail-panel--leaving')
    const book = open?.querySelector('.floor-left__scroll')
    return {
        open: open ? getComputedStyle(open).animationName : null,
        mode: open ? (open.className.includes('--docked') ? 'docked' : 'page') : null,
        leaving: copy ? getComputedStyle(copy).animationName : null,
        inert: copy ? copy.hasAttribute('inert') : null,
        book: book ? getComputedStyle(book).animationName : null,
    }
})

/**
 * Records every frame from now: whether a window is on screen, and its opacity — a blink is a frame with no window
 * before the way out ends, or an opacity that goes back UP (Roy, 2026-11-02: "a double blink before settling").
 */
const recordFrames = () => page.evaluate(() => {
    window.__frames = []
    const step = () => {
        const el = document.querySelector('.detail-panel')
        window.__frames.push(el ? Number(getComputedStyle(el).opacity) : null)
        if (window.__frames.length < 40) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
})
/** The recorded frames → { gapBeforeEnd, rises, frames } — a gap: a missing window followed by a window again. */
const framesSeen = async () => {
    await page.waitForTimeout(900)
    const f = await page.evaluate(() => window.__frames)
    const firstGone = f.indexOf(null)
    const gapBeforeEnd = firstGone >= 0 && f.slice(firstGone).some(v => v != null)
    const seen = f.filter(v => v != null)
    const rises = seen.filter((v, i) => i > 0 && v > seen[i - 1] + 0.02).length
    return { gapBeforeEnd, rises, frames: f.map(v => (v == null ? '·' : v.toFixed(2))).join(' ') }
}

async function openList(label, phone) {
    if (phone) {
        await page.getByRole('button', { name: 'Open menu' }).click()
        await page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: label }).click()
    } else {
        await page.locator('.floor-desk__head', { hasText: label }).first().click()
    }
    await page.waitForSelector('.detail-panel[role="dialog"]', { timeout: 30000 })
}

async function round(label, phone) {
    const who = `${phone ? 'phone' : 'desktop'} · ${label}`
    await openList(label, phone)
    const m = await motion()
    check(`${who}: opens with detail-panel-in (${m.mode})`, m.open === 'detail-panel-in' && m.mode === (phone ? 'page' : 'docked'), JSON.stringify(m))
    if (label === 'Positions') check(`${who}: the book plays nothing of its own`, m.book === 'none', String(m.book))
    await page.waitForTimeout(400)
    await recordFrames()
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click()
    const out = await motion()
    check(`${who}: closing leaves an inert copy playing detail-panel-out`, out.open === null && out.leaving === 'detail-panel-out' && out.inert === true, JSON.stringify(out))
    const fr = await framesSeen()
    check(`${who}: the way out is one fade — no empty frame, no flash back up`, !fr.gapBeforeEnd && fr.rises === 0, fr.frames)
    check(`${who}: the copy is gone a moment later`, (await motion()).leaving === null)
}

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
    for (const label of ['Positions', 'Calendar', 'Hotlist']) await round(label, false)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(800)
    for (const label of ['Positions', 'Calendar', 'Hotlist']) await round(label, true)
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
    await page.screenshot({ path: `${OUT}/detail-motion-error.png` }).catch(() => {})
} finally {
    if (errors.length) check('no page errors', false, errors.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
}
