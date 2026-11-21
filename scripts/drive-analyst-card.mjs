// DRIVE THE SCREEN — the analyst's question card (docs/design/modes-and-builders.md §4.2b; Roy, 2026-11-21: "when
// choosing analyst mode — open the questions window like in trader and portfolio; the user clicks a name; if the name
// exists the user decides whether to update; after send we are back in Axl's chat, without remnants"):
//   1. picking Analyst opens the card; "update it?" is not there until a COVERED name is typed (KO); a name not covered
//      (argv, default DIS) shows none
//   2. KO + "Leave it as is" → back to General, nothing of the card in the chat, nothing building
//   3. Analyst again, DIS → back to General, nothing of the card in the chat, the DIS coverage building in the background
//
//   node scripts/drive-analyst-card.mjs [baseUrl] [outDir] [covered] [notCovered]     (default http://localhost:5173 · . · KO · DIS)
//
// As the throwaway QA user `ui-smoke-panel` (paper). One login. Step 3 starts a real coverage build (the analyst's turns).
/* global document -- the page.evaluate bodies run in the browser */
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const COVERED = (process.argv[4] ?? 'KO').toUpperCase()
const FRESH = (process.argv[5] ?? 'DIS').toUpperCase()
const USER = { username: 'ui-smoke-panel', password: 'Sm0ke!Drive#29' }

let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }
const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch())
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/acard-${name}.png` }); console.log('  shot:', name) }
const chip = () => page.locator('.mode-picker__toggle').getAttribute('aria-label')
const waitChip = (label, ms = 20_000) => page.waitForFunction((l) => document.querySelector('.mode-picker__toggle')?.getAttribute('aria-label') === l && !document.querySelector('.mode-picker__toggle.is-pending'), label, { timeout: ms }).then(() => true).catch(() => false)
const thread = async () => (await page.locator('.chat-timeline__messages').innerText().catch(() => '')).replace(/\s+/g, ' ')

async function pickAnalyst() {
    await page.locator('.mode-picker__toggle').click()
    await page.locator('.mode-picker__option', { hasText: 'Analyst' }).click()
    return page.waitForSelector('.question-card', { timeout: 30_000 }).then(() => true).catch(() => false)
}
const updateShown = async () => (await page.locator('.question-card__q', { hasText: 'update the coverage' }).count()) > 0

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
    const fresh = page.getByRole('button', { name: 'New session' })
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2000) }

    console.log('1. Analyst mode → the card')
    expect(await pickAnalyst(), 'picking Analyst opens the question card')
    const box = page.getByLabel('Company: other')
    expect(!(await updateShown()), 'no "update it?" before a name')
    await box.fill(FRESH)
    await page.waitForTimeout(300)
    expect(!(await updateShown()), `${FRESH} (not covered): no "update it?"`)
    await box.fill(COVERED)
    await page.waitForTimeout(300)
    expect(await updateShown(), `${COVERED} (covered): "update it?" appears`)
    await shot('01-covered')

    console.log(`2. ${COVERED} — Leave it as is`)
    await page.locator('.question-card__option', { hasText: 'Leave it as is' }).click()
    await page.locator('.question-card__submit').click()
    expect(await page.waitForFunction(() => !document.querySelector('.question-card'), null, { timeout: 20_000 }).then(() => true).catch(() => false), 'the card goes')
    expect(await waitChip('Mode: General'), `back to General (${await chip()})`)
    await page.waitForTimeout(1500)
    let t = await thread()
    expect(!/Your answers|A few questions before I build it|Which company/.test(t), 'nothing of the card in the chat')
    expect(!/building/i.test(await page.locator('.chat-timeline').innerText()), 'nothing building')
    await shot('02-left-as-is')

    console.log(`3. Analyst again — ${FRESH}`)
    expect(await pickAnalyst(), 'the card again')
    await page.getByLabel('Company: other').fill(FRESH)
    await page.locator('.question-card__submit').click()
    expect(await page.waitForFunction(() => !document.querySelector('.question-card'), null, { timeout: 20_000 }).then(() => true).catch(() => false), 'the card goes')
    expect(await waitChip('Mode: General'), `back to General (${await chip()})`)
    await page.waitForTimeout(4000)
    t = await thread()
    expect(!/Your answers|A few questions before I build it|Which company/.test(t), 'nothing of the card in the chat')
    const whole = await page.locator('.chat-timeline').innerText()
    expect(new RegExp(`${FRESH} coverage`).test(whole) && /building|background/i.test(whole), `the ${FRESH} coverage builds in the background (said under the prompt box)`)
    await shot('03-building')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
