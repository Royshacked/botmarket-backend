// DRIVE THE THESIS LENS — the Hotlist's Build with Mentor, a real Mentor build (Roy, 2026-10-30; docs/design/stock-playbook.md).
//
// A Swing name off the Hotlist is handed to Mentor with Build with Mentor; the drive answers him the way a user would
// (the lens, the timeframe, a risk limit and a minimum reward to risk, a size, how long to wait) for a few turns, then
// reads what he built. What it proves: the hand-off carries the lens, Mentor reads the structure with the new tool, and
// the setup Talos would get has the thesis shape — the lens, a conditional entry at a level, the 1h / 4h rungs and a
// strength condition Talos judges.
//
// And the trade chart (2026-10-31): once Generate lights, the trade is drawn on a chart in the thread, a turn tall — not
// the chat's whole height — and it stays when the pane is hidden.
//
//   node scripts/drive-thesis-lens.mjs [baseUrl] [outDir]
//
// Against the Vite dev server (:5173) as the throwaway `ui-smoke` user, on a FRESH session. Real model spend: a few Mentor
// turns (cents). Nothing is generated; the session is deleted after. One sign-in — mind the auth limiter.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const USER = { username: 'ui-smoke', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }
const MAX_TURNS = 6

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { userService } = await import('../api/user/user.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')

const ANSWER = 'Yes — build it through the thesis lens, long, as a swing, on my paper account. My risk limit is 6% '
    + '(the stop at most 6% from the entry) and my minimum reward to risk is 1.5. Risk $200 on it. It can wait 10 trading days for the entry.'
const NUDGE = 'Your stop and targets are fine with me, and my limits, size and wait are as I said. Build it as is.'

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/thesis-${name}.png`, fullPage: false }); console.log('  shot:', name) }
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

async function ensureUser() {
    try { await userService.createUser(USER); console.log('qa user: created') }
    catch (err) { console.log('qa user: already there —', err.message) }
    const db = await getDb()
    const u = await db.collection('users').findOne({ username: USER.username }, { projection: { id: 1 } })
    if (!u?.id) throw new Error('qa user has no id')
    return u.id
}

async function signIn(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input').first().count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
    await page.locator('.chat-timeline').waitFor({ timeout: 15000 })
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
    return waitIdle(page, 300000)
}

const userId = await ensureUser()
const sid = (await sessionService.startNew({ userId })).sessionId
console.log('session:', sid)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = [], turns = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
page.on('request', r => { if (r.method() === 'POST' && /\/api\/sessions\/[^/]+\/turn/.test(r.url())) { try { turns.push(JSON.parse(r.postData() ?? '{}')) } catch { /* not JSON */ } } })

try {
    await signIn(page)
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.floor-lists', { timeout: 15000 })
    await page.waitForTimeout(2000)

    // ── 1. the Hotlist's Swing tab → a name's details → Build with Mentor ──
    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForSelector('.hot-panel', { timeout: 60000 })
    await page.locator('.hot-panel').getByRole('button', { name: /^Swing/ }).click()
    await page.waitForSelector('.hot-panel tr.hot-row', { timeout: 60000 })
    const sym = await page.locator('.hot-panel tr.hot-row').first().getAttribute('data-symbol')
    // A cell that is not the symbol opens the row's page (2026-10-31, drive-hotlist-row-page.mjs); Build with Mentor is on it.
    await page.locator('.hot-panel tr.hot-row').first().locator('td').nth(3).click()
    await page.waitForSelector('.hot-page', { timeout: 10000 })
    await shot(page, '01-row')
    await page.locator('.hot-panel').getByRole('button', { name: 'Build with Mentor' }).first().click()
    const opened = await waitIdle(page, 300000)
    const first = turns.find(t => t.agent === 'mentor')
    check(`Build with Mentor hands ${sym} over in the thesis lens`, first?.seed?.recommended_mode === 'thesis', JSON.stringify(first?.seed ?? null).slice(0, 200))
    check('the opening turn finished', opened)
    await shot(page, '02-opening')
    const opening = (await page.locator('.chat-timeline').innerText().catch(() => '')).slice(-2500)
    check('Mentor says he is building it through the thesis lens', /thesis/i.test(opening), opening.replace(/\s+/g, ' ').slice(-300))

    // ── 2. answer him as a user would, then nudge until the setup holds the levels (or the budget runs out) ──
    let n = 1
    await say(page, ANSWER)
    let state = (await sessionService.get({ sessionId: sid, userId }))?.agentState?.mentor
    while (n < MAX_TURNS && !(state?.draft?.scenarios?.[0]?.entry_legs?.[0]?.price && state?.view?.readiness?.ready)) {
        await say(page, NUDGE)
        n++
        state = (await sessionService.get({ sessionId: sid, userId }))?.agentState?.mentor
    }
    await shot(page, '03-built')
    const d = state?.draft ?? {}
    const sc = d.scenarios?.[0] ?? {}
    const reads = Object.keys(d.build?.reads ?? state?.build?.reads ?? {})
    console.log('draft:', JSON.stringify({ asset: d.asset, trade_mode: d.trade_mode, entry_mode: d.entry_mode, timeframe: d.timeframe, pace_rungs: d.pace_rungs, valid_until: d.valid_until,
        entry: sc.entry_legs?.map(l => l.price), stop: sc.stop_legs?.map(l => l.price), targets: sc.target_legs?.map(l => l.price), conditions: [...(d.conditions ?? []), ...(sc.conditions ?? [])] }))
    console.log('reads:', reads.join(', '))
    check(`the setup is in the thesis lens (${n + 1} turns)`, d.trade_mode === 'thesis', `trade_mode ${d.trade_mode}`)
    check('Mentor read the structure with get_price_structure', reads.includes('get_price_structure'), reads.join(', '))
    check('a conditional entry at a price, a stop under it, a target over it', d.entry_mode !== 'limit' && sc.entry_legs?.[0]?.price > 0 && sc.stop_legs?.[0]?.price < sc.entry_legs?.[0]?.price && sc.target_legs?.[0]?.price > sc.entry_legs?.[0]?.price,
        `entry ${sc.entry_legs?.[0]?.price} · stop ${sc.stop_legs?.[0]?.price} · target ${sc.target_legs?.[0]?.price}`)
    const rungs = d.pace_rungs ?? []
    check('Talos reads it on the 1h / 4h', rungs.includes('1hr') || rungs.includes('4hr'), JSON.stringify(rungs))
    const conds = [...(d.conditions ?? []), ...(sc.conditions ?? [])]
    check('a strength condition Talos judges', conds.some(c => c.mode === 'judgment' && /strength|strong/i.test(c.text ?? '')), JSON.stringify(conds.map(c => [c.mode, c.weight, c.text])))
    check('the wait the user gave is written as valid_until', !!d.valid_until, d.valid_until)

    // ── 3. Generate lit → the trade on a chart in the thread, a turn tall ──
    check('Generate is lit', !!state?.view?.readiness?.ready, JSON.stringify(state?.view?.readiness?.missing ?? null))
    const chart = page.locator('.chat-timeline__thread .mentor-trade-chart')
    await chart.waitFor({ timeout: 20000 }).catch(() => {})
    check('the trade chart is in the chat thread', (await chart.count()) === 1)
    if (await chart.count()) {
        await page.waitForTimeout(3000)
        await chart.scrollIntoViewIfNeeded()
        const [box, body] = [await chart.boundingBox(), await page.locator('.chat-timeline__body').boundingBox()]
        check('it is a turn tall, not the chat’s whole height (< 45%)', box && body && box.height < body.height * 0.45, `${Math.round(box?.height)} of ${Math.round(body?.height)}px`)
        check('candles are drawn in it', (await chart.locator('canvas').count()) > 0)
        await shot(page, '05-trade-chart')
        await chart.getByRole('button', { name: 'Full chart' }).click()
        await page.waitForSelector('.chat-chart-dock', { timeout: 10000 }).catch(() => {})
        check('"Full chart" docks the chart', (await page.locator('.chat-chart-dock').count()) === 1)
        await shot(page, '06-full-chart')
        // The chart belongs to the conversation: hiding Mentor's work leaves it in the thread.
        await page.getByRole('button', { name: /^Hide .*work/ }).click()
        await page.waitForTimeout(1500)
        check('hiding the pane leaves the chart in the thread', (await page.locator('.chat-timeline__thread .mentor-trade-chart').count()) === 1)
        await shot(page, '07-pane-hidden')
    }
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
    await shot(page, 'error').catch(() => {})
} finally {
    const db = await getDb()
    await db.collection('session_messages').deleteMany({ sessionId: sid }).catch(() => {})
    await db.collection('sessions').deleteOne({ sessionId: sid }).catch(() => {})
    const crashed = errors.filter(e => e.startsWith('PAGEERROR'))
    if (crashed.length) check('no page errors', false, crashed.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
    if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '))
    await closeDb()
}
