// The screens the whole-app drive walks, in order. NO agent turns: nothing here types into the chat
// or presses a suggestion chip. Each step gets a `t` toolkit from the runner (drive-all.mjs):
//   t.page                the one page (one sign-in per run — the auth limiter counts every page load)
//   t.check(ok, what)     a functional expectation; a false one fails the step
//   t.note(text)          a line in the report
//   t.warn(kind, msg, where)  a design/UX finding found by hand (not a failure)
//   t.capture(name)       an extra screenshot + audit inside a step (a sub-screen: a tab, a row's detail)
//   t.popup(fn)           run `fn`, capture the window it opens, close it
// After `run` returns the runner screenshots and audits the screen itself.
//
// Selectors are the app's own class names (see the botmarket-frontend components); when a step
// cannot find one it fails with the name, which is the signal the screen changed.

export const DESKS = ['Positions', 'Awaiting orders', 'Your trades', 'Your portfolios', 'Hotlist', 'Calendar', 'Forecasts']
const WORKSPACES = ['LIVE', 'PAPER', 'MANUAL']

const PAUSE = 1200
const wait = (t, ms = PAUSE) => t.page.waitForTimeout(ms)
const visible = (loc) => loc.first().isVisible().catch(() => false)
const panel = (t) => t.page.locator('.detail-panel')
const panelTitle = async (t) => (await t.page.locator('.detail-panel').first().locator('header, [class*="__title"], h1, h2').first().innerText().catch(() => '')).trim()

async function openDesk(t, name) {
    const head = t.page.locator('.floor-desk__head', { hasText: name }).first()
    t.check(await visible(head), `the menu lists "${name}"`)
    await head.click()
    await wait(t, 1800)
    t.check(await visible(panel(t)), `"${name}" opens on the stage`)
}

async function closePanel(t) {
    const x = t.page.locator('.detail-panel__close').first()
    if (await visible(x)) {
        await x.click()
        await wait(t, 600)
        t.check(!(await visible(panel(t))), 'the close button takes the panel off the stage')
    }
}

async function clickAll(t, locator, label, { max = 8, after } = {}) {
    const n = Math.min(await locator.count(), max)
    for (let i = 0; i < n; i++) {
        const b = locator.nth(i)
        if (!(await b.isVisible().catch(() => false))) continue
        const text = (await b.innerText().catch(() => '')).trim().replace(/\s+/g, ' ') || `#${i + 1}`
        await b.click()
        await wait(t)
        if (after) await after(text)
        await t.capture(`${label} ${text}`)
    }
    return n
}

export const STEPS = [
    // ───────────────────────── desktop ─────────────────────────
    { name: 'Home', viewport: 'desktop', async run(t) {
        const p = t.page
        t.check(await visible(p.locator('.app-header-axl__brand')), 'the header shows the brand')
        for (const w of WORKSPACES) t.check(await visible(p.locator('.app-header-axl__mode', { hasText: w })), `workspace switch "${w}" is in the header`)
        t.check(await visible(p.locator('.app-header-axl__chat')), 'Messages button in the header')
        t.check(await visible(p.locator('.app-header-axl__profile')), 'profile button in the header')
        for (const d of DESKS) t.check(await visible(p.locator('.floor-desk__head', { hasText: d })), `menu item "${d}"`)
        t.check(await visible(p.locator('.chat-timeline textarea')), 'the chat input is there')
        t.check(await visible(p.locator('.floor-info')), 'the Info column is there')
        t.check(await p.locator('.suggestion-chips__chip').count() > 0, 'suggestion chips on the empty chat')
    } },

    { name: 'Positions', viewport: 'desktop', async run(t) {
        await openDesk(t, 'Positions')
        const rows = await panel(t).locator('.floor-row').count()
        const text = await panel(t).innerText()
        t.check(rows > 0 || /no open positions/i.test(text), `positions listed (${rows}) or the empty state says so`)
    } },

    { name: 'Awaiting orders', viewport: 'desktop', async run(t) {
        await openDesk(t, 'Awaiting orders')
        const rows = await panel(t).locator('.floor-row').count()
        const text = (await panel(t).innerText()).trim()
        t.check(rows > 0 || /no |nothing|empty/i.test(text), `orders listed (${rows}) or an empty state is shown`)
    } },

    { name: 'Your trades', viewport: 'desktop', async run(t) {
        await openDesk(t, 'Your trades')
        const rows = panel(t).locator('.floor-row')
        const n = await rows.count()
        t.note(`${n} trades in this workspace`)
        const sort = panel(t).locator('select').first()
        if (await visible(sort)) {
            const options = await sort.locator('option').allInnerTexts()
            for (const o of options.slice(1)) { await sort.selectOption({ label: o }); await wait(t, 500); await t.capture(`sorted by ${o}`) }
            await sort.selectOption({ index: 0 })
        }
        if (n > 0) {
            await t.popup(() => rows.first().click(), 'trade window')
        } else {
            t.check(/no |nothing|empty/i.test(await panel(t).innerText()), 'an empty state when there are no trades')
        }
    } },

    { name: 'Your portfolios', viewport: 'desktop', async run(t) {
        await openDesk(t, 'Your portfolios')
        const rows = panel(t).locator('.floor-row')
        const n = await rows.count()
        t.note(`${n} portfolio rows`)
        if (n > 0) {
            await rows.first().click()
            await wait(t)
            t.check(await rows.count() > n, 'a portfolio row opens its holdings')
        }
    } },

    { name: 'Hotlist', viewport: 'desktop', async run(t) {
        await openDesk(t, 'Hotlist')
        const tabs = t.page.locator('.hot-horizons button')
        t.check(await tabs.count() > 0, 'the hotlist shows its horizons')
        await clickAll(t, tabs, 'horizon', { after: async (label) => {
            const body = panel(t)
            const ok = await body.locator('tr.hot-row, .hot-record, .fm-co, .hot-note, table').count() > 0 || (await body.innerText()).trim().length > 40
            t.check(ok, `horizon "${label}" shows a list or a note`)
        } })
        await tabs.first().click(); await wait(t)
        const prev = t.page.getByRole('button', { name: 'The day before' })
        if (await visible(prev)) {
            await prev.click(); await wait(t); await t.capture('the day before')
            const next = t.page.getByRole('button', { name: 'The day after' })
            if (await next.isEnabled().catch(() => false)) { await next.click(); await wait(t) }
        }
        // back to a list with rows, open one
        const thisWeek = tabs.filter({ hasText: /This week/ })
        if (await visible(thisWeek)) { await thisWeek.first().click(); await wait(t) }
        const row = t.page.locator('.hot-panel tr.hot-row').first()
        if (await visible(row)) {
            await row.click()
            await wait(t, 2500)
            t.check(await visible(t.page.getByRole('button', { name: /Back to the list/ })), 'a hotlist row opens the name')
            t.check(await t.page.locator('.detail-panel canvas').count() > 0, 'the name page draws a chart')
            await t.capture('a name')
            await t.page.getByRole('button', { name: /Back to the list/ }).click()
            await wait(t)
            t.check(await visible(t.page.locator('.hot-horizons')), 'Back returns to the list')
        } else t.note('no hotlist row to open on this horizon today')
    } },

    { name: 'Calendar', viewport: 'desktop', async run(t) {
        await openDesk(t, 'Calendar')
        const title0 = await panelTitle(t)
        const next = t.page.getByRole('button', { name: 'Next month' })
        if (t.check(await visible(next), 'the calendar has month navigation')) {
            await next.click(); await wait(t)
            t.check((await panelTitle(t)) !== title0, `next month changes the title (${title0} → ${await panelTitle(t)})`)
            await t.capture('next month')
            await t.page.getByRole('button', { name: 'Previous month' }).click(); await wait(t)
            t.check((await panelTitle(t)) === title0, 'previous month comes back')
        }
        const day = t.page.locator('button.cal-cell:not(.cal-cell--quiet):not(.cal-cell--out)').first()
        if (await visible(day)) {
            await day.click(); await wait(t)
            t.check(/day|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(await panelTitle(t)), `a day opens its page (${await panelTitle(t)})`)
            await t.capture('a day')
            const nextDay = t.page.getByRole('button', { name: 'Next day' })
            if (await visible(nextDay)) { await nextDay.click(); await wait(t); await t.capture('the next day') }
            const back = t.page.locator('.detail-panel .cal-nav__btn', { hasText: /^‹ / }).first()
            if (t.check(await visible(back), 'a day page has a way back to the month')) { await back.click(); await wait(t) }
        } else t.note('no day cell found to open')
    } },

    { name: 'Forecasts', viewport: 'desktop', async run(t) {
        await openDesk(t, 'Forecasts')
        // The map reads four sources (~1.7 s on the M0, was 7–9 s before 2026-11-18): wait for the tiles, then say how long.
        const t0 = Date.now()
        const tiles = await t.page.locator('.fm-tile').first().waitFor({ timeout: 15_000 }).then(() => true, () => false)
        t.check(tiles, `the forecast map has tiles${tiles ? ` (${((Date.now() - t0) / 1000 + 1.8).toFixed(1)}s after the click)` : ' within 15s'}`)
        const ranges = panel(t).locator('.cal-nav__btn').filter({ hasText: /^(1m|3m|12m|24m)$/ })
        t.check(await clickAll(t, ranges, 'range') === 4, 'the map offers 1m · 3m · 12m · 24m')
        const filters = panel(t).locator('button').filter({ hasText: /^(All|For swing|For long term|Watch|Avoid)$/ })
        await clickAll(t, filters, 'filter')
        if (await visible(filters.first())) { await filters.first().click(); await wait(t) }
        const map = t.page.getByRole('button', { name: '‹ Map' })
        if (await visible(map)) { await map.click(); await wait(t) }   // the Board range can leave a detail open
        const tile = t.page.locator('.fm-tile').first()
        if (await visible(tile)) {
            await tile.click(); await wait(t, 1800)
            t.check(await visible(t.page.getByRole('button', { name: '‹ Map' })), 'a tile opens its industry')
            await t.capture('an industry')
            await t.page.getByRole('button', { name: '‹ Map' }).click(); await wait(t)
        }
        const board = panel(t).locator('.cal-nav__btn', { hasText: /^Board$/ })
        if (await visible(board)) {
            await board.click(); await wait(t, 1800)
            t.check(await visible(panel(t)), 'Board opens the forecast board')
            await t.capture('board')
        }
        await closePanel(t)
    } },

    { name: 'History', viewport: 'desktop', async run(t) {
        await closePanel(t)
        await t.page.getByRole('button', { name: 'History' }).click()
        await wait(t)
        const dlg = t.page.locator('.chat-timeline__history')
        t.check(await visible(dlg), 'History opens the past sessions')
        t.note(`${await t.page.locator('.chat-timeline__history-item').count()} past sessions`)
        await t.capture('open')
        await t.page.locator('.chat-timeline__history-close').click()
        await wait(t, 600)
        t.check(!(await visible(dlg)), 'History closes')
    } },

    { name: 'Messages', viewport: 'desktop', async run(t) {
        await t.page.locator('.app-header-axl__chat').click()
        await wait(t)
        const drawer = t.page.locator('.social-chat__topbar')
        t.check(await visible(drawer), 'Messages opens')
        const conv = t.page.locator('.social-chat__conv-item').first()
        if (await visible(conv)) { await conv.click(); await wait(t, 1800); await t.capture('a conversation') }
        await t.page.keyboard.press('Escape'); await wait(t, 500)
        if (await visible(drawer)) t.warn('keyboard', 'Escape does not close Messages (it closes History)', 'div.social-chat')
        if (await visible(drawer)) await t.page.locator('.social-chat__topbar-close').first().click()
        await wait(t, 600)
        t.check(!(await visible(drawer)), 'the close button closes Messages')
    } },

    { name: 'Workspaces', viewport: 'desktop', async run(t) {
        const p = t.page
        const active = async () => (await p.locator('.app-header-axl__mode.is-active').first().innerText().catch(() => '')).trim()
        const start = await active()
        t.note(`started in ${start || '?'}`)
        for (const w of WORKSPACES) {
            await p.locator('.app-header-axl__mode', { hasText: w }).click()
            await wait(t, 1500)
            t.check((await active()) === w, `${w} becomes the active workspace`)
            const counts = await p.locator('.floor-desk__head').allInnerTexts()
            t.note(`${w}: ${counts.map(c => c.replace(/\s+/g, ' ')).join(' · ')}`)
            await openDesk(t, 'Your trades')
            await t.capture(`${w} trades`)
            await closePanel(t)
        }
        if (start) await p.locator('.app-header-axl__mode', { hasText: start }).click()
        await wait(t)
    } },

    { name: 'Info', viewport: 'desktop', async run(t) {
        const more = t.page.locator('.floor-info__more summary').first()
        await openDesk(t, 'Hotlist')
        if (await visible(more)) {
            await more.click(); await wait(t, 600)
            t.check(await t.page.locator('.floor-info__more[open]').count() > 0, 'Info "More" opens')
        } else t.note('no "More" in Info on this desk')
        await closePanel(t)
    } },

    { name: 'Profile', viewport: 'desktop', async run(t) {
        const p = t.page
        await p.locator('.app-header-axl__profile').click()
        await wait(t, 1500)
        t.check(/\/profile/.test(p.url()), `the profile button opens /profile (${p.url()})`)
        const items = p.locator('.user-profile__nav-item')
        t.check(await items.count() >= 8, `the profile lists its sections (${await items.count()})`)
        await clickAll(t, items, 'section', { max: 12, after: async (label) => {
            t.check(await p.locator('.user-profile__nav-item.is-active', { hasText: label }).count() > 0, `"${label}" becomes the open section`)
        } })
        await p.locator('.app-header-axl__brand').click()
        await wait(t, 1500)
        t.check(!/\/profile/.test(p.url()), 'the brand goes back home')
        t.check(await visible(p.locator('.chat-timeline textarea')), 'home is back with the chat')
    } },

    // ───────────────────────── laptop ─────────────────────────
    { name: 'Laptop home', viewport: 'laptop', async run(t) {
        t.check(await visible(t.page.locator('.chat-timeline textarea')), 'the chat fits on a laptop screen')
        await openDesk(t, 'Hotlist')
        await t.capture('hotlist')
        await openDesk(t, 'Forecasts')
        await t.capture('forecasts')
        await closePanel(t)
    } },

    // ───────────────────────── phone ─────────────────────────
    { name: 'Phone home', viewport: 'phone', async run(t) {
        const p = t.page
        const drawerClose = p.locator('.social-chat__topbar-close')
        if (await visible(drawerClose)) { t.note('Messages was open on arrival — closed it'); await drawerClose.first().click(); await wait(t) }
        t.check(await visible(p.locator('.app-header-axl__burger')), 'the phone header has the menu button')
        t.check(await visible(p.locator('.chat-timeline textarea')), 'the chat input is there on a phone')
    } },

    { name: 'Phone info', viewport: 'phone', async run(t) {
        await t.page.getByRole('button', { name: 'Info', exact: true }).click()
        await wait(t)
        t.check(await visible(t.page.locator('.chat-info')), 'Info opens on a phone')
        await t.capture('open')
        await t.page.getByRole('button', { name: 'Info', exact: true }).click().catch(() => {})
        await t.page.keyboard.press('Escape')
        await wait(t, 600)
    } },

    { name: 'Phone menu', viewport: 'phone', async run(t) {
        const p = t.page
        await p.locator('.app-header-axl__burger').click()
        await wait(t)
        await t.capture('open')
        const item = (d) => p.locator('.app-header-axl__list', { hasText: d }).first()
        const listed = await p.locator('.app-header-axl__list').allInnerTexts()
        t.check(DESKS.every(d => listed.some(x => x.includes(d))), `the phone menu lists every desk (${listed.join(' · ')})`)
        for (const d of ['Your trades', 'Hotlist', 'Calendar', 'Forecasts']) {
            if (!(await visible(item(d)))) { await p.locator('.app-header-axl__burger').click(); await wait(t) }
            const head = item(d)
            if (!(await visible(head))) { t.check(false, `"${d}" in the phone menu`); continue }
            await head.click()
            await wait(t, 1800)
            t.check(await visible(panel(t)) || await visible(p.locator('.side-pane--sheet')), `"${d}" opens on a phone`)
            await t.capture(d)
            const close = p.locator('.detail-panel__close, .side-pane--sheet button[aria-label*="Close"]').first()
            if (await visible(close)) { await close.click(); await wait(t, 800) }
        }
    } },

    { name: 'Phone messages', viewport: 'phone', async run(t) {
        const p = t.page
        const burger = p.locator('.app-header-axl__burger')
        await burger.click(); await wait(t)
        const msgs = p.locator('.app-header-axl__chat')
        if (await visible(msgs)) {
            await msgs.click(); await wait(t)
            t.check(await visible(p.locator('.social-chat__topbar')), 'Messages opens on a phone')
            await t.capture('open')
            await p.locator('.social-chat__topbar-close').first().click(); await wait(t, 600)
        } else t.check(false, 'Messages is reachable from the phone menu')
    } },
]
