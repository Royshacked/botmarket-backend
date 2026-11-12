// DRIVE THE SCREEN — a chart, then ANOTHER chart (Roy, 2026-11-12: "show nvda daily chart", then "and spy daily" showed
// NVDA again — a reply that was only a chart was never saved, so the desk's next turn saw two asks in a row). In the real
// chat: reach Proteus through Axl, ask for one chart, then a different one, and check the second is the one asked for.
// Also: hand-off rows show only who passed to whom (no brief repeated under them).
//
//   node scripts/drive-chart-followup-ui.mjs [baseUrl] [outDir]      (default http://localhost:5173 · .)
//
// As the throwaway QA user `ui-smoke`. One login per run (the auth limiter shares the developer's IP).
/* global document */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/chart-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const timeline = (page) => page.locator('.chat-timeline').innerText().catch(() => '')
const waitText = (page, re, ms) => page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('.chat-timeline')?.innerText ?? ''), re.source, { timeout: ms }).then(() => true).catch(() => false)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

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
    await shot(page, '00-start')
    const box = page.locator('.chat-timeline textarea')
    await box.fill('How does NVDA behave technically? Does it respect any moving average?')
    await box.press('Enter')
    expect(await waitText(page, /PROTEUS[\s\S]+(measured|ATR)/, 240_000), 'Axl routed the technicals question to Proteus, and he answered')
    await page.waitForTimeout(3000)
    const handoffs = await page.locator('.chat-timeline__handoff').allInnerTexts()
    console.log('  hand-off rows:', JSON.stringify(handoffs))
    expect(handoffs.every(h => /^[^\n]+$/.test(h.trim()) && h.length < 40), 'hand-off rows show only who passed to whom')

    await box.fill('show nvda daily chart')
    await box.press('Enter')
    expect(await waitText(page, /NVDA daily chart|NVDA[\s\S]{0,40}chart/, 120_000), 'the NVDA chart')
    await page.waitForTimeout(4000)
    await shot(page, '01-nvda')

    await box.fill('and spy daily')
    await box.press('Enter')
    expect(await waitText(page, /SPY daily chart|SPY[\s\S]{0,40}chart/, 120_000), 'the SPY chart — the one asked for, not NVDA again')
    await page.waitForTimeout(4000)
    const tail = (await timeline(page)).replace(/\s+/g, ' ')
    console.log('  timeline tail:', tail.slice(-700))
    expect(tail.lastIndexOf('SPY') > tail.lastIndexOf('show nvda daily chart'), 'the last chart named is SPY')
    await shot(page, '02-spy')

    // Reload: both charts are still in the chat (they have rows now).
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(5000)
    const after = (await timeline(page)).replace(/\s+/g, ' ')
    expect(/NVDA daily chart/i.test(after) && /SPY daily chart/i.test(after), 'after a reload both chart rows are still there')
    await shot(page, '03-reloaded')
} catch (err) {
    failed = true
    console.log('  ✗ drive threw:', err.message)
} finally {
    console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'page errors: none')
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    await browser.close()
}
