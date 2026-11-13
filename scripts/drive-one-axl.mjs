// DRIVE THE SCREEN — One Axl (docs/design/one-axl.md, steps 1+2): the chat shows ONE assistant. Ask how a stock behaves
// (Axl routes to the technical analyst), then an off-desk question (the technical analyst hands it back, silently, and
// Axl answers or routes it). Every speaker must read "Axl", the role under it; no internal agent name anywhere on screen;
// no empty bubble from the silent hand-back. Desktop + 390px screenshots to LOOK at, not just the asserts.
//
//   node scripts/drive-one-axl.mjs [baseUrl] [outDir] [TICKER]     (default http://localhost:5173 · . · NVDA)
//
// As the throwaway QA user `ui-smoke` (drive-mentor-ui.mjs creates it). One login per run: drives share the developer's IP
// for the auth limiter.
/* global document, window -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const TICKER = (process.argv[4] ?? 'NVDA').toUpperCase()
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
const NAMES = /\b(Mentor|Prometheus|Atlas|Argus|Proteus|Pythia|Aether|Talos|Themis|Daedalus)\b/
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/one-axl-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const speakers = (page) => page.evaluate(() => [...document.querySelectorAll('.chat-timeline__speaker')].map(t => ({
    name: t.querySelector('.chat-timeline__speaker-name')?.textContent ?? null,
    role: t.querySelector('.chat-timeline__speaker-role')?.textContent ?? null,
})))
const assistantRows = (page) => page.evaluate(() => document.querySelectorAll('.chat-timeline__row--assistant, .chat-timeline__row:not(.chat-timeline__row--user)').length)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
page.on('console', m => { if (m.type() === 'error') errors.push(`console ${m.text().slice(0, 200)}`) })

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
    // A clean session, so the screen holds only this drive's turns.
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }
    await shot(page, '01-home')

    const box = page.locator('.chat-timeline textarea')
    await box.fill(`How does ${TICKER} behave?`)
    await box.press('Enter')
    const answered = await page.waitForFunction(() => {
        const roles = [...document.querySelectorAll('.chat-timeline__speaker-role')].map(n => n.textContent)
        const t = document.querySelector('.chat-timeline')?.innerText ?? ''
        return roles.includes('Technical analyst') && /ATR|false/i.test(t) && !document.querySelector('.chat-timeline__row--live')
    }, null, { timeout: 240_000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(3000)
    expect(answered, 'the technical analyst answered, as Axl')
    let sp = await speakers(page)
    console.log('  speakers:', JSON.stringify(sp))
    expect(sp.length > 0 && sp.every(s => s.name === 'Axl'), 'every speaker reads "Axl"')
    expect(sp.some(s => s.role === 'Technical analyst'), 'the role "Technical analyst" under the name')
    const title = await page.locator('.chat-timeline__title').innerText()
    expect(/Talking with Axl · Technical analyst/.test(title), `header: "${title.replace(/\s+/g, ' ')}"`)
    await shot(page, '02-desktop-behaviour')

    const before = await assistantRows(page)
    await box.fill(`what's in the news on ${TICKER} today?`)
    await box.press('Enter')
    // The hand-back is silent: wait for the turn chain to settle (no live row) and a NEW answer to land.
    const settled = await page.waitForFunction((n) => {
        const rows = document.querySelectorAll('.chat-timeline__row--assistant, .chat-timeline__row:not(.chat-timeline__row--user)').length
        return rows > n && !document.querySelector('.chat-timeline__row--live')
    }, before, { timeout: 240_000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(6000)
    expect(settled, 'the off-desk question got an answer')
    sp = await speakers(page)
    console.log('  speakers after:', JSON.stringify(sp))
    expect(sp.every(s => s.name === 'Axl'), 'still only "Axl" speaking')
    const empties = await page.evaluate(() => [...document.querySelectorAll('.chat-bubble, .chat-timeline__row .chat-bubble__text')].filter(b => !b.innerText.trim()).length)
    expect(empties === 0, `no empty bubble from the silent hand-back (${empties})`)
    const text = await page.locator('.chat-timeline').innerText()
    console.log('  timeline tail:', text.replace(/\s+/g, ' ').slice(-900))
    const hit = text.match(NAMES)
    expect(!hit, `no internal agent name on screen${hit ? ` — found "${hit[1]}"` : ''}`)
    expect(!/<route>|<open>|<ticker>/.test(text), 'no raw tags in the chat')
    await shot(page, '03-desktop-handback')

    expect(await page.evaluate(() => [...document.querySelectorAll('.chat-timeline__row--user')]
        .filter(r => /news on/i.test(r.innerText)).length) === 1, 'the off-desk question shows ONCE (its hand-back opening is not drawn)')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(1500)
    await shot(page, '04-phone')
    // Info lives over the chat on a phone (the desktop has the Floor's Info column instead).
    await page.getByRole('button', { name: 'Info' }).click()
    await page.waitForTimeout(800)
    const info = await page.locator('.chat-info').innerText()
    expect(!NAMES.test(info), 'Info names no agent')
    await shot(page, '05-phone-info')
    await page.locator('.chat-info').getByRole('button', { name: 'Close' }).click()
    await page.waitForTimeout(500)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    expect(!overflow, 'no sideways scroll at 390px')
    const body = await page.evaluate(() => document.body.innerText)
    const anyHit = body.match(NAMES)
    expect(!anyHit, `no internal name anywhere on the page${anyHit ? ` — found "${anyHit[1]}"` : ''}`)
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
