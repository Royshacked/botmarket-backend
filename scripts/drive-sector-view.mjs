// DRIVE THE ACTUAL BOARD — Pythia's published view, in a real browser, against real stored rows.
//
// Same reason drive-mentor-ui.mjs exists: the FE tests mock the service layer, so nothing else
// exercises Mongo -> controller -> panel as ONE path. When the stance row changed shape
// (`sector` -> `grain`/`bucket`/`proxy`) that seam is exactly where a green suite and a blank
// board can coexist — the tests render fixtures the tests themselves wrote.
//
//   node scripts/drive-sector-view.mjs [baseUrl] [outDir]
//
// Needs the committed bundle served by a running server, so BUILD FIRST. Creates its own
// throwaway user on demand; the Forecasts tab is a read, so no admin role is required.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:3030'
const OUT  = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

// Every script in here needs the DNS pin to reach Atlas.
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

await ensureUser()

const browser = await chromium.launch()
const page    = await browser.newPage({ viewport: { width: 1440, height: 950 } })
const errors  = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
// A bare "401" in the console names nothing. Record which call it was.
page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`) })

try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })

    await page.waitForTimeout(1500)
    // Log in. Positional, exactly as drive-mentor-ui does it — the form has no stable labels.
    if (await page.locator('input').first().count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(4000)
    }

    // Radar -> Forecasts is where SectorView renders the published view. Both are plain buttons
    // in the right column; log what is on screen when one cannot be found, because a silent
    // timeout here looks identical to a panel that rendered nothing.
    const names = async () => (await page.$$eval('button', bs => bs.map(b => b.textContent.trim()).filter(Boolean)))
    for (const label of ['Forecasts']) {
        const btn = page.locator('button', { hasText: label }).first()
        if (await btn.count()) { await btn.click(); await page.waitForTimeout(1200); continue }
        console.log('! no button matching', label, '— visible:', (await names()).slice(0, 60).join(' | '))
    }
    await page.waitForTimeout(2000)

    await page.screenshot({ path: `${OUT}/ui-sector-view.png`, fullPage: false })
    console.log('shot: ui-sector-view.png')

    // What the board actually says, read back out of the DOM — a screenshot nobody opens proves
    // nothing, and these are the three fields the row shape changed.
    const rows = await page.$$eval('.sector-view__row', els => els.map(el => ({
        bucket: el.querySelector('.sector-view__bucket')?.childNodes[0]?.textContent?.trim() ?? null,
        grain:  el.querySelector('.sector-view__grain')?.textContent?.trim() ?? 'sector',
        proxy:  el.querySelector('.sector-view__proxy')?.textContent?.trim() ?? null,
        stance: el.querySelector('[class*="sector-view__stance--"]')?.textContent?.trim() ?? null,
        bp:     el.querySelector('.sector-view__bp')?.textContent?.trim() ?? null,
    })))

    console.log(`\nrows rendered: ${rows.length}`)
    for (const r of rows) {
        console.log(`  ${String(r.bucket).padEnd(26)} ${String(r.grain).padEnd(7)} ${String(r.proxy).padEnd(6)} ${String(r.stance).padEnd(10)} ${r.bp}`)
    }

    const blank = rows.filter(r => !r.bucket)
    if (!rows.length)   console.log('\n! NO ROWS — the board is empty (no published view, or the tab did not open)')
    else if (blank.length) console.log(`\n✗ ${blank.length} row(s) rendered with NO BUCKET — the panel is reading a field the server no longer sends`)
    else                console.log('\n✓ every row rendered a bucket')

    if (errors.length) {
        console.log('\nconsole errors:')
        for (const e of errors.slice(0, 8)) console.log('   ', e.slice(0, 160))
    }
} finally {
    await browser.close()
}
process.exit(0)
