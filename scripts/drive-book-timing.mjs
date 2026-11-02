/* global document, window -- page.evaluate bodies run in the browser */
// DRIVE: ARGUS'S TIMING READ ON SWING / LONG TERM, AND NO "ASK ARGUS" ANYWHERE (Roy, 2026-11-02: "can it be automatic —
// part of the run?"; "the table — all users see the same"; "remove button ask argus from all of them").
//
//   node scripts/drive-book-timing.mjs [baseUrl] [outDir]   (default http://localhost:5173 — the Vite dev server)
//
// Against the dev backend (restarted, so /api/hotlist/book carries `timing`). Two passes, one sign-in as `ui-smoke`:
// a desktop as the admin, then a 390-px phone with /api/auth/me answered as a TRADER (the panel's view only) — the same
// table for every user. Proves: the Timing column on Swing with Now / Wait cells and their hover, a row's page carries
// Argus's line, Covered companies has no column, and no "Ask Argus" on Swing, This week or a row's page.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const browser = await chromium.launch()
const errors = []
let session = null

/** The book table as the reader sees it: headers, each row's symbol and Timing cell (text + hover), page width overflow. */
const table = (page) => page.evaluate(() => {
    const t = document.querySelector('.hot-panel table.hot-table--book')
    const heads = [...(t?.querySelectorAll('thead th') ?? [])].map(th => th.textContent.trim())
    const at = heads.indexOf('Timing')
    const rows = [...(t?.querySelectorAll('tbody tr') ?? [])].map(tr => {
        const td = at >= 0 ? tr.children[at] : null
        return { symbol: tr.dataset.symbol, text: td?.textContent.trim() ?? null, title: td?.title || td?.querySelector('[title]')?.title || '' }
    })
    return { heads, rows, over: document.documentElement.scrollWidth - window.innerWidth }
})
const askArgus = (page) => page.getByText('Ask Argus', { exact: true }).count()

async function pass({ phone }) {
    const who = phone ? 'phone · trader' : 'desktop · admin'
    const ctx = await browser.newContext({
        ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1600, height: 900 } }),
        ...(session ? { storageState: session } : {}),
    })
    const page = await ctx.newPage()
    page.on('pageerror', e => errors.push(`${who}: ${e.message.slice(0, 200)}`))
    if (phone) {
        await page.route('**/api/auth/me', async route => {
            const res = await route.fetch()
            const me = await res.json().catch(() => null)
            return route.fulfill({ response: res, body: JSON.stringify(me ? { ...me, role: 'trader', isAdmin: false } : me) })
        })
    }
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
    session = await ctx.storageState()
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline').waitFor({ timeout: 20000 })

    if (phone) {
        await page.getByRole('button', { name: 'Open menu' }).click()
        await page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: 'Hotlist' }).click()
    } else {
        await page.locator('.floor-desk__head', { hasText: 'Hotlist' }).first().click()
    }
    await page.waitForSelector('.hot-panel', { timeout: 60000 })

    // This week first: no Ask Argus on its rows.
    await page.waitForTimeout(1500)
    check(`${who}: no "Ask Argus" on This week`, await askArgus(page) === 0)

    await page.locator('.hot-panel').getByRole('button', { name: /^Swing/ }).click()
    await page.waitForSelector('.hot-panel table.hot-table--book tbody tr', { timeout: 60000 })
    const t = await table(page)
    const read = t.rows.filter(r => ['Now', 'Wait'].includes(r.text))
    check(`${who}: Swing has a Timing column`, t.heads.includes('Timing'), t.heads.join(' | '))
    check(`${who}: Swing rows show Now / Wait`, read.length > 0,
        `${read.length} of ${t.rows.length} read (${read.filter(r => r.text === 'Now').length} now, ${read.filter(r => r.text === 'Wait').length} wait)`)
    const wait = read.find(r => r.text === 'Wait')
    check(`${who}: a Wait says what for, on hover`, Boolean(wait && /Wait for .+/.test(wait.title)), wait ? `${wait.symbol}: ${wait.title.slice(0, 140)}` : 'no Wait row')
    check(`${who}: no sideways scroll`, t.over <= 1, `${t.over}px`)
    check(`${who}: no "Ask Argus" on Swing`, await askArgus(page) === 0)
    await page.screenshot({ path: `${OUT}/book-timing-${phone ? 'phone' : 'desktop'}-1-swing.png` })

    // A timed row's page carries Argus's line.
    const sym = (wait ?? read[0])?.symbol
    if (sym) {
        await page.locator(`.hot-panel tr[data-symbol="${sym}"]`).getByRole('button', { name: `Details for ${sym}` }).click()
        await page.waitForSelector('.hot-page', { timeout: 10000 })
        const line = await page.locator('.hot-detail__line', { hasText: 'Argus · timing' }).first().textContent().catch(() => '')
        check(`${who}: ${sym}'s page carries Argus's timing line`, /Argus · timing \(week of \d{4}-\d{2}-\d{2}\):\s*(Now\.|Wait — for )/.test(line), line.slice(0, 160))
        check(`${who}: no "Ask Argus" on the row's page`, await askArgus(page) === 0)
        await page.screenshot({ path: `${OUT}/book-timing-${phone ? 'phone' : 'desktop'}-2-page.png` })
        await page.getByRole('button', { name: /Back/ }).first().click()
        await page.waitForTimeout(800)
    }

    await page.locator('.hot-panel').getByRole('button', { name: /^Covered companies/ }).click()
    await page.waitForTimeout(1200)
    check(`${who}: Covered companies has no Timing column`, !(await table(page)).heads.includes('Timing'))
    await ctx.close()
}

try {
    await pass({ phone: false })
    await pass({ phone: true })
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
} finally {
    if (errors.length) check('no page errors', false, errors.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
}
