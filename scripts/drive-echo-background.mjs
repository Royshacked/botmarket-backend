// DRIVE THE SCREEN — the event analyst maps in the BACKGROUND (docs/design/modes-and-builders.md step 2): a new event
// asked in the chat → Axl's turn ends at once and the status line says the event analyst is mapping → a question asked
// meanwhile is answered → the map arrives under "Axl · Event analyst" and the line goes. Desktop screenshots.
//
//   node scripts/drive-echo-background.mjs [baseUrl] [outDir]     (default http://localhost:5173 · .)
//
// As the throwaway QA user `ui-smoke`. One login per run (the auth limiter). It maps a REAL event on the dev database.
/* global document -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/echo-bg-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const idle = (page, ms) => page.waitForFunction(() => !document.querySelector('.chat-timeline__row--live'), null, { timeout: ms }).then(() => true).catch(() => false)

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
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    const box = page.locator('.chat-timeline textarea')
    const t0 = Date.now()
    await box.fill('A scenario, not news: if TSMC had to halt its Arizona fabs for six months starting today, who would that reach through the supply chain? Map it as a scenario.')
    await box.press('Enter')
    await page.waitForTimeout(4000)
    expect(await idle(page, 120_000), 'the turn ended without waiting for the map')
    const firstTurn = Math.round((Date.now() - t0) / 1000)
    console.log(`  first turn done at ${firstTurn}s`)
    await page.waitForTimeout(1500)
    const line = await page.evaluate(() => document.querySelector('.chat-timeline')?.innerText.match(/The event analyst is mapping[^\n]*/)?.[0] ?? null)
    console.log('  status line:', line)
    expect(!!line, 'the status line says the event analyst is mapping')
    await shot(page, '01-mapping')

    await box.fill('meanwhile — is the market open now?')
    await box.press('Enter')
    await page.waitForTimeout(3000)
    expect(await idle(page, 120_000), 'a question asked while it maps is answered')
    const stillMapping = await page.evaluate(() => /The event analyst is mapping/.test(document.querySelector('.chat-timeline')?.innerText ?? ''))
    console.log(`  answered at ${Math.round((Date.now() - t0) / 1000)}s; still mapping: ${stillMapping}`)
    await shot(page, '02-meanwhile')

    const landed = await page.waitForFunction(() => {
        const t = document.querySelector('.chat-timeline')?.innerText ?? ''
        return !/The event analyst is mapping/.test(t) && !document.querySelector('.chat-timeline__row--live')
    }, null, { timeout: 480_000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(3000)
    console.log(`  map landed at ${Math.round((Date.now() - t0) / 1000)}s`)
    expect(landed, 'the status line went when the map landed')
    const roles = await page.evaluate(() => [...document.querySelectorAll('.chat-timeline__speaker-role')].map(n => n.textContent))
    console.log('  roles:', JSON.stringify(roles))
    expect(roles.filter(r => r === 'Event analyst').length >= 1, 'the map arrived under "Axl · Event analyst"')
    const text = await page.locator('.chat-timeline').innerText()
    expect(!/App note|get_event_map|ev_[0-9a-f]{8}/.test(text), "the app's opening and ids are not drawn")
    console.log('  timeline tail:', text.replace(/\s+/g, ' ').slice(-700))
    await shot(page, '03-landed')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
