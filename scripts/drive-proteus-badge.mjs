// DRIVE THE SCREEN — Proteus step 5 (docs/design/proteus.md §8.2): the Hotlist badge. Open the Hotlist on a horizon whose
// names are already profiled (Intraday: the day boards, profiled by step 4's queue), see the badges beside the tickers,
// click one, and watch the technical analyst's read land in the chat as Axl.
//
//   node scripts/drive-proteus-badge.mjs [baseUrl] [outDir] [tab]     (default http://localhost:5173 · . · Intraday)
//
// As the throwaway QA user `ui-smoke`. ONE login per run — drives share the developer's IP for the auth limiter. It does
// NOT open Swing or Long term: a first look there queues every unprofiled covered name (proteus.md step 5 note).
/* global document -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const TAB = process.argv[4] ?? 'Intraday'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/proteus-badge-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
const calls = []
page.on('request', r => { if (r.url().includes('/api/hotlist/behaviour')) calls.push(r.url()) })

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
    // A just-restarted backend can take a while to answer the sign-in: wait for the chat, not a fixed time.
    await page.locator('.chat-timeline textarea').first().waitFor({ timeout: 30_000 }).catch(() => {})
    if (!(await page.locator('.chat-timeline textarea').count())) { await shot(page, '00-not-signed-in'); throw new Error('not signed in — the auth limiter? wait 15 minutes') }
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForTimeout(2500)
    await page.getByRole('button', { name: new RegExp(`^${TAB}\\b`) }).first().click()
    const shown = await page.waitForFunction(() => document.querySelectorAll('.behaviour-badge').length > 0, null, { timeout: 30_000 }).then(() => true).catch(() => false)
    const badges = await page.evaluate(() => [...document.querySelectorAll('.hot-panel tr')].map(tr => {
        const sym = tr.querySelector('.hot-sym')?.textContent, b = tr.querySelector('.behaviour-badge')
        return sym ? [sym, b?.textContent ?? null, b?.getAttribute('title') ?? null] : null
    }).filter(Boolean))
    console.log('  rows:', JSON.stringify(badges.map(([s, b]) => [s, b])))
    console.log('  behaviour requests:', calls.length, calls.map(u => decodeURIComponent(u.split('?')[1] ?? '')).join(' | '))
    expect(shown, `badges beside the tickers on ${TAB}`)
    expect(calls.length === 1, 'ONE request for the whole tab')
    expect(badges.filter(([, b]) => b).every(([, , t]) => /Click for the read/.test(t ?? '')), 'each badge says what it measured, in its tooltip')
    await shot(page, '01-hotlist-badges')

    if (shown) {
        const sym = badges.find(([, b]) => b)?.[0]
        await page.locator('.behaviour-badge').first().click()
        const answered = await page.waitForFunction(() => {
            const roles = [...document.querySelectorAll('.chat-timeline__speaker-role')].map(n => n.textContent)
            return roles.includes('Technical analyst') && !document.querySelector('.chat-timeline__row--live')
        }, null, { timeout: 240_000 }).then(() => true).catch(() => false)
        await page.waitForTimeout(3000)
        const text = (await page.locator('.chat-timeline').innerText()).replace(/\s+/g, ' ')
        console.log('  chat tail:', text.slice(-500))
        expect(answered, `a click on ${sym}'s badge → the technical analyst answers, as Axl`)
        expect(text.includes(`How does ${sym} trade?`), 'the ask shows as the user\'s question')
        await shot(page, '02-the-read')
    }
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
