// DRIVE THE DETAIL PANEL — the Floor rows that open a page of reading (DetailPanel, 2026-10-13):
// an events-radar name, an analyst-companies thesis, and Pythia's Assessed / Themes / Structure rows.
//
//   node scripts/drive-detail-panel.mjs [baseUrl] [outDir]
//
// Desktop (1600×900, the three-column Floor): the panel must dock OVER THE CHAT COLUMN, leave the
// chat mounted under it, mark its row, close on Esc. Tablet with a touch screen: the same row opens a
// full-screen page and the browser's back closes it. LOOK at the screenshots.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USER = { username: 'ui-smoke-panel', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { userService } = await import('../api/user/user.service.js')

const shot = async (page, name) => {
    await page.screenshot({ path: `${OUT}/panel-${name}.png`, fullPage: false })
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

// The panel's facts, read off the DOM rather than trusted from a screenshot alone.
const panelState = (page) => page.evaluate(() => {
    const p = document.querySelector('.detail-panel')
    if (!p) return { open: false }
    const r = p.getBoundingClientRect()
    const chat = document.querySelector('.workspace__chat')
    const c = chat?.getBoundingClientRect()
    return {
        open: true,
        mode: p.className.match(/detail-panel--(\w+)/)?.[1],
        inChat: !!p.closest('.workspace__chat'),
        coversChat: c ? Math.abs(r.left - c.left) < 2 && Math.abs(r.width - c.width) < 2 : null,
        chatStillMounted: !!chat?.querySelector('.axl-hub, .chat-panel, .chat-tabs__panel'),
        title: p.querySelector('.detail-panel__title')?.textContent,
        kicker: p.querySelector('.detail-panel__kicker')?.textContent,
        bodyFont: getComputedStyle(p.querySelector('.detail-panel__body > *') ?? p).fontSize,
        markedRows: document.querySelectorAll('[aria-haspopup="dialog"][aria-expanded="true"]').length,
        width: Math.round(r.width),
    }
})

// One desk open at a time and the rest folded away, so another desk is reached by closing the open
// one first. Clicking the open desk's own name closes it.
async function openDesk(page, name) {
    const open = page.locator('.floor-desk--open > .floor-desk__head')
    if (await open.count() && !(await open.first().textContent()).includes(name)) {
        await open.first().click()
        await page.waitForTimeout(600)
    }
    await page.locator('.floor-desk__head').filter({ hasText: name }).first().click()
    await page.waitForTimeout(1500)
}

try { await userService.createUser(USER); console.log('qa user created') } catch (e) { console.log('qa user exists —', e.message) }

const browser = await chromium.launch({ channel: 'msedge' })
const errors = []
const results = []
const check = (label, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
try {
    // ── desktop ──────────────────────────────────────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    const page = await ctx.newPage()
    page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
    await signIn(page)
    // The standard layout first: its lists column renders the same rows, and the panel must dock
    // over the chat there too.
    await page.getByRole('button', { name: /Forecasts/ }).first().click()
    await page.waitForTimeout(2500)
    for (const tab of ['Assessed', 'Themes', 'Structure']) {
        await page.getByRole('tab', { name: tab }).click()
        await page.waitForTimeout(1000)
        const std = page.locator('.industry-view__line[aria-haspopup="dialog"]').first()
        if (!(await std.count())) continue
        await std.click()
        await page.waitForTimeout(800)
        const s = await panelState(page)
        console.log(`standard layout (${tab}):`, JSON.stringify(s))
        check('standard layout: docks over the chat column', s.mode === 'docked' && s.coversChat)
        await shot(page, '00-standard-forecasts')
        await page.keyboard.press('Escape')
        break
    }
    // The Floor: the design trial is a stored choice (designService), read at load.
    await page.evaluate(() => localStorage.setItem('design', 'floor'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3500)
    await shot(page, '01-floor')

    // Events radar → first event → first name.
    await openDesk(page, 'Events radar')
    const ev = page.locator('.aether-candidates .floor-sub > .floor-rowhost > .floor-row').first()
    if (await ev.count()) {
        await ev.click()
        await page.waitForTimeout(600)
        const name = page.locator('.aether-candidates__name .floor-row').first()
        if (await name.count()) {
            await name.click()
            await page.waitForTimeout(800)
            const s = await panelState(page)
            console.log('events:', JSON.stringify(s))
            check('events: docks over the chat column', s.mode === 'docked' && s.inChat && s.coversChat, JSON.stringify({ mode: s.mode, inChat: s.inChat, coversChat: s.coversChat }))
            check('events: chat still mounted under it', s.chatStillMounted)
            check('events: exactly one row marked', s.markedRows === 1, String(s.markedRows))
            await shot(page, '02-events-panel')
            await page.keyboard.press('Escape')
            await page.waitForTimeout(400)
            check('events: Esc closes', !(await panelState(page)).open)
        } else check('events: a name to open', false, 'event had no names')
    } else check('events: an event to open', false, 'no runs in the window')

    // Analyst companies → first thesis.
    await openDesk(page, 'Analyst companies')
    const cov = page.locator('.floor-desk--open .floor-row[aria-haspopup="dialog"]').first()
    if (await cov.count()) {
        await cov.click()
        await page.waitForTimeout(800)
        const s = await panelState(page)
        console.log('coverage:', JSON.stringify(s))
        check('coverage: docks over the chat column', s.mode === 'docked' && s.coversChat)
        await shot(page, '03-coverage-panel')
        await cov.click()   // the same row closes it
        await page.waitForTimeout(400)
        check('coverage: the row closes it', !(await panelState(page)).open)
    } else console.log('coverage: none for this user — skipped')

    // Forecasts → Assessed, Themes, Structure.
    await openDesk(page, 'Forecasts')
    for (const tab of ['Assessed', 'Themes', 'Structure']) {
        await page.getByRole('tab', { name: tab }).click()
        await page.waitForTimeout(1200)
        const line = page.locator('.industry-view__line[aria-haspopup="dialog"]').first()
        if (!(await line.count())) { console.log(`${tab}: no rows — skipped`); continue }
        await line.click()
        await page.waitForTimeout(800)
        const s = await panelState(page)
        console.log(`${tab}:`, JSON.stringify(s))
        check(`${tab}: docks over the chat column`, s.mode === 'docked' && s.coversChat)
        await shot(page, `04-forecasts-${tab.toLowerCase()}`)
    }
    // Leaving the desk takes the panel with it.
    await openDesk(page, 'Forecasts')
    await page.waitForTimeout(400)
    check('closing the desk closes the panel', !(await panelState(page)).open)
    await ctx.close()

    // ── tablet, touch ─────────────────────────────────────────────────────────
    const tctx = await browser.newContext({ viewport: { width: 1024, height: 1366 }, hasTouch: true, isMobile: true })
    const tp = await tctx.newPage()
    tp.on('pageerror', e => errors.push(`PAGEERROR(tablet) ${e.message.slice(0, 200)}`))
    await signIn(tp)
    await tp.evaluate(() => localStorage.setItem('design', 'floor'))
    await tp.reload({ waitUntil: 'domcontentloaded' })
    await tp.waitForTimeout(3500)
    await openDesk(tp, 'Forecasts')
    await tp.getByRole('tab', { name: 'Structure' }).click()
    await tp.waitForTimeout(1000)
    const tline = tp.locator('.industry-view__line[aria-haspopup="dialog"]').first()
    // The board loads 163 industries; on a cold dev server that outlasts a fixed wait.
    await tline.waitFor({ timeout: 20_000 }).catch(() => {})
    if (await tline.count()) {
        await tline.click()
        await tp.waitForTimeout(800)
        const s = await panelState(tp)
        console.log('tablet:', JSON.stringify(s))
        check('tablet: a full-screen page', s.mode === 'page', s.mode)
        await shot(tp, '05-tablet-page')
        await tp.goBack()
        await tp.waitForTimeout(600)
        check('tablet: back closes it', !(await panelState(tp)).open)
        check('tablet: back stayed in the app', tp.url().startsWith(BASE), tp.url())
    } else { await shot(tp, '05-tablet-no-row'); check('tablet: a Forecasts row', false, 'desk not reachable at this width') }
    await tctx.close()
} finally {
    await browser.close()
    const db = await getDb()
    const u = await db.collection('users').findOne({ username: USER.username })
    if (u) {
        await db.collection('token_usage').deleteMany({ userId: u.id })
        await db.collection('users').deleteOne({ _id: u._id })
        console.log('qa user removed')
    }
    await closeDb()
    console.log('\n' + results.join('\n'))
    if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '))
}
