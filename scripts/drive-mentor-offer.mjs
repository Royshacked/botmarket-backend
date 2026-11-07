/* global document -- page.evaluate bodies run in the browser */
// DRIVE THE CHOICE OF SCENARIOS AND THE REASONING BOX (Roy, 2026-11-07), in a real browser. Mentor's state is SEEDED with
// an offer on a fresh session: the pane shows it beside the worksheet. Then one real Mentor turn: the offer steps aside
// while it runs and does not come back. The reasoning box is the real component and styles, fed as a stream is.
//
//   node scripts/drive-mentor-offer.mjs [baseUrl] [outDir]     (default http://localhost:5173, the Vite dev server)
//
// One sign-in as the throwaway `ui-smoke` user, one real model turn. LOOK at the screenshots.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')

const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const OFFER = { options: [
    { id: 'A', label: 'pullback before a break', arm: null, stop: 49.66, target: 60.15 },
    { id: 'B', label: 'after a day close over the line', arm: 55.45, stop: 52.46, target: 58.47 },
] }
const DRAFT = { asset: 'ARMK', direction: 'long', type: 'short term swing', trade_mode: 'thesis',
    scenarios: [{ id: 's1', entry_legs: [], stop_legs: [{ price: 49.66 }], target_legs: [{ price: 60.15 }], conditions: [], validity: null }] }

const db = await getDb()
const user = await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } })
if (!user?.id) { console.log(`FAIL  no ${USER.username} user on ${db.databaseName}`); process.exit(1) }
const { sessionId } = await sessionService.startNew({ userId: user.id })
await sessionService.setAgentState({ sessionId, userId: user.id, agent: 'mentor', state: {
    active_asset: 'ARMK', draft: DRAFT, coverage: ['technicals'], drafts: {}, view: { gate: null, readiness: null, setups: null, offer: OFFER },
} })
await sessionService.setFloor({ sessionId, userId: user.id, agent: 'mentor' })

const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(e.message.slice(0, 200)))
const pane = page.locator('.side-pane')
try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
    }
    await pane.waitFor({ timeout: 20000 })
    await page.waitForTimeout(1000)
    await page.screenshot({ path: `${OUT}/offer-1-pane.png` })
    const text = await pane.innerText()
    check('the pane says Mentor is asking', /Mentor is asking: A, B or both/.test(text))
    check('A and B are both there, though the worksheet holds one', /Stop \$49\.66/.test(text) && /Stop \$52\.46 \(assumed\)/.test(text) && /Arms on a day close through \$55\.45/.test(text))

    const box = page.locator('.chat-timeline textarea').first()
    await box.fill('Before I answer: what would make you prefer B over A on this chart? Think it through.')
    await page.keyboard.press('Enter')

    await page.waitForTimeout(1500)
    check('the offer stepped aside while Mentor answered', await page.locator('.scenario-offer').count() === 0)
    await page.locator('.chat-timeline textarea').first().waitFor({ timeout: 5000 })
    for (let i = 0; i < 180 && await page.getByRole('button', { name: /stop/i }).count(); i++) await page.waitForTimeout(500)

    await page.waitForTimeout(4000)
    await page.screenshot({ path: `${OUT}/offer-3-after.png` })
    check('the offer does not come back on a turn that does not ask', await page.locator('.scenario-offer').count() === 0)

    // The reasoning box: a real turn may stream none, so the real component with its real styles, fed as a stream is.
    const box2 = await page.evaluate(async () => {
        const React = (await import('/node_modules/.vite/deps/react.js')).default
        const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
        const { ChatReasoning } = await import('/src/cmps/ChatReasoning.jsx')
        const host = document.createElement('div')
        host.style.cssText = 'position:fixed;left:240px;top:120px;width:600px;z-index:9999;background:#000'
        document.body.append(host)
        const root = createRoot(host)
        const tick = () => new Promise(r => setTimeout(r, 60))
        let text = ''
        const grow = async (n) => { for (let i = 0; i < n; i++) { text += 'The next line of the reasoning, as it streams in.\n'; root.render(React.createElement(ChatReasoning, { reasoning: [{ source: 'desk', text }], live: true, streaming: true })); await tick() } }
        await grow(40)
        const el = host.querySelector('.chat-reasoning__body')
        const gap = () => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)
        const followed = gap()
        const overflow = el.scrollHeight > el.clientHeight
        el.scrollTop = 0; await tick()
        await grow(5)
        const stayed = el.scrollTop
        el.scrollTop = el.scrollHeight; await tick()
        await grow(5)
        const resumed = gap()
        return { overflow, followed, stayed, resumed }
    })
    console.log('reasoning box', JSON.stringify(box2))
    check('the reasoning overflows its box, so this tests something', box2.overflow)
    check('it stays on the newest line as the text grows', box2.followed < 5, String(box2.followed))
    check('scrolled up, it keeps their place', box2.stayed === 0, String(box2.stayed))
    check('back at the end, it follows again', box2.resumed < 5, String(box2.resumed))
    await page.screenshot({ path: `${OUT}/offer-4-reasoning.png` })
    check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
    await browser.close()
    await closeDb()
}
const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length}`)
process.exit(failed ? 1 : 0)
