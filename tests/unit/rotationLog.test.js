import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monthly, pickFor, picksFor, mergeLog, score, MAP } from '../../services/rotationLog.service.js'

// The rotation's forward log (Roy, 2026-10-27: "build the monthly log") — the §29–§31 map graded on new months.

// Months 2019-01 … 2026-12, one session on the 15th; every month's state 'A' except where `states` says. Rule 'good'
// makes +1 a month, 'bad' −1, 'mid' 0 — unless `ret` overrides for a month.
function world({ through = '2026-12', states = {}, ret = {} } = {}) {
    const months = []
    for (let y = 2019; y <= 2026; y++) for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2, '0')}`)
    const live = months.filter(m => m <= through)
    const regimes = live.map(m => ({ day: `${m}-15`, regime: states[m] ?? 'A' }))
    const daily = live.flatMap(m => [['good', 1], ['bad', -1], ['mid', 0], ['zz', 0.5]].map(([rule, r]) => ({ rule, day: `${m}-15`, ret: ret[m]?.[rule] ?? r })))
    return monthly(daily, regimes)
}

test('a month is complete once a session after it is in; its state is the month before’s last evening', () => {
    const v = world({ through: '2026-11', states: { '2026-10': 'B' } })
    assert.equal(v.complete('2026-10'), true)
    assert.equal(v.complete('2026-11'), false, 'the last month with data is in progress')
    assert.equal(v.stateOf('2026-11'), 'B')
    assert.equal(v.stateOf('2026-12'), null, 'November is not over')
    assert.equal(v.all('2026-10'), (1 - 1 + 0 + 0.5) / 4)
})

test('the map: the top K by the state’s mean month; under MIN_STATE months of the state → ALL (null)', () => {
    const v = world()
    assert.deepEqual(pickFor(v, '2026-11', v.months.filter(m => m <= MAP.learnTo)), ['good', 'zz', 'mid'])
    const rare = world({ states: { '2026-10': 'C' } })
    assert.equal(pickFor(rare, '2026-11', rare.months.filter(m => m <= MAP.learnTo)), null, 'no month of state C was learned')
})

test('fixed learns only to 2023-12; expanding from every month before', () => {
    // 'bad' wins every month from 2024 on: only the expanding map can see it.
    const ret = {}
    for (const m of world().months) if (m >= '2024-01') ret[m] = { bad: 9 }
    const v = world({ ret })
    const p = picksFor(v, '2026-11')
    assert.equal(p.fixed[0], 'good')
    assert.equal(p.expanding[0], 'bad')
})

test('the log: rows from LOG_FROM, results once complete, logged picks never rewritten', () => {
    const v1 = world({ through: '2026-12' })
    const { rows } = mergeLog(v1, [], { today: '2026-12-02' })
    assert.deepEqual(rows.map(r => r.month), ['2026-11', '2026-12'])
    assert.equal(rows[0].fixed, '0.50', 'mean of good, zz, mid')
    assert.equal(rows[1].fixed, '', 'December in progress')
    // The data is revised: 'bad' now leads the expanding map — the logged picks stand, the change is reported.
    const ret = {}
    for (const m of world().months) if (m >= '2024-01') ret[m] = { bad: 9 }
    const { rows: again, changed } = mergeLog(world({ through: '2026-12', ret }), rows, { today: '2027-01-05' })
    assert.equal(again[0].expanding_picks, rows[0].expanding_picks)
    assert.equal(again[0].picked_on, '2026-12-02')
    assert.deepEqual(changed, ['2026-11', '2026-12'])
})

test('nothing before LOG_FROM, and the score counts complete months only', () => {
    assert.deepEqual(mergeLog(world({ through: '2026-10' }), [], { today: 'x' }).rows, [])
    const { rows } = mergeLog(world({ through: '2026-12' }), [], { today: 'x' })
    const s = score(rows)
    assert.equal(s.months, 1)
    assert.equal(s.fixedUp, 1)
    assert.equal(score([]), null)
})
