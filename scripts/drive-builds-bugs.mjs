// DRIVE THE SCREEN — Roy's five build bugs (2026-11-20):
//   2. "how is NVDA for the long term?" → Axl answers from the analyst's coverage — no route, no card, no "update?"
//   3. a build at work is said under the prompt box, not at the end of the thread
//   4. a desk's message behind a build's step says what it waits for (not just "sending…")
//   5. saving the trade while the analyst's build is queued KEEPS the session (the analyst's build survives)
//   (1 — New session clears the saved line — is the unit test's: the line only follows a save that ends the session.)
//
//   node scripts/drive-builds-bugs.mjs [baseUrl] [outDir]     (default http://localhost:5173 · .)
//
// As the throwaway QA user `ui-smoke-panel` (paper). One login. Runs real Axl, trader and analyst turns (~15 min on Luna).
/* global document, window -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke-panel', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/bugs-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const settle = async (page, quietMs = 6000, maxMs = 240_000) => {
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
    const box = page.locator('.chat-timeline textarea')

    // ── 2. A view on a covered name is Axl's read ──
    console.log('2. the analyst\'s view')
    await box.fill('how is NVDA for the long term now?')
    await box.press('Enter')
    await page.waitForSelector('.chat-timeline__row--live', { timeout: 30_000 }).catch(() => {})
    await settle(page)
    const said = (await page.locator('.chat-timeline__thread').innerText()).replace(/\s+/g, ' ')
    const reply = said.slice(said.lastIndexOf('long term now?') + 14)
    console.log('  reply:', reply.slice(0, 500))
    expect(!(await page.locator('.question-card').count()), 'no question card')
    expect(await page.locator('.mode-picker__toggle').getAttribute('aria-label') === 'Mode: General', 'still General — no route to research')
    expect(/rat(ed|ing)|target|buy|hold|sell/i.test(reply), "the answer carries the analyst's rating / target")
    expect(!/update (the|its|NVDA)|would you like me to update/i.test(reply), 'no "update it?"')
    await shot(page, '2-view')

    // ── A trader build from the Hotlist ──
    console.log('the trader build')
    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForSelector('.hot-horizons', { timeout: 150000 })
    await page.waitForTimeout(1000)
    let sym = null
    for (const tab of ['Swing', 'Long term', 'This week']) {
        await page.locator('.hot-horizons button', { hasText: tab }).first().click()
        await page.waitForTimeout(800)
        const rows = page.locator('.hot-panel tr.hot-row')
        const n = Math.min(await rows.count(), 6)
        for (let i = 0; i < n && !sym; i++) {
            const s = await rows.nth(i).getAttribute('data-symbol')
            if (s === 'NVDA') continue
            await rows.nth(i).locator('td').nth(3).click()
            await page.waitForSelector('.hot-page', { timeout: 5000 }).catch(() => {})
            const btn = page.locator('.hot-page .floor-queued__btn')
            if (await btn.count()) { sym = s; await btn.first().click() }
            else await page.getByRole('button', { name: '‹ Back to the list' }).click().catch(() => {})
        }
        if (sym) break
    }
    if (!sym) throw new Error('no buildable row')
    await page.waitForSelector('.question-card', { timeout: 120_000 })
    const q = (h) => page.locator('.question-card__q', { has: page.locator('.question-card__chip', { hasText: h }) })
    const acct = q('Account').locator('.question-card__option').first()
    if (await acct.count() && (await acct.getAttribute('aria-checked')) !== 'true') await acct.click()
    if (!(await q('Size').locator('.question-card__option[aria-checked="true"]').count())) await page.getByLabel('Size: other').fill('$10,000')
    if (!(await q('Risk').locator('.question-card__option[aria-checked="true"]').count())) await q('Risk').locator('.question-card__option', { hasText: '1% of the account' }).click()
    await q('Min R:R').locator('.question-card__option', { hasText: /^1\.5$/ }).click()
    await q('If it breaks').locator('.question-card__option', { hasText: 'Redraw it' }).click()
    await q('Surprises').locator('.question-card__option', { hasText: 'Decide for me' }).click()
    await page.locator('.question-card__submit').click()
    console.log(`  ${sym}: answered`)

    // ── 3. The build at work, under the prompt box ──
    console.log('3. the building line')
    const behind = await page.waitForSelector('.chat-timeline__behind', { timeout: 60_000 }).then(() => true).catch(() => false)
    expect(behind, 'the build is said under the prompt box')
    if (behind) console.log('  line:', await page.locator('.chat-timeline__behind').innerText())
    const thread = await page.locator('.chat-timeline__thread').innerText()
    expect(!/is building .* in the background/.test(thread), 'not at the end of the thread')
    const geo = await page.evaluate(() => {
        const b = document.querySelector('.chat-input-row')?.getBoundingClientRect()
        const s = document.querySelector('.chat-timeline__behind-text')?.getBoundingClientRect()
        return b && s ? { below: s.top >= b.bottom - 1, right: Math.abs(s.right - b.right) < 30, onScreen: s.bottom <= window.innerHeight } : null
    })
    expect(geo?.below && geo?.right && geo?.onScreen, `under the box, on its right, on screen (${JSON.stringify(geo)})`)
    await shot(page, '3-building')

    // ── 4. The analyst, while the trader builds ──
    console.log('4. a message behind the build')
    await page.locator('.mode-picker__toggle').click()
    await page.locator('.mode-picker__option', { hasText: 'Analyst' }).click()
    // Landed, not just picked: the switch is pending until the server's floor arrives.
    await page.waitForFunction(() => { const t = document.querySelector('.mode-picker__toggle'); return /Analyst/.test(t?.getAttribute('aria-label') ?? '') && !t.classList.contains('is-pending') }, null, { timeout: 30_000 })
    await page.waitForTimeout(1000)
    await box.fill('Cover AMD for the long term.')
    await box.press('Enter')
    let label = null
    for (let i = 0; i < 40 && !label; i++) {
        const t = await page.evaluate(() => document.querySelector('.chat-timeline__row--live')?.innerText ?? '')
        if (/waiting for the trader's build step/.test(t)) label = t.replace(/\s+/g, ' ')
        await page.waitForTimeout(500)
    }
    console.log('  live status:', label)
    expect(!!label, "the message says it waits for the trader's build step")
    await shot(page, '4-queued')

    // ── 5. Save the trade while the analyst's build is in the session (queued, building, or asking its card) ──
    console.log('5. save while the analyst builds')
    const t0 = Date.now()
    let barText = ''
    while (Date.now() - t0 < 1_200_000) {
        barText = await page.evaluate((s) => [...document.querySelectorAll('.build-bar')].map(b => b.innerText).find(t => t.includes(s)) ?? '', sym)
        if (barText) break
        await page.waitForTimeout(5000)
    }
    console.log('  trader bar:', barText.replace(/\s+/g, ' '))
    const analystThere = async () => page.evaluate(() => /analyst|coverage/i.test([...document.querySelectorAll('.build-bar, .chat-timeline__behind, .question-card__role')].map(b => b.innerText).join(' ')))
    if (/Watch summary/.test(barText)) {
        console.log('  analyst build in the session before the save:', await analystThere())
        const sessionBefore = await page.evaluate(() => document.querySelector('.chat-timeline__thread')?.innerText.length ?? 0)
        await page.locator('.build-bar', { hasText: sym }).locator('.build-bar__btn', { hasText: 'Watch summary' }).click()
        await page.waitForSelector('.build-summary', { timeout: 10_000 })
        await page.locator('.build-summary__btn--primary').click()
        await page.waitForTimeout(6000)
        const ended = await page.locator('.chat-timeline__empty').count()
        expect(!ended, 'the session was kept (no fresh "back with Axl" start)')
        const after = await page.evaluate(() => document.querySelector('.chat-timeline__thread')?.innerText ?? '')
        expect(after.length >= sessionBefore * 0.5 && /how is NVDA/i.test(after), 'the conversation is still there')
        expect(await analystThere(), "the analyst's build is still there")
        await shot(page, '5-saved')
    } else {
        expect(false, `the trader's build was not ready to save (${barText.slice(0, 120) || 'no bar'})`)
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
