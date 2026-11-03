// DRIVE THE THESIS LENS'S FOLLOW-UPS (Roy, 2026-11-02; docs/design/thesis-lens-followups.md).
//
//   G. GNRC, typed bare name → risk-based. The structure stop under the last swing low, and the DEEPER stop OFFERED
//      with the date price last traded under it. Taking it → the break scenario B is offered (the break changes the
//      stop). Limits, size, wait, the runaway answer → the worksheet: every scenario has a validity range + on_away,
//      B carries a latching arming condition.
//   N. NXST, buyers already in control, built straight through → one scenario, its away edge at the recent high, the
//      runaway question asked (never filled in).
//
// What a turn ran is read from logs/backend.log (`[mentorAgent] chatStream done`), what it built from the session.
// Each Mentor reply is printed in full so the judgment calls can be read, not only counted.
//
//   node scripts/drive-thesis-followups.mjs [baseUrl] [outDir]
//
// Against the Vite dev server (:5173) as `ui-smoke`, on FRESH sessions (deleted after). Nothing is generated.
// Real model spend: about nine Mentor turns. One sign-in.
import dns from 'dns'
import { readFileSync, statSync } from 'fs'
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT  = process.argv[3] ?? '.'
const LOG  = 'logs/backend.log'
const USER = { username: 'ui-smoke', fullname: 'UI Smoke', password: 'Sm0ke!Drive#29' }

dns.setServers(['8.8.8.8', '1.1.1.1'])

const { userService } = await import('../api/user/user.service.js')
const { getDb, closeDb } = await import('../providers/mongodb.provider.js')
const { sessionService } = await import('../services/session.service.js')
const { setupReadiness } = await import('../services/setup.schema.js')
const { priceStructureText } = await import('../services/tools/thesisStructure.tools.js')
const { getTickerAggregates } = await import('../providers/candles.provider.js')

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/thesis-${name}.png`, fullPage: false }); console.log('  shot:', name) }
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

let logAt = statSync(LOG).size
function turnsLogged() {
    const buf = readFileSync(LOG)
    const fresh = buf.subarray(logAt).toString('utf8')
    logAt = buf.length
    return fresh.split('\n')
        .filter(l => l.includes('[mentorAgent] | chatStream done | '))
        .map(l => { try { return JSON.parse(l.slice(l.indexOf('chatStream done | ') + 18)) } catch { return null } })
        .filter(Boolean)
}

async function ensureUser() {
    try { await userService.createUser(USER) } catch { /* already there */ }
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

/** Send one message; → { reply (the new timeline text), tools (this turn's) }. */
async function say(page, text) {
    const box = page.locator('.chat-timeline textarea')
    await box.fill(text)
    await box.press('Enter')
    await waitIdle(page, 300000)
    await page.waitForTimeout(1500)
    const all = await page.locator('.chat-timeline').innerText().catch(() => '')
    // The LAST Mentor message only — the timeline re-renders its header, so a prefix diff is unreliable.
    const chunks = all.split(/\nMENTOR\n/)
    const reply = chunks.length > 1 ? chunks.at(-1).replace(/\nAsk Axl instead[\s\S]*$/, '') : ''
    const turns = turnsLogged()
    const tools = turns.flatMap(t => t.tools ?? [])
    console.log(`\n>>> USER: ${text}\n<<< MENTOR [tools: ${tools.join(', ') || '—'}]\n${reply.trim().slice(0, 3500)}\n`)
    return { reply, tools, turn: turns.at(-1) ?? null }
}

const userId = await ensureUser()
const sessions = []
const fresh = async () => {
    const sid = (await sessionService.startNew({ userId })).sessionId
    sessions.push(sid)
    await sessionService.setFloor({ sessionId: sid, userId, agent: 'mentor' })
    return sid
}
const draftOf = async (sid) => (await sessionService.get({ sessionId: sid, userId }))?.agentState?.mentor?.draft ?? null
const scenariosOf = (d) => d?.scenarios ?? []
const describe = (d) => JSON.stringify(scenariosOf(d).map(s => ({
    id: s.id, name: s.name, entry: s.entry_legs?.map(l => l.price), stop: s.stop_legs?.map(l => l.price), target: s.target_legs?.map(l => l.price),
    validity: s.validity, conditions: s.conditions?.map(c => `${c.mode}/${c.persistence}: ${c.text}`),
})))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`))

const reload = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.chat-timeline textarea').waitFor({ timeout: 20000 })
    await page.waitForTimeout(2000)
    turnsLogged()
}

try {
    // ── G. GNRC: the deeper stop offered; taken → B offered ──
    const sidG = await fresh()
    console.log('\nG. GNRC — session', sidG)
    await signIn(page)
    await reload()
    let r = await say(page, 'Build me a swing trade on GNRC.')
    check('G: risk-based', r.turn?.mode === 'thesis', JSON.stringify({ mode: r.turn?.mode, src: r.turn?.modeSource }))
    check('G: the structure is read', r.tools.includes('get_price_structure'))
    // The opening is a gate: direction, horizon, lens, and how far to build. Checkpoints, so every offer is said.
    r = await say(page, 'Yes — long, swing, thesis. Stop at the checkpoints.')

    // Walk the stages, answering EVERY question a reply asks (Mentor often asks several in one), each fact given once,
    // until the worksheet is ready or 12 more turns pass.
    let deepOffered = null, deepTaken = false, bOffered = null, bTaken = false, levelsCalled = 0
    const given = new Set()
    const all = []
    for (let i = 0; i < 12; i++) {
        all.push(r)
        levelsCalled += r.tools.filter(n => n === 'get_entry_level').length
        const text = r.reply, t = text.toLowerCase()
        if (deepOffered == null && /(deep(er)?|wider)\b[^.]{0,30}\bstop|whole fall|under the fall/i.test(text)) deepOffered = text
        if (bOffered == null && deepTaken && /break(out)? (scenario|route)|break, then|second way in|after the break|scenario b\b|\bb [—-] break|\bB (uses|arms|—|:)|breakout/i.test(text)
            && !/not offering|no (separate|distinct) break/i.test(text)) bOffered = text
        const parts = []
        const once = (key, test, words) => { if (!given.has(key) && test) { given.add(key); parts.push(words) } }
        if (!deepTaken && deepOffered) { deepTaken = true; parts.push('I\'ll take the deeper stop — a price it hasn\'t visited for a while.') }
        if (deepTaken && bOffered && !bTaken) { bTaken = true; parts.push('Yes, add the break scenario too.') }
        once('limits', /risk limit|reward[- ]to[- ]risk|r:r|stop distance/.test(t), 'My risk limit is 8% and my minimum reward to risk is 1.5.')
        once('target', /second target|half out|stage half/.test(t), 'One target is fine.')
        once('size', /\bsize\b|how much|risk \$|shares|which unit/.test(t) && /\?/.test(text), 'Risk $200 on it.')
        once('wait', /how long|valid until|expire|wait for the entry/.test(t) && /\?/.test(text), 'Let it wait 30 days.')
        once('away', /just goes|runs? away|ran away|without you|let it go|ping/.test(t), 'If it just goes without me, ping me to redraw it.')
        const d = await draftOf(sidG)
        if (d && setupReadiness(d, true).missing.filter(m => m !== 'trading account').length === 0) break
        r = await say(page, parts.length ? parts.join(' ') : 'Agreed — go on.')
    }
    check('G: the deeper stop is OFFERED', deepOffered != null)
    // Any reply that names the deep stop's price — the first "deeper stop" match can be an earlier reply's echo (drive 8).
    const dated = all.find(x => /17[01]\.\d\d/.test(x.reply) && /feb(ruary)?\s*5|2026-02-05/i.test(x.reply))
    check('G: …with the date price last traded under it (Feb 5, 2026)', dated, (all.find(x => /17[01]\.\d\d/.test(x.reply))?.reply ?? '').slice(0, 300))
    check('G: with the deep stop taken, the break scenario is offered', bOffered != null)
    const readTurn = all.find(x => /risk limit|reward[- ]to[- ]risk|stop distance/i.test(x.reply))
    check('G: before asking the limits, a read of what fits the chart (the normal move)', readTurn && /atr|normal (daily )?moves?|normal (days|weeks)|moves? about|a day\b|daily move/i.test(readTurn.reply), (readTurn?.reply ?? '').slice(0, 400))
    check('G: an entry level per scenario (each on its own stop)', levelsCalled >= 2, `get_entry_level × ${levelsCalled}`)
    await shot(page, 'G1-built')
    let d = await draftOf(sidG)
    console.log('G worksheet:', describe(d))
    const sc = scenariosOf(d)
    check('G: two scenarios on the worksheet', sc.length === 2, `${sc.length}`)
    check('G: every scenario has a validity range with an away answer', sc.length && sc.every(s => s.validity && s.validity.on_away), describe(d).slice(0, 300))
    check('G: B carries a latching arming condition', sc.some(s => (s.conditions ?? []).some(c => c.persistence === 'latching')))
    const stops = sc.map(s => s.stop_legs?.[0]?.price).filter(Number.isFinite)
    check('G: the break changes the stop — B\'s is over A\'s', stops.length === 2 && stops[1] > stops[0], JSON.stringify(stops))
    const ready = d ? setupReadiness(d, true) : null
    check('G: no validity range missing', ready && !ready.missing.some(m => m.startsWith('validity range')), JSON.stringify(ready?.missing))
    await shot(page, 'G3-worksheet')

    // ── N. NXST: buyers in control, straight through → an away edge at the recent high, the runaway asked ──
    const sidN = await fresh()
    console.log('\nN. NXST — session', sidN)
    await reload()
    r = await say(page, 'Build me a swing trade on NXST. My risk limit is 7% and I want at least 1.5 reward to risk. Risk $200, let it wait 30 days. Go all the way.')
    // The turn's log line can land after the reply is read (drive 8: `{}`) — any of N's turns says the mode.
    const nTurns = [r.turn]
    let asked = false
    for (let i = 0; i < 4 && !asked; i++) {
        r = await say(page, i === 0 ? 'Yes — long, swing, thesis. Go all the way.' : 'Agreed — go on.')
        nTurns.push(r.turn)
        asked = /just goes|runs? away|ran away|without you|let it go|ping/i.test(r.reply)
    }
    check('N: risk-based', nTurns.some(t => t?.mode === 'thesis'), JSON.stringify(nTurns.map(t => t?.mode ?? null)))
    check('N: the runaway question is ASKED, not filled in', asked)
    if (asked) r = await say(page, 'If it just goes, ping me to redraw it.')
    d = await draftOf(sidN)
    console.log('N worksheet:', describe(d))
    check('N: one scenario — buyers already control, no break to wait for', scenariosOf(d).length === 1, `${scenariosOf(d).length}`)
    const v = scenariosOf(d)[0]?.validity
    // The recent high moves with the stock (175.93 → 177.03 → 177.66 → 180.96 across drives; live in an open session, so 1%): read it live — the highest high
    // since the last swing low, off the same bars the tool reads.
    const nf = await priceStructureText({ ticker: 'NXST', timeframe: 'day' }).then(t => JSON.parse(t.slice(t.indexOf('{'))))
    const nBars = await getTickerAggregates('NXST', { timeSpan: 'day', multiplier: 1, from: Date.now() - 120 * 86_400_000, to: Date.now() })
    const since = Date.parse(`${nf.last_swing_low?.date}T00:00:00Z`)
    const recentHigh = Math.max(...nBars.filter(b => b.timestamp * 1000 >= since).map(b => b.high))
    check(`N: its away edge sits at the recent high (${recentHigh}), over the price`, v?.approach != null && Math.abs(v.approach - recentHigh) <= recentHigh * 0.01, JSON.stringify(v))
    check('N: the stop is under the higher low (≈161.6), not the fall low', (() => { const s = scenariosOf(d)[0]?.stop_legs?.[0]?.price; return s > 158 && s < 162.52 })(), JSON.stringify(scenariosOf(d)[0]?.stop_legs))
    await shot(page, 'N1-straight-through')
} catch (err) {
    console.error('DRIVE ERROR', err)
    check('the drive ran to the end', false, err.message)
    await shot(page, 'error').catch(() => {})
} finally {
    const db = await getDb()
    for (const sid of sessions) {
        await db.collection('session_messages').deleteMany({ sessionId: sid }).catch(() => {})
        await db.collection('sessions').deleteOne({ sessionId: sid }).catch(() => {})
    }
    if (errors.length) check('no page errors', false, errors.join(' | '))
    await browser.close()
    console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`)
    if (results.some(r => !r.ok)) process.exitCode = 1
    await closeDb()
}
