// DRIVE MENTOR'S LEVELS BEFORE THE LIMITS (Roy, 2026-11-05). A name just under its highs (AAPL, or argv's), bare, walked
// to the turn that asks for the risk limit and the reward to risk. Checks: the target is the measured move rather than the
// high price is already at; the distances are in dollars and percent; the trade chart is drawn at the end of the chat.
//
//   node scripts/drive-mentor-levels.mjs [TICKER] [baseUrl] [outDir]
//
// Through the running dev backend: restart it first, or this drives whatever code it started with (verify-mentor-levels.mjs
// has no such gap). Against the Vite dev server (:5173) as `ui-smoke`, on a FRESH session (deleted after). Nothing is generated. Real model
// spend: three to six Mentor turns. One sign-in.
import dns from 'dns'
import { readFileSync, statSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

const TICKER = process.argv[2] ?? 'AAPL'
const BASE = process.argv[3] ?? 'http://localhost:5173'
const OUT = process.argv[4] ?? '.'
const LOG = 'logs/backend.log'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')
const { thesisTurnFacts } = await import('../services/tools/thesisStructure.tools.js')

const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

let logAt = statSync(LOG).size
function turnTools() {
    const buf = readFileSync(LOG)
    const fresh = buf.subarray(logAt).toString('utf8')
    logAt = buf.length
    return fresh.split('\n').filter(l => l.includes('[mentorAgent] | chatStream done | '))
        .flatMap(l => { try { return JSON.parse(l.slice(l.indexOf('chatStream done | ') + 18)).tools ?? [] } catch { return [] } })
}
async function waitIdle(page, ms) {
    const deadline = Date.now() + ms
    await page.waitForTimeout(2000)
    while (Date.now() < deadline) {
        if (!(await page.getByLabel('Stop response').count())) return true
        await page.waitForTimeout(2000)
    }
    return false
}
async function say(page, text) {
    const box = page.locator('.chat-timeline textarea')
    await box.fill(text)
    await box.press('Enter')
    await waitIdle(page, 300000)
    await page.waitForTimeout(1500)
    const all = await page.locator('.chat-timeline').innerText().catch(() => '')
    const chunks = all.split(/\nMENTOR\n/)
    const reply = chunks.length > 1 ? chunks.at(-1).replace(/\nAsk Axl instead[\s\S]*$/, '') : ''
    const tools = turnTools()
    console.log(`\n>>> USER: ${text}\n<<< MENTOR [tools: ${tools.join(', ') || '—'}]\n${reply.trim().slice(0, 3000)}\n`)
    return { reply, tools }
}

const db = await getDb()
const { id: userId } = await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } })
const facts = await thesisTurnFacts({ ticker: TICKER })
console.log('facts', JSON.stringify({ close: facts.close, atr: facts.atr, stop: facts.stop, target: facts.target, kind: facts.target_kind }))

const sid = (await sessionService.startNew({ userId })).sessionId
await sessionService.setFloor({ sessionId: sid, userId, agent: 'mentor' })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input').first().count()) {
        await page.locator('input').nth(0).fill(USER.username)
        await page.locator('input').nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
    await page.locator('.chat-timeline textarea').waitFor({ timeout: 20000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline textarea').waitFor({ timeout: 20000 })
    await page.waitForTimeout(2000)
    turnTools()

    let r = await say(page, `Build me a swing trade on ${TICKER}.`)
    r = await say(page, 'Yes — long, swing. Stop at the checkpoints.')
    const asks = (t) => /risk limit/i.test(t) && /reward[- ]to[- ]risk|r:r/i.test(t) && /\?/.test(t) && !/next checkpoint/i.test(t)
    for (let i = 0; i < 5 && !asks(r.reply); i++) r = await say(page, 'Agreed — go on. Stay on the regular stop, one target, and no break scenario.')
    check('the turn asks for the limits', asks(r.reply))
    check('the chart is at the end of the chat', await page.locator('.mentor-trade-chart canvas').count() > 0 && await page.locator('.mentor-trade-chart').isVisible())
    console.log('chart note:', await page.locator('.mentor-trade-chart__note').innerText().catch(() => 'none'))
    check('a distance in dollars and percent', /\$\d[\d,.]*\s*\(\d+(\.\d+)?%\)/.test(r.reply))
    if (facts.target_kind === 'measured_move') {
        const said = await page.locator('.chat-timeline').innerText()
        const sc = (await sessionService.get({ sessionId: sid, userId }))?.agentState?.mentor?.draft?.scenarios?.[0]
        console.log('worksheet target', JSON.stringify(sc?.target_legs))
        check('the measured move on the worksheet is the calculated one', sc?.target_legs?.[0]?.price === facts.target, String(facts.target))
        check('the reply says that number', said.includes(String(facts.target)))
    }
    await page.screenshot({ path: `${OUT}/mentor-levels.png` })
} finally {
    await browser.close()
    await db.collection('sessions').deleteOne({ sessionId: sid }).catch(() => {})
    await db.collection('session_messages').deleteMany({ sessionId: sid }).catch(() => {})
    await closeDb?.()
}
const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
