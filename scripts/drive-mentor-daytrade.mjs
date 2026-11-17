// DRIVE THE SCREEN — a day trade off the Hotlist's Intraday tab (Roy, 2026-11-14: KDP — the trader said "I'm asking the
// analyst and the technical analyst", code had asked neither, then he waited on an analyst read a day trade never gets).
// Build a setup on an Intraday row; watch the chat's status while the name is measured; the reply must not ask for, or
// wait on, the analyst — and the technical read must be in it on the first turn.
// 2026-11-14 (Roy: "lets go for stop in 1hr"): the day trade's opening says the 15m / 1h and a 1-hour close, never "a day
// close"; after the user's numbers the stop is the 1-hour chart's, no deeper stop is offered and no break scenario.
//
//   node scripts/drive-mentor-daytrade.mjs [baseUrl] [outDir] [row]     (default http://localhost:5173 · . · last)
//
// As the throwaway QA user `ui-smoke`. ONE login per run — drives share the developer's IP for the auth limiter.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.argv[3] ?? '.'
const ROW = process.argv[4] ?? 'last'
const USER = { username: 'ui-smoke', password: 'Sm0ke!Drive#29' }
const NAMES = /\b(Mentor|Prometheus|Atlas|Argus|Proteus|Pythia|Aether|Talos|Themis)\b/
dns.setServers(['8.8.8.8', '1.1.1.1'])

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/daytrade-${name}.png` }); console.log('  shot:', name) }
let failed = false
const expect = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failed = true }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await page.locator('input[type="password"]').count()) {
        const inputs = page.locator('input')
        await inputs.nth(0).fill(USER.username)
        await inputs.nth(1).fill(USER.password)
        await page.keyboard.press('Enter')
    }
    await page.locator('.chat-timeline textarea').first().waitFor({ timeout: 30_000 }).catch(() => {})
    if (!(await page.locator('.chat-timeline textarea').count())) { await shot(page, '00-not-signed-in'); throw new Error('not signed in — the auth limiter? wait 15 minutes') }
    // The button is disabled until the session has loaded (empty → disabled): checked at once, an old session
    // carried on (2026-11-14: the 07:21 YETI reply, old prompt and all, sat over the new turn).
    const fresh = page.getByRole('button', { name: 'New session' })
    await page.waitForTimeout(4000)
    if (await fresh.isEnabled().catch(() => false)) { await fresh.click(); await page.waitForTimeout(2500); console.log('  new session started') }
    else console.log('  · no session to file — already fresh')
    expect(!(await page.locator('.chat-timeline__row--assistant').count()), 'the chat starts empty')

    await page.locator('.floor-desk__head', { has: page.locator('.floor-desk__label', { hasText: /^Hotlist$/ }) }).click()
    await page.waitForTimeout(2500)
    await page.getByRole('button', { name: /^Intraday\b/ }).first().click()
    await page.waitForTimeout(2500)
    // A row's Build button is in the OPENED row (opening it measures the name too — the chip shows only on a cold name).
    const opens = page.getByRole('button', { name: /^Details for / })
    const n = await opens.count()
    if (!n) { await shot(page, '00-no-rows'); throw new Error('no Intraday row to build') }
    const open = ROW === 'last' ? opens.nth(n - 1) : opens.nth(Number(ROW))
    const sym = (await open.getAttribute('aria-label'))?.replace('Details for ', '')
    console.log(`  building row ${ROW} of ${n}: ${sym}`)
    await open.click()
    await page.getByRole('button', { name: 'Build a setup' }).first().waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Build a setup' }).first().click()

    // Every chip the chat shows while the turn runs (polled — the measuring one lasts seconds).
    const chips = new Set()
    const until = Date.now() + 180_000
    let done = false
    while (Date.now() < until) {
        for (const t of await page.locator('.chat-timeline .tool-status-chip').allInnerTexts().catch(() => [])) chips.add(t.trim())
        const live = await page.locator('.chat-timeline__row--live').count()
        const replies = await page.locator('.chat-timeline__row--assistant').count()
        if (!live && replies > 0 && chips.size) { done = true; break }
        if (!live && replies > 1) { done = true; break }
        await page.waitForTimeout(400)
    }
    await page.waitForTimeout(2500)
    console.log('  chips seen:', [...chips].join(' | ') || '(none)')
    const chat = (await page.locator('.chat-timeline').innerText()).replace(/\s+/g, ' ')
    console.log('  chat:', chat.slice(-1400))
    expect(done, 'the trader answered')
    expect(!/asking the analyst|analyst['’]s (and the technical analyst['’]s )?reads? (haven|has not)|waiting (on|for) the analyst/i.test(chat), 'he neither asks for nor waits on an analyst read')
    expect(/measured \d{4}-\d{2}-\d{2}/.test(chat), "the technical analyst's dated line is in the chat on the FIRST turn")
    expect(!NAMES.test(chat.replace(/Talking with Axl[^·]*·/g, '')), 'no internal agent name in the chat')
    expect(!/The analyst is reading/.test(chat), 'no research status line for a day trade')
    if ([...chips].some(c => /Measuring how it trades/.test(c))) console.log('  ✓ the measuring chip showed (the name was not cached)')
    else console.log('  · no measuring chip — the name was already measured this week (cached), or it passed between polls')
    await shot(page, '01-reply')
    expect(/15m and 1h|15-minute and 1-hour|15m \/ 1h/i.test(chat), 'the opening says strength on the 15m / 1h')
    expect(/1-hour close|hourly close|1h close/i.test(chat), 'the opening says a 1-hour close breaks it')
    expect(!/day close/i.test(chat), 'never "a day close" on a day trade')

    // THE USER'S NUMBERS — the stop and the level come back off the 1-hour chart.
    const before = await page.locator('.chat-timeline__row--assistant').count()
    const box = page.locator('.chat-timeline textarea').first()
    await box.fill('Position size $10,000, risk 1% of it, minimum R:R 1.5. Go long.')
    await page.keyboard.press('Enter')
    const until2 = Date.now() + 240_000
    while (Date.now() < until2) {
        const live = await page.locator('.chat-timeline__row--live').count()
        if (!live && (await page.locator('.chat-timeline__row--assistant').count()) > before) break
        await page.waitForTimeout(500)
    }
    await page.waitForTimeout(2500)
    const rows2 = await page.locator('.chat-timeline__row--assistant').allInnerTexts()
    const reply2 = (rows2.at(-1) ?? '').replace(/\s+/g, ' ')
    console.log('  reply 2:', reply2.slice(0, 1600))
    expect(rows2.length > before, 'the trader answered the numbers')
    expect(!/deep(er)? stop|whole fall/i.test(reply2), 'no deeper stop offered')
    expect(!/scenario B|break scenario|both scenarios/i.test(reply2), 'no break scenario on a day trade')
    expect(!/day close/i.test(reply2), 'still no "day close"')
    expect(!NAMES.test(reply2), 'no internal agent name')
    await shot(page, '02-numbers')

    // ALL THE WAY — the levels themselves: the stop off the 1-hour chart, no deeper one, no B, no day close.
    // A build that completes is GENERATED and the session filed: the chat goes home. So the turn is read while it is on
    // screen (the last view that still holds the user's line), and the save is "Your trades" counting one more.
    const tradesNow = async () => Number(((await page.locator('body').innerText().catch(() => '')).match(/Your trades\s*\((\d+)\)/) ?? [])[1] ?? NaN)
    const trades0 = await tradesNow()
    await box.fill('All the way.')
    await page.keyboard.press('Enter')
    let reply3 = ''
    const until3 = Date.now() + 300_000
    while (Date.now() < until3) {
        const all3 = (await page.locator('.chat-timeline').innerText().catch(() => '')).replace(/\s+/g, ' ')
        const at = all3.lastIndexOf('All the way.')
        if (at >= 0) reply3 = all3.slice(at + 'All the way.'.length)
        else if (reply3) break   // filed — the chat went home
        const live = await page.locator('.chat-timeline__row--live').count()
        if (!live && /\b1HR\b/.test(reply3)) { await page.waitForTimeout(1500); break }
        await page.waitForTimeout(400)
    }
    await page.waitForTimeout(3000)
    console.log('  reply 3:', reply3.slice(0, 2000))
    // The save shows as the menu's count going up or the session filed (the chat home) — either can lag the reply.
    let trades1 = await tradesNow(), filed = false
    for (const end = Date.now() + 20_000; Date.now() < end && !(trades1 > trades0) && !filed; await page.waitForTimeout(1000)) {
        trades1 = await tradesNow()
        filed = !(await page.locator('.chat-timeline').innerText().catch(() => '')).includes('All the way.')
    }
    console.log(`  your trades: ${trades0} → ${trades1}${filed ? ' · session filed' : ''}`)
    expect(trades1 > trades0 || filed, 'the setup was generated and saved')
    expect(/stop[^.]*\$?\d/i.test(reply3), 'a stop price is set')
    expect(/\b1HR\b/.test(reply3), 'the chat chart is drawn on the 1-hour')
    expect(!/deep(er)? stop|whole fall/i.test(reply3), 'no deeper stop offered')
    expect(!/scenario B|break scenario|both scenarios/i.test(reply3), 'no break scenario')
    expect(!/day close/i.test(reply3), 'no "day close"')
    expect(!NAMES.test(reply3), 'no internal agent name')
    await shot(page, '03-all-the-way')
} catch (err) {
    console.error('drive error:', err.message)
    failed = true
} finally {
    console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'page errors: none')
    await browser.close()
    console.log(failed ? 'DRIVE FAILED' : 'DRIVE PASSED')
    process.exit(failed ? 1 : 0)
}
