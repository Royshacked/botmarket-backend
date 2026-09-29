// DRIVE THE ACTUAL SCREEN — the Mentor build flow, end to end, in a real browser.
//
// The FE tests mock the service layer, so nothing else exercises server -> controller -> panel as
// ONE path, and that seam is exactly where the gate defects lived: a card that never hid, both
// cards vanishing because the controller dropped the `gate` field, a pick that never settled.
// Every one of them had green tests. So: build the bundle, run this, and LOOK at the screenshots.
//
//   node scripts/drive-mentor-ui.mjs [baseUrl] [outDir]
//
// It needs a server the bundle is served from (the committed public/ bundle, so rebuild first)
// and it creates the throwaway user on demand. Headless Chromium comes from playwright, already a
// dependency of klineRender.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:3030'
const OUT  = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

// Every script in here needs the DNS pin to reach Atlas; the server itself skips it under
// NODE_ENV=production, which reads like a Mongo outage if you run one locally without this.
dns.setServers(['8.8.8.8', '1.1.1.1'])

async function ensureUser() {
    const { userService } = await import('../api/user/user.service.js')
    const { closeDb } = await import('../providers/mongodb.provider.js')
    try {
        const u = await userService.createUser(USER)
        console.log('qa user: created', u?.username ?? u?.id)
    } catch (err) {
        console.log('qa user: already there —', err.message)
    }
    await closeDb()
}

const shot = async (page, name) => {
    await page.screenshot({ path: `${OUT}/ui-${name}.png`, fullPage: false })
    console.log('  shot:', name)
}

await ensureUser()

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

try {
    // ── sign in ──────────────────────────────────────────────────────────────
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    console.log('title:', await page.title())

    if (await page.locator('input').first().count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await shot(page, '01-login')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3000)
    }
    await shot(page, '02-after-login')

    // ── into Mentor ──────────────────────────────────────────────────────────
    await page.getByText('Build your idea', { exact: false }).first().click()
    await page.waitForTimeout(2500)
    await shot(page, '03-mentor-open')

    // The composer, by its own placeholder — the panel also carries hidden inputs.
    const box = page.getByPlaceholder(/A ticker, a direction and a horizon/i)
    await box.click()
    await box.fill('I want to build a swing trade on NVDA')
    await box.press('Enter')
    console.log('sent the opening turn — waiting for the desk…')

    // The opening turn reads a dozen tools; give it room.
    await page.waitForTimeout(90000)
    await shot(page, '04-opening-reply')
    const t1 = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    console.log('CONFIRM CARD PRESENT:', /Yes — carry on/.test(t1))
    console.log('reply tail:', t1.slice(-400))

    // ── press the confirm, which should settle and move to the spans gate ────
    const yes = page.getByRole('button', { name: /Yes — carry on/ })
    if (!(await yes.count())) {
        // A RESUMED thread starts past the opening — that is state, not a defect. Clear the
        // thread (or use a fresh user) if you meant to drive the opening turn.
        console.log('no confirm card — the thread resumed past the opening stage')
    } else {
        await yes.first().click()
        console.log('pressed "Yes — carry on" — waiting for the spans gate…')
        await page.waitForTimeout(120000)
        await shot(page, '05-spans-gate')
        const t2 = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
        console.log('SPANS GATE PRESENT:', /ways? this goes/.test(t2))
        console.log('CHECKBOXES:', await page.locator('input[type="checkbox"]').count())
        console.log('BUILD BUTTON:', await page.getByRole('button', { name: /Build it|Build these/ }).count())
        console.log('screen tail:', t2.slice(-500))
    }
} catch (err) {
    console.log('DRIVE FAILED:', err.message)
    await shot(page, 'zz-failure').catch(() => {})
} finally {
    if (errors.length) console.log('CONSOLE ERRORS:\n  ' + errors.slice(0, 6).join('\n  '))
    await browser.close()
}
process.exit(0)
