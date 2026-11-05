// BACK FROM A SETUP GOES TO THE LIST (Roy, 2026-11-05: on a phone, back from a setup opened in Your trades went to the chat). A phone
// viewport in a browser: the menu, Your trades, a row, its page, then back, by the gesture and by the page's own button.
// No model turn, one sign-in. The setup is removed. Against the Vite dev server (:5173); axl_dev only.
//
//   node scripts/drive-phone-trades-back.mjs [baseUrl] [outDir]
import dns from 'dns'
import 'dotenv/config'
import { chromium, devices } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])
if (process.env.DB_NAME !== 'axl_dev') throw new Error(`refusing to run against ${process.env.DB_NAME} — axl_dev only`)

const { getDb, closeDb } = await import('../providers/mongodb.provider.js')

const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

const db = await getDb()
const entities = db.collection('entities')
const userId = (await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } }))?.id
if (!userId) throw new Error('no ui-smoke user')
const ID = `setup_DRIVEBACK_${Date.now()}`
const plan = { asset: 'AAPL', direction: 'long', type: 'swing', trade_mode: 'thesis', timeframe: 'day',
    scenarios: [{ id: 's1', entry_legs: [{ price: 330, quantity: 10 }], stop_legs: [{ price: 320 }], target_legs: [{ price: 360, quantity: 10 }], quantity: 10 }],
    entry_legs: [{ price: 330, quantity: 10 }], stop_legs: [{ price: 320 }], target_legs: [{ price: 360, quantity: 10 }], quantity: 10 }
await entities.insertOne({ ...plan, id: ID, kind: 'setup', userId, parentId: null, status: 'waiting', savedAt: Date.now(), mode: 'paper', broker: 'paper',
    accounts: [`drive-${ID}`], mainAccountId: `drive-${ID}`, chat_state: { draft: plan, coverage: [] }, monitor_state: { scenarios: {}, guards: [] } })

const browser = await chromium.launch()
const context = await browser.newContext({ ...devices['Pixel 7'] })
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message.slice(0, 200)))

const row = page.locator('.floor-row', { hasText: 'AAPL' }).first()
const detail = page.locator('.entity-detail')
const listOnScreen = () => row.isVisible().catch(() => false)
const settle = () => page.waitForTimeout(900)
const openList = async () => {
    await page.locator('[class*="burger"]').first().click()
    await page.locator('.app-header-axl__list', { hasText: 'Your trades' }).click()
    await row.waitFor({ timeout: 15000 })
}
const openRow = async () => { await row.click(); await detail.waitFor({ timeout: 10000 }); await settle() }

try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
    }
    await page.locator('.chat-timeline').waitFor({ timeout: 20000 })
    await page.waitForTimeout(2500)

    await openList()
    await openRow()
    await page.screenshot({ path: `${OUT}/phone-page.png` })
    const top = await page.evaluate(() => { const r = document.querySelector('.entity-detail'); const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2); return !!r?.contains(hit) })
    check('the page is on top of the list', top)
    check('the url names the setup', page.url().includes('setup='), page.url())

    await page.goBack()
    await settle()
    await page.screenshot({ path: `${OUT}/phone-after-back.png` })
    check('back closes the page', await detail.count() === 0)
    check('back lands on Your trades', await listOnScreen())

    await openRow()
    await page.locator('.idea-page__back').first().click()
    await settle()
    check('the page\'s own back button lands on Your trades', await detail.count() === 0 && await listOnScreen())

    await page.goBack()
    await settle()
    await page.screenshot({ path: `${OUT}/phone-after-second-back.png` })
    check('the next back leaves the list, for the chat', !(await listOnScreen()) && await page.locator('.chat-timeline').isVisible())
    check('nothing threw', errors.length === 0, errors.join(' | '))
} catch (err) {
    check('the drive finished', false, err.message.slice(0, 240))
    await page.screenshot({ path: `${OUT}/phone-failed.png` }).catch(() => {})
} finally {
    await browser.close()
    await entities.deleteOne({ id: ID })
    await closeDb?.().catch?.(() => {})
}
const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
