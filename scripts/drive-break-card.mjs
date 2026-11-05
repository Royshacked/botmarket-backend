// DRIVE THE BREAK CARD (Roy, 2026-11-04: "any scenario, if price went below the stop, the user is notified to redraw or
// close the setup"). The hardest case: a B alone that has not armed, its assumed stop over today's price.
//
//   1. Talos's own wake with only the price feed stubbed: a close over the floor says nothing, a close under it is the card.
//   2. The card in the social chat, with Re-draw it, Close setup and Dismiss.
//   3. Close setup, pressed in the browser: the setup is closed and the card resolved.
//
//   node scripts/drive-break-card.mjs [baseUrl] [outDir]
//
// Against the Vite dev server (:5173) and a backend started after this code. One sign-in, no Mentor turn. Cleans up.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])
if (process.env.DB_NAME !== 'axl_dev') throw new Error(`refusing to run against ${process.env.DB_NAME} — axl_dev only`)

const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { setupService } = await import('../api/setups/setups.service.js')
const { paperBrokerService } = await import('../api/broker/paperBroker.service.js')
const { _checkSetup, _testDeps } = await import('../monitoring/talos.monitor.service.js')

const SETUP = {
    asset: 'GNRC', direction: 'long', type: 'swing', trade_mode: 'thesis', entry_mode: 'conditional', timeframe: 'day',
    pace_rungs: ['1hr', '4hr'], valid_until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    scenarios: [{
        id: 'B', name: 'After the break', archetype: 'breakout', arm_close: 212.81, arm_floor: 171.06,
        entry_legs: [{ price: 214, quantity: 13 }], stop_legs: [{ price: 205, anchor: 'structure' }], target_legs: [{ price: 240, anchor: 'structure' }],
        conditions: [
            { id: 'c1', text: 'Price at or under 214 shows strength on the 1h / 4h', weight: 'primary', mode: 'judgment' },
            { id: 'arm', text: 'A day close over 212.81 since 2026-11-04', weight: 'primary', mode: 'measured', persistence: 'latching' },
        ],
        validity: { lower: 205, upper: 226, approach: 240, timeframe: 'day', on_break: 'revise', on_away: 'revise' },
    }],
}

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

const db = await getDb()
const userId = (await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } }))?.id
if (!userId) throw new Error('no ui-smoke user — run another drive first')

let setupId = null
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

const wake = async (close) => {
    const doc = await db.collection('entities').findOne({ id: setupId }, { projection: { _id: 0 } })
    return _checkSetup(doc, Date.now(), {
        ..._testDeps, isAssetOpen: () => true, getPrice: async () => close, getClose: async () => close,
        assess: async () => ({ verdict: 'wait', read: 'Waiting.', timeframe_used: '1hr', next_timeframe: '1hr', conditions: [] }),
        cheapRead: async () => null,
    })
}

try {
    const paper = await paperBrokerService.getAccount(userId)
    const accounts = paper ? [{ id: paper.accountId, broker: 'paper' }] : []
    const made = await setupService.generateSetup(SETUP, { userId, accounts, mainAccountId: paper?.accountId ?? null })
    setupId = made?.ok ? made.doc?.id : null
    check('fixture: Generate takes a lone B with its line and its floor', setupId, made?.reason ?? setupId)
    if (!setupId) throw new Error(`setup not made: ${JSON.stringify(made?.problems ?? made?.reason)}`)
    await setupService.patchSetup(setupId, { status: 'looking' }, userId)

    await wake(190)
    const quiet = await db.collection('chat_messages').countDocuments({ type: 'setup_invalidation', 'payload.setupId': setupId })
    check('a close under the assumed stop, over the floor: no card', quiet === 0, String(quiet))

    const out = await wake(170)
    check('a close under the floor is a break', out?.reason === 'invalidation' && out?.side === 'adverse', JSON.stringify(out))
    const card = await db.collection('chat_messages').findOne({ type: 'setup_invalidation', 'payload.setupId': setupId }, { projection: { _id: 0 } })
    console.log('card:', card?.content)
    check('the card is pending, from Mentor', card?.senderId === 'mentor' && card?.status === 'pending')
    check('…with Re-draw it, Close setup and Dismiss', card?.actions?.primary?.label === 'Re-draw it' && card?.actions?.close?.label === 'Close setup' && card?.actions?.dismiss === true, JSON.stringify(card?.actions))
    check('…and it says so in words', /under the low of the move/.test(card?.content ?? '') && /Re-draw it, or close the setup/.test(card?.content ?? ''))
    const held = await db.collection('entities').findOne({ id: setupId }, { projection: { _id: 0, status: 1 } })
    check('nothing closes by itself', held.status === 'looking', held.status)

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
    }
    await page.locator('.chat-timeline').waitFor({ timeout: 20000 })
    await page.waitForTimeout(2000)
    await page.locator('.app-header-axl__chat').click()
    await page.locator('.social-chat__topbar').waitFor({ timeout: 10000 })
    const back = page.getByLabel('Back to conversations')
    if (await back.count()) await back.click()
    const conv = page.locator('.social-chat__conv-item', { hasText: 'Mentor' }).first()
    await conv.waitFor({ timeout: 10000 })
    await conv.click()
    const close = page.getByRole('button', { name: 'Close setup' }).last()
    const shown = await close.waitFor({ timeout: 10000 }).then(() => true).catch(() => false)
    await page.screenshot({ path: `${OUT}/bc-01-card.png` })
    check('the card shows in the social chat with Close setup', shown)
    if (!shown) throw new Error('no button')
    await close.click()
    await page.waitForTimeout(2500)
    await page.screenshot({ path: `${OUT}/bc-02-closed.png` })
    const closed = await db.collection('entities').findOne({ id: setupId }, { projection: { _id: 0, status: 1, closedReason: 1 } })
    check('pressed: the setup is closed', closed.status === 'closed', JSON.stringify(closed))
    const resolved = await db.collection('chat_messages').findOne({ type: 'setup_invalidation', 'payload.setupId': setupId }, { projection: { _id: 0, status: 1 } })
    check('…and the card resolved', resolved?.status !== 'pending', resolved?.status)
    check('…and the chip says so', await page.getByText('Setup closed').last().isVisible().catch(() => false))
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
} finally {
    if (setupId) {
        await db.collection('chat_messages').deleteMany({ 'payload.setupId': setupId }).catch(() => {})
        await db.collection('entities').deleteOne({ id: setupId }).catch(() => {})
    }
    if (errors.length) check('no page errors', false, errors.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
    await closeDb()
}
