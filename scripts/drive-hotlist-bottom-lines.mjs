// DRIVE THE SCREEN — a Hotlist row's page in BOTTOM LINES, and "Chat about it" (Roy, 2026-11-21: "when I click a row of a
// name I get very long stories — I want bottom lines and a chat button if the user wants to chat about it and get the
// full info"):
//   1. Swing and Long term: a row's page is short (the tiles, one line each, the chart) — no thesis, no kill-criteria,
//      no full technical profile
//   2. "Chat about it" closes the Hotlist and asks Axl about the name; Axl answers with the full picture
//
//   node scripts/drive-hotlist-bottom-lines.mjs [baseUrl] [outDir]     (default http://localhost:5173 · .)
//
// As the throwaway QA user `ui-smoke-panel` (paper). One login. One real Axl turn.
/* global document */
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke-panel', password: 'Sm0ke!Drive#29' }
const MAX_PAGE = 1400   // characters of words on a page, tiles and lines included (the long pages were 2,500–5,000)

let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }

const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

// The words on the page, without the chart's own labels (OHLC, drawing tools).
const pageText = () => page.evaluate(() => {
    const p = document.querySelector('.hot-page')
    if (!p) return ''
    const c = p.cloneNode(true)
    c.querySelectorAll('.hot-page__chart').forEach(n => n.remove())
    return c.innerText
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
    await page.getByRole('button', { name: /^paper$/i }).first().click().catch(() => {})
    await page.waitForTimeout(1500)
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    const openHotlist = async () => {
        await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
        await page.waitForSelector('.hot-horizons', { timeout: 150_000 })
        await page.waitForTimeout(1000)
    }
    await openHotlist()

    let chatSym = null
    for (const tab of ['Swing', 'Long term']) {
        console.log(`1. ${tab}`)
        await page.locator('.hot-horizons button', { hasText: tab }).first().click()
        await page.waitForTimeout(1200)
        const row = page.locator('.hot-panel tr.hot-row').first()
        if (!(await row.count())) { console.log('  – no rows'); continue }
        const sym = await row.getAttribute('data-symbol')
        await row.locator('td').nth(3).click()
        await page.waitForSelector('.hot-page', { timeout: 5000 })
        await page.waitForSelector('.hot-profile__headline, .hot-profile__note:not(:has-text("Measuring"))', { timeout: 30_000 }).catch(() => {})
        await page.waitForTimeout(1500)
        const t = await pageText()
        console.log(`  ${sym}: ${t.length} characters\n${t.split('\n').filter(Boolean).map(l => `    | ${l}`).join('\n')}`)
        expect(t.length <= MAX_PAGE, `short — ${t.length} ≤ ${MAX_PAGE} characters`)
        expect(!/KILL-CRITERIA|CATALYSTS|revisions|From the weekly chain|Daily cycle|Weekly Wyckoff/i.test(t), 'no long blocks (kill-criteria, catalysts, the full profile)')
        expect(await page.getByRole('button', { name: 'Chat about it' }).count() === 1, 'a "Chat about it" button')
        await page.locator('.hot-page').screenshot({ path: `${OUT}/bottom-${tab.replace(' ', '')}.png` })
        chatSym = sym   // the page left open — its "Chat about it" is pressed next
        if (tab !== 'Long term') await page.getByRole('button', { name: '‹ Back to the list' }).click()
    }

    console.log(`2. Chat about it — ${chatSym}`)
    await page.getByRole('button', { name: 'Chat about it' }).click()
    await page.waitForTimeout(1500)
    expect(!(await page.locator('.hot-page').count()), 'the Hotlist closed')
    await page.waitForSelector('.chat-timeline__row--live', { timeout: 30_000 }).catch(() => {})
    const t0 = Date.now(); let quiet = Date.now()
    while (Date.now() - t0 < 300_000 && Date.now() - quiet < 8000) {
        if (await page.locator('.chat-timeline__row--live').count()) quiet = Date.now()
        await page.waitForTimeout(1000)
    }
    const thread = (await page.locator('.chat-timeline__thread').innerText()).replace(/\s+/g, ' ')
    const at = thread.indexOf('the full picture')
    const reply = at >= 0 ? thread.slice(at) : thread.slice(-1500)
    console.log('  →', reply.slice(0, 1600))
    expect(at >= 0, 'the question about the name is in the chat')
    expect(/target|rating|analyst|thesis/i.test(reply), "Axl's answer carries the house's view")
    await page.screenshot({ path: `${OUT}/bottom-chat.png` })
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
