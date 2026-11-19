import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measure, day0Index, sectorEtf, windowFor, eventReturns, unfinishedSession, _setDeps, HORIZONS } from '../../services/echoReturns.service.js'

// Echo's return calculator (docs/design/echo-pipeline.md Steps 4 and 7), ported from the engine's echo/returns.py.

// 30 sessions, weekdays from 2026-10-01; prices that make the arithmetic readable.
const SESSIONS = []
for (let d = new Date('2026-10-01T00:00:00Z'); SESSIONS.length < 30; d = new Date(d.getTime() + 86_400_000)) {
    if (d.getUTCDay() % 6) SESSIONS.push(d.toISOString().slice(0, 10))
}
const flat = (px, vol = 100) => Object.fromEntries(SESSIONS.map(d => [d, { open: px, high: px, low: px, close: px, volume: vol }]))
const EV = (o) => ({ id: 'e', date: SESSIONS[22], timing: 'after_close', ...o })   // Day 0 = SESSIONS[23]

test('Day 0: before the open is that day; during or after, the next session; a weekend rolls on', () => {
    assert.equal(SESSIONS[day0Index(EV({ timing: 'before_open' }), SESSIONS)], SESSIONS[22])
    assert.equal(SESSIONS[day0Index(EV({ timing: 'after_close' }), SESSIONS)], SESSIONS[23])
    assert.equal(SESSIONS[day0Index(EV({ timing: 'during_session' }), SESSIONS)], SESSIONS[23])
    assert.equal(SESSIONS[day0Index({ date: '2026-10-03', timing: 'before_open' }, SESSIONS)], '2026-10-05', 'a Saturday → Monday')
    assert.equal(day0Index({ date: '2027-01-01', timing: 'before_open' }, SESSIONS), null)
})

test('reaction from the last close before, tradable from the Day 0 open, both over SPY and the sector', () => {
    const name = flat(100)
    const d0 = SESSIONS[23], d4 = SESSIONS[27]
    name[d0] = { open: 110, high: 112, low: 108, close: 111, volume: 300 }       // a 10% gap
    for (const d of SESSIONS.slice(24)) name[d] = { open: 120, high: 120, low: 120, close: 120, volume: 200 }
    const spy = flat(400), xlk = flat(50)
    for (const d of SESSIONS.slice(23)) { spy[d] = { ...spy[d], close: 404 }; xlk[d] = { ...xlk[d], close: 51 } }
    const r = measure(EV(), 'JBL', { JBL: name, SPY: spy, XLK: xlk }, SESSIONS, 'XLK', [1, 5])
    assert.equal(r.day0, d0)
    assert.equal(r.base, SESSIONS[22])
    assert.ok(Math.abs(r.gap - 0.10) < 1e-9)
    assert.ok(Math.abs(r.horizons[1].reaction - 0.11) < 1e-9, 'day 1 = Day 0 close over the close before')
    assert.ok(Math.abs(r.horizons[1].tradable - (111 / 110 - 1)) < 1e-9)
    assert.ok(Math.abs(r.horizons[5].reaction - 0.20) < 1e-9, `day 5 ends on ${d4}`)
    assert.ok(Math.abs(r.horizons[5].xsSpyReaction - (0.20 - 0.01)) < 1e-9)
    assert.ok(Math.abs(r.horizons[5].xsSectorReaction - (0.20 - 0.02)) < 1e-9)
    assert.ok(Math.abs(r.volume[1] - 3) < 1e-9, 'Day 0 volume 300 against 100 a day before')
    assert.ok(Math.abs(r.volume[5] - (300 + 4 * 200) / 5 / 100) < 1e-9)
    assert.deepEqual(r.missing, [])
})

test('during the session: the base is the session before that day, its own close came after the news', () => {
    const r = measure(EV({ timing: 'during_session' }), 'X', { X: flat(10), SPY: flat(400) }, SESSIONS, null, [1])
    assert.equal(r.base, SESSIONS[21])
})

test('strict: a halted Day 0 gives nothing; a suspect open gives the reaction only; the calendar end says so', () => {
    const halted = flat(10); delete halted[SESSIONS[23]]
    const a = measure(EV(), 'H', { H: halted, SPY: flat(400) }, SESSIONS, null, [1])
    assert.equal(a.horizons[1].reaction, null)
    assert.match(a.missing[0], /no H bar on Day 0/)
    const suspect = flat(10); suspect[SESSIONS[23]] = { open: 11, high: 11, low: 11, close: 11, volume: 50 }
    const b = measure(EV(), 'S', { S: suspect, SPY: flat(400) }, SESSIONS, null, [1])
    assert.equal(b.horizons[1].tradable, null)
    assert.ok(Math.abs(b.horizons[1].reaction - 0.1) < 1e-9)
    const c = measure(EV(), 'S', { S: flat(10), SPY: flat(400) }, SESSIONS, null, [60])
    assert.equal(c.horizons[60].reaction, null)
    assert.match(c.missing.at(-1), /60d: the calendar ends before it/)
})

test('sector funds and the window', () => {
    assert.equal(sectorEtf('Technology'), 'XLK')
    assert.equal(sectorEtf('Consumer Cyclical'), 'XLY')
    assert.equal(sectorEtf('Unknown'), null)
    assert.deepEqual(windowFor({ date: '2026-11-12' }, new Date('2026-11-19T00:00:00Z')), { from: '2026-10-03', to: '2026-11-19' })
    assert.deepEqual(HORIZONS, [1, 5, 20, 60, 120])
})

test('eventReturns: SPY is the calendar; another symbol failing costs only that symbol', async () => {
    _setDeps({ now: () => new Date('2026-11-20T00:00:00Z'), bars: async (s) => {
        if (s === 'SPY') return flat(400)
        if (s === 'BAD') throw new Error('FMP 500')
        return flat(10)
    } })
    const { rows } = await eventReturns(EV(), ['JBL', 'BAD'], { JBL: 'XLK' })
    assert.ok(!rows[0].missing.some(m => /prices failed/.test(m)), rows[0].missing.join('; '))
    assert.ok(Number.isFinite(rows[0].horizons[1].reaction))
    assert.match(rows[1].missing[0], /^BAD prices failed — FMP 500/)
    _setDeps({ bars: async () => ({}) })
    await assert.rejects(eventReturns(EV(), ['JBL']), /calendar is empty/)
})

test("today's bar is no close until 16:15 New York time", async () => {
    assert.equal(unfinishedSession(new Date('2026-11-19T20:00:00Z')), '2026-11-19', '15:00 ET — trading')
    assert.equal(unfinishedSession(new Date('2026-11-19T21:30:00Z')), null, '16:30 ET — closed')
    const last = SESSIONS.at(-1)
    _setDeps({ now: () => new Date(`${last}T18:00:00Z`), bars: async () => flat(10) })
    const { sessions } = await eventReturns(EV(), ['JBL'])
    assert.ok(!sessions.includes(last), 'the session in progress is not in the calendar')
    _setDeps({ now: () => new Date(`${last}T22:00:00Z`) })
    assert.ok((await eventReturns(EV(), ['JBL'])).sessions.includes(last))
})
