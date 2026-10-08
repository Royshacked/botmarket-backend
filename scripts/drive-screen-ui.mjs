// DRIVE THE ACTUAL SCREEN — Pythia's weekly industry screen ("Trade now" on the Forecasts tab), in a
// real browser (docs/design/industry-screener.md, step 6).
//
//   node scripts/drive-screen-ui.mjs [baseUrl] [outDir] [--live-route]
//
// As a TRADER (a throwaway user, deleted at the end): the Forecasts tab opens on Trade now — regime,
// buckets, verdict chips — then one row expanded, a search, and the switch to Structure.
//
// By default GET /api/strategy/screen is answered from the REAL latest industry_screen document in this
// app's database, so a dev backend started before the route existed can still be driven; the route is
// covered by tests/unit/industryScreen.test.js. `--live-route` sends it to the backend instead. LOOK at
// the screenshots.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const LIVE = args.includes('--live-route')
const [BASE = 'http://localhost:5173', OUT = '.'] = args.filter(a => !a.startsWith('--'))
const USER = { username: 'ui-smoke-screen', fullname: 'UI Smoke', password: 'Sm0ke!Drive#31' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { userService } = await import('../api/user/user.service.js')

const shot = async (page, name) => {
    await page.screenshot({ path: `${OUT}/scr-${name}.png`, fullPage: false })
    console.log('  shot:', name)
}

async function signIn(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    const inputs = page.locator('input')
    if (await inputs.count()) {
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
}

const db = await getDb()
const latest = await db.collection('industry_screen').find({}, { projection: { _id: 0 } }).sort({ asof: -1 }).limit(1).next()
console.log(latest ? `screen ${latest.asof}: ${latest.rows.length} rows, counts ${JSON.stringify(latest.counts)}` : 'NO SCREEN in this database')

try { await userService.createUser(USER); console.log('qa user created') } catch (e) { console.log('qa user exists —', e.message) }
await db.collection('users').updateOne({ username: USER.username }, { $set: { role: 'trader' } })

const browser = await chromium.launch({ channel: 'msedge' })
const errors = []
try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
    if (!LIVE) {
        await page.route('**/api/strategy/screen', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(latest ?? null) }))
    }
    await signIn(page)

    await page.getByRole('button', { name: /Forecasts/ }).first().click()
    await page.waitForTimeout(3000)
    await shot(page, '01-trade-now')
    const tradeOn = await page.getByRole('tab', { name: 'Trade now', selected: true }).count()
    const headings = await page.locator('.screen-view__bucket').allInnerTexts()
    const rows = await page.locator('.screen-view .industry-view__row').count()
    const chips = await page.locator('.screen-view__trade').allInnerTexts()
    const regime = await page.locator('.screen-view__regime').innerText().catch(() => '(no regime line)')
    console.log(`trade-now selected: ${tradeOn === 1}; ${rows} rows; buckets: ${headings.join(' | ')}`)
    console.log(`regime: ${regime}`)
    console.log(`chips: ${JSON.stringify(chips.reduce((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {}))}`)

    await page.locator('.screen-view .industry-view__line').first().click()
    await page.waitForTimeout(800)
    await shot(page, '02-top-row-open')
    console.log('open row detail:', (await page.locator('.industry-view__row--open .industry-view__detail').innerText()).slice(0, 600).replace(/\n+/g, ' | '))

    await page.getByLabel('Find an industry').fill('steel')
    await page.waitForTimeout(500)
    await shot(page, '03-search-steel')
    console.log('after search "steel":', await page.locator('.screen-view .industry-view__row').count(), 'rows')

    await page.getByRole('tab', { name: 'Structure' }).click()
    await page.waitForTimeout(800)
    await shot(page, '04-structure')
    console.log('structure rows:', await page.locator('.industry-view__row').count())
    await ctx.close()
} finally {
    await browser.close()
    const u = await db.collection('users').findOne({ username: USER.username })
    if (u) {
        await db.collection('token_usage').deleteMany({ userId: u.id })
        await db.collection('users').deleteOne({ _id: u._id })
        console.log('qa user removed')
    }
    await closeDb()
    if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '))
}
