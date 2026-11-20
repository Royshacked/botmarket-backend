/* global document, window -- page.evaluate bodies run in the browser */
// SUPERSEDED 2026-11-20 (docs/design/modes-and-builders.md): Axl no longer ROUTES to the event analyst — he asks it as a
// subagent, and the forward test it drives was retired with the pipeline. Drive scripts/drive-subagents.mjs and
// scripts/drive-echo-background.mjs instead; kept for its history.
// Drive ECHO's DESK (docs/design/echo-desk.md step 4) in the browser: Axl routes "GTA 6 is out" to the event analyst, who
// maps it (one real map — a few cents — saved to the QA user's events and deleted at the end); then the Hotlist's Echo
// tab hands a forward-test event over with "Ask about this event".
//
//   AETHER_DB=test node scripts/drive-echo-desk.mjs [outDir]
//
// /api/hotlist/echo* is answered IN THIS PROCESS from the engine's db (prod's forward test, read only). The chat is the
// real backend's. Signs in as `ui-smoke`. LOOK at the screenshots.
import dns from 'node:dns'
import 'dotenv/config'
import { chromium } from 'playwright'
import { echoService } from '../services/echo.service.js'
import { getDb } from '../providers/mongodb.provider.js'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const [OUT = '.'] = process.argv.slice(2)
const started = new Date().toISOString()
const BASE = 'http://localhost:5173'
const Q = 'GTA 6 is out — which companies does it reach through the supply chain?'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
let failed = false
const expect = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); if (!ok) failed = true }
const list = await echoService.listEvents()
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
page.on('console', m => { if (m.type() === 'error') errors.push(`console ${m.text().slice(0, 200)}`) })
await page.route('**/api/hotlist/echo**', async route => {
    const id = new URL(route.request().url()).pathname.match(/\/echo\/([^/]+)$/)?.[1]
    const body = id ? await echoService.getEvent(decodeURIComponent(id)) : list
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
})
try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username); await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter'); await page.waitForTimeout(3500)
    }
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    // A NEW session: an earlier answer in the history would let the desk repeat it instead of mapping.
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2500) }
    const box = page.locator('.chat-timeline textarea')
    await box.fill(Q)
    await box.press('Enter')
    const answered = await page.waitForFunction((q) => {
        const all = document.querySelector('.chat-timeline')?.innerText ?? ''
        const t = all.slice(all.lastIndexOf(q))
        return /event analyst/i.test(t) && /(AMD|SONY|Sony|Microsoft|MSFT)/.test(t) && /forward test/i.test(t)
    }, Q, { timeout: 300_000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(4000)
    const all = await page.locator('.chat-timeline').innerText()
    const text = all.slice(all.lastIndexOf(Q))
    expect(answered, 'Axl routed to the event analyst, who mapped GTA 6 and said it is not the forward test')
    console.log('  tail:', text.replace(/\s+/g, ' ').slice(-900))
    expect(!/<route>|<open>|<ticker>/.test(text), 'no raw tags in the chat')
    expect(!/\b(Echo|Proteus|Prometheus|Mentor|Argus)\b/.test(text.replace(/Echo · test/g, '')), 'no internal desk names in the chat (one voice)')
    await page.screenshot({ path: `${OUT}/desk-01-gta-desktop.png` })
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/desk-02-gta-phone.png` })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    expect(!overflow, 'no sideways scroll at 390px')
    await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(1000)

    // The Hotlist's Echo tab → "Ask about this event"
    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForSelector('.hot-horizons', { timeout: 45000 })
    await page.locator('.hot-horizons button', { hasText: 'Echo · test' }).click()
    await page.locator('.echo tbody tr', { hasText: 'CSCO' }).first().click()
    await page.getByRole('button', { name: 'Ask about this event' }).click({ timeout: 15000 })
    const handed = await page.waitForFunction(() => /Walk me through the CSCO event of 2026-11-12 \(csco-earnings-2026-11-12\)/.test(document.querySelector('.chat-timeline')?.innerText ?? ''), null, { timeout: 20000 }).then(() => true).catch(() => false)
    expect(handed, 'the event went to the chat as the user\'s question')
    await page.waitForTimeout(3000)
    await page.screenshot({ path: `${OUT}/desk-03-handoff.png` })
} catch (err) { console.error('drive error:', err.message); failed = true }
finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    const del = await (await getDb()).collection('echo_user_events').deleteMany({ createdAt: { $gte: started } })
    console.log('cleaned', del.deletedCount, 'drive event(s)')
    if (!del.deletedCount) { console.log('FAIL  no map was saved — the desk answered without mapping'); failed = true }
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
