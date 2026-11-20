// DRIVE THE SCREEN — Axl's subagents (docs/design/modes-and-builders.md step 1): the technical analyst and the event
// analyst answer INSIDE Axl's turn, as themselves ("Axl · Technical analyst"), and the floor stays with Axl — the next
// message ("show me the hotlist") is Axl's, not the role's (the ANT chat, Roy 2026-11-19). The user's question shows once;
// the role's hidden question never; the header never says "Talking with Axl · <role>". Desktop + 390px screenshots.
//
//   node scripts/drive-subagents.mjs [baseUrl] [outDir]     (default http://localhost:5173 · .)
//
// As the throwaway QA user `ui-smoke`. One login per run: drives share the developer's IP for the auth limiter.
/* global document, window -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/subagents-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const roles = (page) => page.evaluate(() => [...document.querySelectorAll('.chat-timeline__speaker-role')].map(n => n.textContent))
const settledAfter = (page, n) => page.waitForFunction((count) => {
    const rows = document.querySelectorAll('.chat-timeline__row:not(.chat-timeline__row--user)').length
    return rows > count && !document.querySelector('.chat-timeline__row--live')
}, n, { timeout: 300_000 }).then(() => true).catch(() => false)
const rowCount = (page) => page.evaluate(() => document.querySelectorAll('.chat-timeline__row:not(.chat-timeline__row--user)').length)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
page.on('console', m => { if (m.type() === 'error') errors.push(`console ${m.text().slice(0, 200)}`) })

async function ask(text) {
    const box = page.locator('.chat-timeline textarea')
    const before = await rowCount(page)
    await box.fill(text)
    await box.press('Enter')
    const ok = await settledAfter(page, before)
    await page.waitForTimeout(2500)
    return ok
}
const header = async () => (await page.locator('.chat-timeline__title').innerText()).replace(/\s+/g, ' ')

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
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    // 1. How a stock trades → the technical analyst answers, Axl keeps the floor.
    expect(await ask('How does NVDA behave technically?'), 'the behaviour question was answered')
    let r = await roles(page)
    console.log('  roles:', JSON.stringify(r))
    expect(r.includes('Technical analyst'), 'the answer is under "Axl · Technical analyst"')
    expect(!/Technical analyst/.test(await header()), `the header stays Axl's: "${await header()}"`)
    await shot(page, '01-technical')

    // 2. An event → the event analyst, the company named.
    expect(await ask("Anthropic's IPO (ticker ANT) — does it affect other companies through the supply chain?"), 'the event question was answered')
    r = await roles(page)
    console.log('  roles:', JSON.stringify(r))
    expect(r.includes('Event analyst'), 'the answer is under "Axl · Event analyst"')
    expect(!/Event analyst/.test(await header()), `the header stays Axl's: "${await header()}"`)
    await shot(page, '02-event')

    // 3. The ANT complaint: the next message is Axl's again.
    expect(await ask('show me the hotlist'), 'the hotlist ask was answered')
    const lastRole = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.chat-timeline__row:not(.chat-timeline__row--user)')]
        let role = null
        for (const row of rows) { const t = row.querySelector('.chat-timeline__speaker-role'); if (t) role = t.textContent; else if (row.querySelector('.chat-timeline__speaker')) role = '' }
        return role
    })
    const text = await page.locator('.chat-timeline').innerText()
    expect(!/Event analyst|Technical analyst/.test(lastRole ?? ''), `"show me the hotlist" answered by Axl himself (last speaker role: "${lastRole}")`)
    expect(/hotlist/i.test(text.slice(-600)), 'the reply is about the hotlist')
    await shot(page, '03-hotlist')

    // The user's questions show once; the roles' own (hidden) questions never.
    const userRows = await page.evaluate(() => [...document.querySelectorAll('.chat-timeline__row--user')].map(r => r.innerText.trim()))
    console.log('  user rows:', JSON.stringify(userRows))
    expect(userRows.length === 3, `three user rows, one per question (${userRows.length})`)
    expect(!/Companies:|What is already known/.test(text), "the role's composed question is not drawn")
    expect(!/<route>|<open>|ask_specialist/.test(text), 'no raw tags or tool names in the chat')
    console.log('  timeline tail:', text.replace(/\s+/g, ' ').slice(-900))

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(1500)
    await shot(page, '04-phone')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    expect(!overflow, 'no sideways scroll at 390px')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
