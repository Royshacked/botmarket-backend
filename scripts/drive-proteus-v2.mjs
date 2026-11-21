// DRIVE THE SCREEN — Proteus v2's VERSION 2 (docs/design/proteus-v2.md §5b, 2026-11-21) and the phone's prompt box:
//   1. Hotlist rows (This week = the short term swing, Swing, Long term): a "Bottom line" and a "Risk" line, no
//      "against holding"
//   2. Axl on KO's technical read: the bottom line and the normal pullback
//   3. Mentor, a KO swing, then "I want 3:1": what the ratio costs inside the horizon, beside the target that fits
//   4. a 390px phone: the opening screen's box in the middle; the docked box off the bottom edge
//
//   node scripts/drive-proteus-v2.mjs [baseUrl] [outDir]     (default http://localhost:5173 · .)
//
// As the throwaway QA user `ui-smoke-panel` (paper). One login. Real Axl + trader turns (minutes on Luna).
/* global document -- the page.evaluate bodies run in the browser */
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke-panel', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])

let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch())
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/pv2-${name}.png` }); console.log('  shot:', name) }

/** Wait until no row is live for `quiet` ms (the turn and any read it set off). */
async function settle(max = 420_000, quiet = 20_000) {
    const t0 = Date.now()
    let since = Date.now()
    while (Date.now() - t0 < max && Date.now() - since < quiet) {
        const live = await page.evaluate(() => !!document.querySelector('.chat-timeline__row--live') || /thinking…|Pulling|reading|Measuring/i.test(document.querySelector('.chat-timeline__messages')?.innerText.slice(-200) ?? ''))
        if (live) since = Date.now()
        await page.waitForTimeout(1500)
    }
}
const thread = async () => (await page.locator('.chat-timeline').innerText()).replace(/\s+/g, ' ')
async function ask(text) {
    const box = page.locator('.chat-timeline textarea')
    await box.fill(text)
    await box.press('Enter')
    await page.waitForTimeout(3000)
    await settle()
    const t = await thread()
    const at = t.lastIndexOf(text)
    return at >= 0 ? t.slice(at + text.length) : t.slice(-2500)
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
    await page.waitForTimeout(1000)
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    // ── 1. the Hotlist rows ────────────────────────────────────────────────────────────────────────────────────────
    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForSelector('.hot-horizons', { timeout: 150_000 })
    await page.waitForTimeout(1000)
    console.log('  tabs:', (await page.locator('.hot-horizons button').allInnerTexts()).map(s => s.replace(/\s+/g, ' ').trim()).join(' · '))
    for (const tab of [/week/i, /swing/i, /long term/i]) {
        const b = page.locator('.hot-horizons button', { hasText: tab }).first()
        if (!(await b.count())) { console.log(`1. ${tab}: no tab`); continue }
        await b.click()
        await page.waitForTimeout(1200)
        const row = page.locator('.hot-panel tr.hot-row').first()
        if (!(await row.count())) { console.log(`1. ${tab}: no rows`); continue }
        const sym = await row.getAttribute('data-symbol')
        await row.locator('td').nth(3).click()
        await page.waitForSelector('.hot-page', { timeout: 5000 })
        await page.waitForSelector('.hot-profile__lines', { timeout: 60_000 }).catch(() => {})
        await page.waitForTimeout(1000)
        const lines = await page.locator('.hot-profile').innerText().catch(() => '')
        console.log(`1. ${tab} — ${sym}:\n${lines.split('\n').filter(Boolean).map(l => `    | ${l}`).join('\n')}`)
        expect(/Bottom line/.test(lines) && /(Leans up|Leans down|Mixed|No clear lean)/.test(lines), `${sym}: a bottom line`)
        expect(/Risk/.test(lines) && /A normal (pullback|bounce)[^\n]*~\d+%/.test(lines), `${sym}: a risk line in %`)
        expect(!/holding/i.test(lines), `${sym}: no "against holding"`)
        await page.locator('.hot-page').screenshot({ path: `${OUT}/pv2-row-${String(tab).replace(/\W/g, '')}.png` })
        await page.getByRole('button', { name: '‹ Back to the list' }).click()
        await page.waitForTimeout(800)
    }
    // A fresh page for the chat — the Hotlist must not cover the trader's card (the first run's failure).
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    expect(!(await page.locator('.hot-horizons').count()), 'the Hotlist is closed for the chat')

    // ── 2. Axl on KO ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log('2. Axl — KO\'s technical read')
    const a = await ask('How does KO trade technically — what is a normal pullback on it?')
    console.log('  →', a.slice(0, 1400))
    expect(/pullback/i.test(a) && /\d+(\.\d+)?%/.test(a), 'Axl says the normal pullback, in %')
    expect(!/(trading|it) beat holding|holding did better/i.test(a), 'no "against holding"')
    await shot('02-axl')

    // ── 3. Mentor, 3:1 ────────────────────────────────────────────────────────────────────────────────────────────
    console.log('3. Mentor — a KO swing, then 3:1')
    const box = page.locator('.chat-timeline textarea')
    await box.fill("I'd like to build a swing trade on KO.")
    await box.press('Enter')
    const card = await page.waitForSelector('.question-card', { timeout: 240_000 }).then(() => true).catch(() => false)
    expect(card, 'the trader\'s question card')
    if (card) {
        await page.waitForTimeout(1500)
        await page.locator('.question-card__option', { hasText: 'KO' }).first().click().catch(() => {})
        const acct = page.locator('.question-card__q', { hasText: 'Account' }).locator('.question-card__option').first()
        if (await acct.count()) { if ((await acct.getAttribute('aria-checked')) !== 'true') await acct.click() }
        const q = (h) => page.locator('.question-card__q', { has: page.locator('.question-card__chip', { hasText: h }) })
        const picked = async (h) => (await q(h).locator('.question-card__option[aria-checked="true"]').count()) > 0
        if (!(await picked('Size'))) await page.getByLabel('Size: other').fill('$10,000').catch(() => {})
        if (!(await picked('Risk'))) await q('Risk').locator('.question-card__option', { hasText: '1% of the account' }).click().catch(() => {})
        const rr3 = q('Min R:R').locator('.question-card__option', { hasText: /^3$/ })
        if (await rr3.count()) await rr3.click(); else await q('Min R:R').locator('.question-card__option').last().click().catch(() => {})
        await q('If it breaks').locator('.question-card__option', { hasText: 'Redraw it' }).click().catch(() => {})
        // Step by step, so the build stops for the user rather than arming on its own.
        const sur = q('Surprises').locator('.question-card__option', { hasText: /ask me|step/i }).first()
        if (await sur.count()) await sur.click(); else await q('Surprises').locator('.question-card__option').first().click().catch(() => {})
        await shot('03a-card')
        // Every question answered → Build it; else (a question this drive does not know) typed in the chat, as the card offers.
        const submit = page.locator('.question-card__submit')
        if (await submit.isEnabled().catch(() => false)) {
            await submit.click()
            await page.waitForTimeout(3000)
            await settle(600_000, 25_000)
        } else {
            console.log('  (the card is not complete — answering in the chat)')
            const r = await ask('KO, long, swing, on the paper account: size $10,000, risk 1% of the account, both scenarios, redraw if it breaks, and ask me before anything the answers do not settle.')
            console.log('  →', r.slice(0, 800))
        }
        await shot('03b-trader')
        const m = await ask('I want 3:1 on this — where do the stop and the target go?')
        console.log('  →', m.slice(0, 1800))
        expect(/3:1|3 : 1|three to one/i.test(m) && /\d+(\.\d+)?%/.test(m), 'Mentor answers the 3:1 with levels in %')
        expect(/fits|within|finish|horizon|less often|rarely|longer/i.test(m), 'he says what 3:1 costs inside a swing')
        expect(!/KO'?s (best )?(ratio|horizon)|this name'?s (ratio|horizon)/i.test(m), 'never calls a ratio or horizon the name\'s')
        await shot('03c-three-to-one')
    }

    // ── 4. the phone ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('4. phone, 390px')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(1500)
    const docked = await page.locator('.chat-input-row').first().boundingBox()
    if (docked) expect(844 - (docked.y + docked.height) >= 12, `the docked box ${Math.round(844 - (docked.y + docked.height))}px off the bottom`)
    await shot('04a-phone-docked')
    const fresh2 = page.getByRole('button', { name: 'New session' })
    if (await fresh2.isEnabled().catch(() => false)) {
        await fresh2.click(); await page.waitForTimeout(2500)
        const open = await page.locator('.chat-input-row').first().boundingBox()
        if (open) expect(844 - (open.y + open.height) >= 150, `the opening box ${Math.round(844 - (open.y + open.height))}px off the bottom (toward the middle)`)
        await shot('04b-phone-opening')
    } else console.log('  – New session not reachable on the phone layout; opening screen not checked')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
