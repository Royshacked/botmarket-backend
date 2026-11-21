// DRIVE THE SCREEN — Axl, one voice (docs/design/axl-one-voice.md, Roy 2026-11-21):
//   1. "is NVDA a good investment now?" → Axl answers himself (no specialist row, no card, still General), from the house's
//      work: the withdrawn target said as withdrawn
//   2. "what's wrong with NVDA?" → the news (printed)
//   3. "how are semis doing?" → the house's industry work + news (printed)
//   4. "how are my trades doing?" → the monitors' view (printed)
//   5. a name with NO coverage → answered now, "the analyst is building it"; the "ready" line lands in the chat (≤15 min)
//   6. "let's revise nvda" → a background build: the building line, still General (never confirmed — it would overwrite
//      the house thesis)
//
//   node scripts/drive-one-voice.mjs [baseUrl] [outDir] [uncoveredTicker]     (default http://localhost:5173 · . · SOFI)
//
// As the throwaway QA user `ui-smoke-panel` (paper). One login. Real turns; step 5 starts a REAL analyst run, and its
// coverage is the house's after (that is the design: built once, for everyone).
/* global document */
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const NEW = (process.argv[4] ?? 'SOFI').toUpperCase()
const USER = { username: 'ui-smoke-panel', password: 'Sm0ke!Drive#29' }

let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const settle = async (page, quietMs = 8000, maxMs = 300_000) => {
    const t0 = Date.now(); let quiet = Date.now()
    while (Date.now() - t0 < maxMs && Date.now() - quiet < quietMs) {
        if (await page.locator('.chat-timeline__row--live').count()) quiet = Date.now()
        await page.waitForTimeout(1000)
    }
}

const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

const thread = async () => (await page.locator('.chat-timeline__thread').innerText()).replace(/\s+/g, ' ')
// Ask, wait, and return what came after the question on screen.
async function ask(q) {
    const box = page.locator('.chat-timeline textarea')
    await box.fill(q)
    await box.press('Enter')
    await page.waitForSelector('.chat-timeline__row--live', { timeout: 30_000 }).catch(() => {})
    await settle(page)
    const t = await thread()
    const at = t.toLowerCase().lastIndexOf(q.toLowerCase())
    return at >= 0 ? t.slice(at + q.length) : t.slice(-1500)
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
    await page.getByRole('button', { name: /^paper$/i }).first().click().catch(() => {})
    await page.waitForTimeout(1500)
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }
    const toggle = page.locator('.mode-picker__toggle')
    const general = async () => (await toggle.getAttribute('aria-label')) === 'Mode: General'
    if (!(await general())) {
        await toggle.click()
        await page.locator('.mode-picker__option', { hasText: 'General' }).click()
        await page.waitForFunction(() => { const t = document.querySelector('.mode-picker__toggle'); return t?.getAttribute('aria-label') === 'Mode: General' && !t.classList.contains('is-pending') }, null, { timeout: 30_000 })
    }

    console.log('1. a view on a covered name')
    const r1 = await ask('is nvda a good investment now?')
    console.log('  →', r1.slice(0, 1200))
    expect(!/\b(Analyst|Technical analyst|Event analyst)\b/.test(r1.slice(0, 40)), 'Axl answered himself — no specialist row')
    expect(!(await page.locator('.question-card').count()) && await general(), 'no card, still General')
    expect(/withdr|could ?n.t (stand|defend)|no (current|standing) (target|rating)|not stand/i.test(r1), 'the withdrawn target is said as withdrawn')
    await page.screenshot({ path: `${OUT}/one-voice-1.png` })

    console.log("2. what's wrong — the news")
    console.log('  →', (await ask("what's wrong with nvda today?")).slice(0, 700))

    console.log('3. an industry')
    const r3 = await ask('how are semiconductors doing?')
    console.log('  →', r3.slice(0, 900))
    expect(/semi/i.test(r3), 'an answer about semis')

    console.log('4. my trades — the monitors')
    console.log('  →', (await ask('how are my trades doing?')).slice(0, 900))

    console.log(`5. ${NEW}, not covered`)
    const r5 = await ask(`is ${NEW} a good investment?`)
    console.log('  →', r5.slice(0, 900))
    expect(/build|working on|being (built|researched)|in the background|coverage.*(coming|soon)/i.test(r5), 'says the analyst is building coverage')
    const t0 = Date.now(); let ready = null
    while (Date.now() - t0 < 900_000 && !ready) {
        const m = (await thread()).match(new RegExp(`The analyst's coverage on ${NEW} is ready[^.]*\\.|The analyst could not build coverage on ${NEW}[^.]*\\.`))
        if (m) ready = m[0]
        else await page.waitForTimeout(10_000)
    }
    console.log('  line:', ready)
    expect(!!ready && /is ready/.test(ready), 'the "ready" line landed in the chat')
    await page.screenshot({ path: `${OUT}/one-voice-5.png` })

    console.log('6. a revision runs as a build')
    await page.locator('.chat-timeline textarea').fill("let's revise nvda")
    await page.locator('.chat-timeline textarea').press('Enter')
    const line = await page.waitForSelector('.chat-timeline__behind', { timeout: 90_000 }).then(() => page.locator('.chat-timeline__behind').innerText()).catch(() => null)
    console.log('  line:', line)
    // Revising coverage is ADMIN-only (entityLookup): the QA user is refused — said as a skip, never as a pass.
    if (!line && /not yours to change here/.test(await thread())) console.log('  – skipped: this user is not an admin, and revising coverage is admin-only')
    else expect(/Analyst · building NVDA revision/.test(line ?? ''), 'the building line says the analyst is revising NVDA')
    expect(await general(), 'the chat stays with Axl (General)')
    await page.screenshot({ path: `${OUT}/one-voice-6.png` })
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
