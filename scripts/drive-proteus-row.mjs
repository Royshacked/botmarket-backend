// DRIVE THE SCREEN — How it trades in an opened Hotlist row (docs/design/proteus.md §8.1 decision 4, 2026-11-13: the
// technical profile shows when a row is OPENED, instead of a badge). Open the Hotlist on a tab, open a row, see the
// technical analyst's measured profile on that horizon, and press "Ask the technical analyst" for his written read.
//
//   node scripts/drive-proteus-row.mjs [baseUrl] [outDir] [tab]     (default http://localhost:5173 · . · Intraday)
//
// As the throwaway QA user `ui-smoke`. ONE login per run — drives share the developer's IP for the auth limiter.
/* global document */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const TAB = process.argv[4] ?? 'Intraday'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
const NAMES = /\b(Mentor|Prometheus|Atlas|Argus|Proteus|Pythia|Aether|Talos|Themis)\b/
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/proteus-row-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
const calls = []
page.on('request', r => { if (r.url().includes('/api/hotlist/profile/') || r.url().includes('/api/hotlist/behaviour')) calls.push(r.url()) })

try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
    }
    // A just-restarted backend can take a while to answer the sign-in: wait for the chat, not a fixed time.
    await page.locator('.chat-timeline textarea').first().waitFor({ timeout: 30_000 }).catch(() => {})
    if (!(await page.locator('.chat-timeline textarea').count())) { await shot(page, '00-not-signed-in'); throw new Error('not signed in — the auth limiter? wait 15 minutes') }
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForTimeout(2500)
    await page.getByRole('button', { name: new RegExp(`^${TAB}\\b`) }).first().click()
    await page.waitForTimeout(2000)
    expect(await page.locator('.behaviour-badge').count() === 0, 'no badge on the rows any more')
    expect(calls.length === 0, 'the list itself asks for no profiles')

    const open = page.getByRole('button', { name: /^Details for / }).first()
    const sym = (await open.getAttribute('aria-label'))?.replace('Details for ', '')
    await open.click()
    const shown = await page.waitForFunction(() => document.querySelector('.hot-profile__lines'), null, { timeout: 60_000 }).then(() => true).catch(() => false)
    const lines = await page.evaluate(() => [...document.querySelectorAll('.hot-profile__lines > div')].map(d => [d.querySelector('dt')?.textContent, d.querySelector('dd')?.textContent]))
    const headline = await page.locator('.hot-profile__headline').textContent().catch(() => null)
    console.log(`  ${sym}: headline ${JSON.stringify(headline)}`)
    for (const [k, v] of lines) console.log(`    ${k}: ${v}`)
    console.log('  profile requests:', calls.map(u => decodeURIComponent(u.split('/api/hotlist/')[1] ?? '')).join(' | '))
    expect(shown, `opening ${sym} shows how it trades`)
    expect(calls.length === 1, 'one request, for the opened name')
    expect(lines.some(([k]) => k === 'What it obeys') && lines.some(([k]) => k === 'ATR'), 'what it obeys, and its ATR')
    const text = await page.locator('.hot-profile').innerText()
    expect(!NAMES.test(text), 'no internal agent name in the section')
    await shot(page, '01-row-profile')

    await page.getByRole('button', { name: 'Ask the technical analyst' }).click()
    const answered = await page.waitForFunction(() => {
        const roles = [...document.querySelectorAll('.chat-timeline__speaker-role')].map(n => n.textContent)
        return roles.includes('Technical analyst') && !document.querySelector('.chat-timeline__row--live')
    }, null, { timeout: 240_000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(3000)
    const chat = (await page.locator('.chat-timeline').innerText()).replace(/\s+/g, ' ')
    console.log('  chat tail:', chat.slice(-400))
    expect(answered, `"Ask the technical analyst" → his read on ${sym} in the chat, as Axl`)
    expect(chat.includes(`How does ${sym} trade?`), 'the ask shows as the user\'s question')
    await shot(page, '02-the-read')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
