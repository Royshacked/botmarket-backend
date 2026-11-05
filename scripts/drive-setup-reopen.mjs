// REOPENING A SETUP DOCKS NO CHART (Roy, 2026-11-05: "when chat opens it also opens a chart"). The pencil on a saved setup, in a
// browser: Mentor takes the floor, and the chatbox stays a chatbox. No model turn, one sign-in. The setup and the session
// are removed. Against the Vite dev server (:5173); axl_dev only.
//
//   node scripts/drive-setup-reopen.mjs [baseUrl] [outDir]
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])
if (process.env.DB_NAME !== 'axl_dev') throw new Error(`refusing to run against ${process.env.DB_NAME} — axl_dev only`)

const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')

const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

const db = await getDb()
const entities = db.collection('entities')
const userId = (await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } }))?.id
if (!userId) throw new Error('no ui-smoke user')
const account = (await db.collection('paper_accounts').findOne({ userId }))?.accountId ?? `drive-${Date.now()}`
const ID = `setup_DRIVEREOPEN_${Date.now()}`
const plan = { asset: 'AAPL', direction: 'long', type: 'swing', trade_mode: 'thesis', timeframe: 'day',
    scenarios: [{ id: 's1', entry_legs: [{ price: 330, quantity: 10 }], stop_legs: [{ price: 320 }], target_legs: [{ price: 360, quantity: 10 }], quantity: 10 }],
    entry_legs: [{ price: 330, quantity: 10 }], stop_legs: [{ price: 320 }], target_legs: [{ price: 360, quantity: 10 }], quantity: 10 }
await entities.insertOne({ ...plan, id: ID, kind: 'setup', userId, parentId: null, status: 'waiting', savedAt: Date.now(), mode: 'paper', broker: 'paper',
    accounts: [account], mainAccountId: account, chat_state: { draft: plan, coverage: [] }, monitor_state: { scenarios: {}, guards: [] } })
const { sessionId } = await sessionService.startNew({ userId, force: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(e.message.slice(0, 200)))
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
    check('no chart is docked before the press', await page.locator('.chat-chart-dock').count() === 0)

    const pencil = page.getByTitle('Edit setup in Mentor chat').first()
    await page.locator(':text("Your trades"):visible').first().click()
    const row = page.locator('.floor-row', { hasText: 'AAPL' }).first()
    await row.waitFor({ timeout: 15000 })
    await row.hover()
    await pencil.waitFor({ timeout: 5000 })
    await pencil.click()
    await page.getByText('Talking with').waitFor({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(3000)
    await page.screenshot({ path: `${OUT}/reopen-after-pencil.png` })
    const head = await page.locator('.chat-timeline__title').innerText().catch(() => '')
    check('Mentor took the chat', /Mentor/.test(head), head)
    check('the chatbox docks no chart', await page.locator('.chat-chart-dock').count() === 0)
    check('nothing threw', errors.length === 0, errors.join(' | '))
} catch (err) {
    check(`the drive finished`, false, err.message.slice(0, 200))
    await page.screenshot({ path: `${OUT}/reopen-failed.png` }).catch(() => {})
} finally {
    await browser.close()
    await entities.deleteOne({ id: ID })
    await sessionService.startNew({ userId, force: true }).catch(() => {})
    await db.collection('sessions').deleteOne({ sessionId }).catch(() => {})
    await closeDb?.().catch?.(() => {})
}
const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
