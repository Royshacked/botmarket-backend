// DRIVE THE END-OF-CHAT CHART ON THE LEVELS SO FAR (Roy, 2026-11-05). A worksheet with a stop and a target over every
// candle and no entry, written straight onto a fresh session: the chart draws under the chat and both lines are in it.
// Read the screenshot. No model spend, one sign-in, against Vite (:5173) as `ui-smoke`; the session is deleted after.
//
//   node scripts/drive-mentor-levels-chart.mjs [outDir]
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '.'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
dns.setServers(['8.8.8.8', '1.1.1.1'])
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')

const db = await getDb()
const { id: userId } = await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } })
const { sessionId } = await sessionService.startNew({ userId })
await sessionService.setFloor({ sessionId, userId, agent: 'mentor' })
const draft = { asset: 'AAPL', direction: 'long', type: 'swing', trade_mode: 'thesis', timeframe: 'day', scenarios: [
    { id: 's1', name: 'pullback', entry_legs: [], stop_legs: [{ id: 'x1', price: 323.73 }], target_legs: [{ id: 't1', price: 378.13, anchor: 'measured_move' }] },
] }
await db.collection('sessions').updateOne({ sessionId }, { $set: { seq: 1, 'agentState.mentor': { draft, view: { readiness: { ready: false, missing: ['entry price', 'quantity'] } } } } })
await db.collection('session_messages').insertOne({ sessionId, seq: 1, agent: 'mentor', role: 'assistant', kind: 'text', content: 'What is your risk limit and minimum reward to risk?', at: new Date() })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
let failed = false
try {
    await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input').first().count()) {
        await page.locator('input').nth(0).fill(USER.username)
        await page.locator('input').nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.mentor-trade-chart canvas').first().waitFor({ timeout: 25000 })
    await page.waitForTimeout(4000)
    console.log('note:', await page.locator('.mentor-trade-chart__note').innerText())
    await page.locator('.mentor-trade-chart').screenshot({ path: `${OUT}/mentor-levels-chart.png` })
} catch (err) {
    failed = true
    console.log('FAIL', err.message.slice(0, 300))
    await page.screenshot({ path: `${OUT}/mentor-levels-chart-fail.png` })
} finally {
    await browser.close()
    await db.collection('sessions').deleteOne({ sessionId }).catch(() => {})
    await db.collection('session_messages').deleteMany({ sessionId }).catch(() => {})
    await closeDb()
}
process.exit(failed ? 1 : 0)
