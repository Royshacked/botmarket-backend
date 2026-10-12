// DRIVE THE ACTUAL BOARD — Pythia's assessments ("Assessed" on the Forecasts tab), in a real browser
// (docs/design/pythia-assessment.md, build step 1).
//
//   node scripts/drive-assessment-ui.mjs [baseUrl] [outDir]
//
// As a TRADER, then as an ADMIN (throwaway users, deleted at the end): the Assessed tab — the track record,
// the verdict groups, a row opened (cause, move, base rate, evidence, gaps, risks) — and, for the admin
// only, the "Assess now" control, which is NOT clicked (it spends a model run). Reads the LIVE route, so the
// backend must be running this code. LOOK at the screenshots.
import dns from 'dns'
import 'dotenv/config'
import { chromium } from 'playwright'

const [BASE = 'http://localhost:5173', OUT = '.'] = process.argv.slice(2)
const USERS = [
    { username: 'ui-smoke-assess-t', fullname: 'UI Smoke Trader', password: 'Sm0ke!Drive#41', role: 'trader' },
    { username: 'ui-smoke-assess-a', fullname: 'UI Smoke Admin', password: 'Sm0ke!Drive#42', role: 'admin' },
]

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { userService } = await import('../api/user/user.service.js')

const shot = async (page, name) => {
    await page.screenshot({ path: `${OUT}/assess-${name}.png`, fullPage: false })
    console.log('  shot:', name)
}

async function signIn(page, user) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    const inputs = page.locator('input')
    if (await inputs.count()) {
        await inputs.nth(0).fill(user.username)
        await inputs.nth(1).fill(user.password)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(3500)
    }
}

const db = await getDb()
console.log(`assessments in this database: ${await db.collection('industry_assessment').countDocuments()}; calls: ${await db.collection('pythia_calls').countDocuments()}`)
for (const u of USERS) {
    try { await userService.createUser(u); console.log(`qa user ${u.username} created`) } catch (e) { console.log(`qa user ${u.username} exists —`, e.message) }
    await db.collection('users').updateOne({ username: u.username }, { $set: { role: u.role } })
}

const browser = await chromium.launch({ channel: 'msedge' })
const errors = []
try {
    for (const user of USERS) {
        console.log(`\n── as ${user.role} ──`)
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
        const page = await ctx.newPage()
        page.on('pageerror', e => errors.push(`${user.role} PAGEERROR ${e.message.slice(0, 200)}`))
        page.on('console', m => { if (m.type() === 'error') errors.push(`${user.role} ${m.text().slice(0, 200)}`) })
        const statuses = []
        page.on('response', async r => {
            // Any failed board read is named: an empty `industries` silently hides the admin's Assess now.
            if (r.url().includes('/api/') && r.status() >= 400) errors.push(`${user.role} ${r.status()} ${new URL(r.url()).pathname}`)
            if (!r.url().includes('/api/strategy/assessments')) return
            const body = await r.text().catch(() => '')
            statuses.push(`${r.status()} ${(r.headers()['content-type'] ?? '').split(';')[0]} ${body.slice(0, 80).replace(/\s+/g, ' ')}`)
        })
        await signIn(page, user)

        await page.getByRole('button', { name: /Forecasts/ }).first().click()
        await page.waitForTimeout(2500)
        console.log('GET /api/strategy/assessments →', statuses.join(', ') || '(not requested)')
        await page.getByRole('tab', { name: 'Assessed' }).click()
        // 165 assessments are ~790 KB, ~9 s from Atlas to the laptop (2026-10-11): wait for them, not a fixed beat.
        await page.locator('.assessment-view__group').first().waitFor({ timeout: 30000 }).catch(() => {})
        await page.waitForTimeout(800)
        await shot(page, `${user.role}-01-assessed`)
        console.log('record:', (await page.locator('.assessment-view__record').innerText()).replace(/\n+/g, ' | '))
        console.log('summary:', await page.locator('.assessment-view .industry-view__summary-bar').innerText())
        console.log('groups:', (await page.locator('.assessment-view__group').allInnerTexts()).join(' | '))
        console.log('verdict chips:', (await page.locator('.assessment-view__verdict').allInnerTexts()).join(', '), '· hype chips:', await page.locator('.assessment-view__hype').count())
        // The industries list takes ~8s cold (163 rows read from the engine db); Assess now waits for it.
        if (user.role === 'admin') await page.locator('.assessment-view__assess').waitFor({ timeout: 30000 }).catch(() => {})
        console.log('Assess now control visible:', await page.getByRole('button', { name: 'Assess now' }).count() === 1,
            '· industries in its list:', Math.max(0, (await page.locator('.assessment-view__assess select option').count()) - 1))

        // The week (step 6): the change scan's headline and, for an admin only, the run button — NOT clicked.
        console.log('tabs:', (await page.getByRole('tab').allInnerTexts()).join(' | '))
        console.log('week:', (await page.locator('.assessment-view__week-head').innerText().catch(() => '(none)')).replace(/\n+/g, ' | '))
        console.log('Run the week visible:', await page.getByRole('button', { name: /Run the week/ }).count() === 1)

        // OPEN_ROW=<name> opens that industry's row instead of the first (e.g. one carrying step 8's money rows).
        const all = page.locator('.assessment-view .industry-view__line')
        const rows = process.env.OPEN_ROW ? all.filter({ hasText: process.env.OPEN_ROW }) : all
        if (await rows.count()) {
            await rows.first().scrollIntoViewIfNeeded()
            await rows.first().click()
            await page.waitForTimeout(700)
            await page.locator('.industry-view__row--open').first().scrollIntoViewIfNeeded()
            await shot(page, `${user.role}-02-row-open`)
            console.log('open row:', (await page.locator('.industry-view__row--open .industry-view__detail').innerText()).slice(0, 1600).replace(/\n+/g, ' | '))
        }
        // Themes (step 3): the list, one opened, and — for an admin only — the approve control (NOT clicked).
        await page.getByRole('tab', { name: 'Themes' }).click()
        await page.waitForTimeout(800)
        await shot(page, `${user.role}-03-themes`)
        console.log('themes summary:', (await page.locator('.themes-view .industry-view__summary-bar').innerText()).replace(/\n+/g, ' | '))
        console.log('theme rows:', (await page.locator('.themes-view .industry-view__name').allInnerTexts()).join(' | '))
        console.log('Propose themes visible:', await page.getByRole('button', { name: 'Propose themes' }).count() === 1)
        const themeRows = page.locator('.themes-view .industry-view__line')
        if (await themeRows.count()) {
            await themeRows.first().click()
            await page.waitForTimeout(600)
            await shot(page, `${user.role}-04-theme-open`)
            console.log('theme open:', (await page.locator('.themes-view .industry-view__row--open .industry-view__detail').innerText()).slice(0, 700).replace(/\n+/g, ' | '))
            console.log('Approve visible:', await page.getByRole('button', { name: 'Approve' }).count() > 0)
        }
        await page.getByRole('tab', { name: 'Assessed' }).click()
        await page.waitForTimeout(400)
        await page.getByLabel('Find an industry').fill('zzz-none')
        await page.waitForTimeout(400)
        console.log('search with no match:', await page.locator('.assessment-view .news-feed__empty').innerText().catch(() => '(none)'))
        await ctx.close()
    }
} finally {
    await browser.close()
    for (const u of USERS) {
        const doc = await db.collection('users').findOne({ username: u.username })
        if (doc) {
            await db.collection('token_usage').deleteMany({ userId: doc._id })
            await db.collection('users').deleteOne({ _id: doc._id })
            console.log(`qa user ${u.username} removed`)
        }
    }
    await closeDb()
    if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '))
}
