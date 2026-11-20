// DRIVE THE SCREEN — the build in the background (docs/design/modes-and-builders.md steps 5a + 5b): answer the trader's
// card → the chat goes back to General by itself, the pane says the trader is building, the chat's status line says it;
// Axl answers a question at once meanwhile, and knows how the build is going; the build ends READY (announced, never saved
// on its own) or comes back needing the user. Desktop screenshots.
//
//   node scripts/drive-lanes.mjs [baseUrl] [outDir] [TICKER]     (default http://localhost:5173 · . · AMD)
//
// As the throwaway QA user `ui-smoke` (paper). One login per run (the auth limiter). Runs a real trader build.
/* global document -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const TICKER = (process.argv[4] ?? 'AMD').toUpperCase()
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/build-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const strip = (page) => page.evaluate(() => document.querySelector('.side-pane__build-status')?.innerText ?? null)

// The three numbers (2026-11-20: each its own question). Last time's option stays when it is there.
async function answerNumbers(page) {
    const q = (h) => page.locator('.question-card__q', { has: page.locator('.question-card__chip', { hasText: h }) })
    const picked = async (h) => (await q(h).locator('.question-card__option[aria-checked="true"]').count()) > 0
    if (!(await picked('Size'))) await page.getByLabel('Size: other').fill('$10,000')
    if (!(await picked('Risk'))) await q('Risk').locator('.question-card__option', { hasText: '1% of the account' }).click()
    await q('Min R:R').locator('.question-card__option', { hasText: /^1\.5$/ }).click()
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

async function askAxl(text, re, ms = 120_000) {
    const box = page.locator('.chat-timeline textarea')
    const t = Date.now()
    await box.fill(text)
    await box.press('Enter')
    const key = text.slice(-24)
    const ok = await page.waitForFunction(([k, src]) => {
        const after = document.querySelector('.chat-timeline')?.innerText.split(k)[1] ?? ''
        return new RegExp(src, 'i').test(after) && !document.querySelector('.chat-timeline__row--live')
    }, [key, re.source], { timeout: ms }).then(() => true).catch(() => false)
    const after = ((await page.locator('.chat-timeline').innerText()).split(key)[1] ?? '').replace(/\s+/g, ' ')
    return { ok, secs: Math.round((Date.now() - t) / 1000), after }
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
    expect(await page.locator('.mode-picker__toggle').count() > 0, 'signed in (the auth limiter let us in)')
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    await page.locator('.mode-picker__toggle').click()
    await page.locator('.mode-picker__option', { hasText: 'Trader' }).click()
    await page.waitForSelector('.question-card', { timeout: 30_000 })
    await page.getByLabel('Name: other').fill(TICKER)
    const acct = page.locator('.question-card__q', { hasText: 'Account' }).locator('.question-card__option').first()
    if ((await acct.getAttribute('aria-checked')) !== 'true') await acct.click()
    await answerNumbers(page)
    await page.locator('.question-card__q', { hasText: 'If it breaks' }).locator('.question-card__option', { hasText: 'Redraw it' }).click()
    await page.locator('.question-card__q', { hasText: 'Surprises' }).locator('.question-card__option', { hasText: 'Decide for me' }).click()
    await page.locator('.question-card__submit').click()

    const general = await page.waitForFunction(() => document.querySelector('.mode-picker__toggle')?.getAttribute('aria-label') === 'Mode: General', null, { timeout: 30_000 }).then(() => true).catch(() => false)
    expect(general, 'the chat went back to General by itself')
    const building = await page.waitForFunction(() => /is building/.test(document.querySelector('.side-pane__build-status')?.innerText ?? ''), null, { timeout: 30_000 }).then(() => true).catch(() => false)
    expect(building, `the pane says it: "${await strip(page)}"`)
    const line = await page.evaluate(() => document.querySelector('.chat-timeline__row--behind')?.innerText ?? null)
    expect(/building .* in the background/i.test(line ?? ''), `the chat's status line: "${line}"`)
    await shot(page, '01-building')

    const q1 = await askAxl('Quick one — is the US market open right now?', /\b(open|closed)\b/)
    expect(q1.ok, `Axl answered in ${q1.secs}s while the trader builds`)
    console.log('   ', q1.after.slice(0, 200))
    const q2 = await askAxl(`How is the ${TICKER} trade going?`, /(build|background|ready|working|needs)/)
    expect(q2.ok, `Axl knows the build (${q2.secs}s)`)
    console.log('   ', q2.after.slice(0, 260))
    await shot(page, '02-axl-meanwhile')

    // The end of the build: ready (announced) or back to the user.
    const end = await page.waitForFunction(() => /is ready|has a question|did not finish/.test(document.querySelector('.side-pane__build-status')?.innerText ?? ''), null, { timeout: 600_000 })
        .then(() => true).catch(() => false)
    const final = await strip(page)
    expect(end, `the build ended: "${final}"`)
    if (/has a question/.test(final ?? '')) {
        // Step 8: the build pauses on a card above the prompt box; the chat stays with Axl.
        expect(await page.locator('.question-card').count() > 0, "the build's question is on a card above the prompt box")
        const mode = await page.locator('.mode-picker__toggle').getAttribute('aria-label')
        expect(mode === 'Mode: General', `the chat stays with Axl (${mode})`)
    }
    if (/is ready/.test(final ?? '')) {
        const toast = await page.evaluate(() => document.body.innerText.includes('is ready — review it in the pane'))
        expect(toast, 'a ready build is announced')
        const mode = await page.locator('.mode-picker__toggle').getAttribute('aria-label')
        expect(mode === 'Mode: General', `ready, the chat is still with Axl (${mode})`)
        expect(await page.locator('.side-pane button', { hasText: /generate/i }).first().isEnabled().catch(() => false), 'Generate is on in the pane')
    }
    await shot(page, '03-end')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
