// HOW RISK-BASED WORKS, IN INFO (Roy, 2026-11-05). The pencil on a saved setup puts Mentor in the chat; then the Info column on a
// desktop, and the Info sheet on a phone in the same session. No model turn, two sign-ins. The setup and the session are
// removed. Against the Vite dev server (:5173); axl_dev only.
//
//   node scripts/drive-risk-based-info.mjs [baseUrl] [outDir]
import dns from 'dns'
import 'dotenv/config'
import { chromium, devices } from 'playwright'

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
const ID = `setup_DRIVEINFO_${Date.now()}`
const plan = { asset: 'AAPL', direction: 'long', type: 'swing', trade_mode: 'thesis', timeframe: 'day',
    scenarios: [{ id: 's1', entry_legs: [{ price: 330, quantity: 10 }], stop_legs: [{ price: 320 }], target_legs: [{ price: 360, quantity: 10 }], quantity: 10 }],
    entry_legs: [{ price: 330, quantity: 10 }], stop_legs: [{ price: 320 }], target_legs: [{ price: 360, quantity: 10 }], quantity: 10 }
await entities.insertOne({ ...plan, id: ID, kind: 'setup', userId, parentId: null, status: 'waiting', savedAt: Date.now(), mode: 'paper', broker: 'paper',
    accounts: [account], mainAccountId: account, chat_state: { draft: plan, coverage: [] }, monitor_state: { scenarios: {}, guards: [] } })
const { sessionId } = await sessionService.startNew({ userId, force: true })

const signIn = async (page) => {
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
}
const HEAD = 'How risk-based works'
const browser = await chromium.launch()
const errors = []
try {
    const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    desk.on('pageerror', e => errors.push(e.message.slice(0, 200)))
    await signIn(desk)
    const column = desk.locator('.floor-info')
    check('before Mentor, the column has no such section', await column.getByText(HEAD).count() === 0)
    await desk.locator(':text("Your trades"):visible').first().click()
    const row = desk.locator('.floor-row', { hasText: 'AAPL' }).first()
    await row.waitFor({ timeout: 15000 })
    await row.hover()
    await desk.getByTitle('Edit setup in Mentor chat').first().click()
    await column.getByText(HEAD).waitFor({ timeout: 10000 })
    await desk.screenshot({ path: `${OUT}/info-desktop.png` })
    check('with Mentor in the chat, the column explains it', true)
    const box = await column.locator('.floor-info__body').evaluate(n => ({ scrolls: n.scrollHeight >= n.clientHeight, overflow: getComputedStyle(n).overflowY }))
    check('it scrolls inside the column', box.overflow === 'auto', JSON.stringify(box))
    const state = await desk.context().storageState()
    await desk.close()

    const phone = await (await browser.newContext({ ...devices['Pixel 7'], storageState: state })).newPage()
    phone.on('pageerror', e => errors.push(e.message.slice(0, 200)))
    await signIn(phone)
    await phone.locator('.chat-timeline__info-btn').click()
    const sheet = phone.locator('.chat-info')
    await sheet.getByText(HEAD).waitFor({ timeout: 8000 })
    await phone.screenshot({ path: `${OUT}/info-phone.png` })
    check('on a phone, the Info sheet explains it', true)
    const fit = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    check('no sideways scroll on a phone', fit)
    await sheet.getByText('What the tests found').scrollIntoViewIfNeeded()
    await phone.screenshot({ path: `${OUT}/info-phone-end.png` })
    check('the sheet scrolls to its end', await sheet.getByText('What the tests found').isVisible())
    check('nothing threw', errors.length === 0, errors.join(' | '))
} catch (err) {
    check('the drive finished', false, err.message.slice(0, 240))
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
