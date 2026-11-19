import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shapeSummary, shapeEvent, eventSpread, linkSpread, runningRecord, listEvents, getEvent, _setDeps, COLLECTION }
    from '../../services/echo.service.js'

// Echo's forward test, read (docs/design/echo-desk.md step 1). The documents mirror what aether-engine's echo_forward.py
// writes — the Cisco map of 2026-11-19 is the model for `mapped`.

const link = (ticker, relation, direction, extra = {}) => ({
    name: `${ticker} Inc.`, ticker, relation, source: 'llm', layer: relation === 'peer' ? 1 : 2, direction,
    evidence_text: `${ticker} sells to the origin.`, note: 'confidence high; model\'s direction gains; FMP: x', ...extra,
})
const EVENT = { id: 'csco-earnings-2026-11-12', date: '2026-11-12', origin: 'Cisco Systems, Inc.', origin_tickers: ['CSCO'],
    effect: 'down', size: 'Day 0 move -5.9% vs SPY' }

const mapped = () => ({
    _id: EVENT.id, event: EVENT, status: 'mapped',
    map: { model: 'claude-opus-5-5', prompt_version: '2026-11-19', mapped_at: '2026-11-19T03:43:00Z',
        direction_rule: 'chains.direction_for(relation, effect)', dropped: ['XYZ: no US listing'],
        links: [link('JBL', 'supplier', 'loses'), link('ANET', 'peer', 'unclear'), link(null, 'supplier', 'loses', { name: 'Foxconn' })] },
})

// Checked and graded at 20 and 60: JBL flagged, two stand-ins for it; ANET is layer 1 (not in the groups).
const graded = () => ({
    ...mapped(), status: 'checked',
    check: { check_date: '2026-11-19', absent: [], rows: [
        { ticker: 'JBL',  group: 'flagged',   direction: 'loses', reaction: 0.01, stand_in_for: null, forward: { 20: 0.05, 60: 0.08 } },
        { ticker: 'FLEX', group: 'unflagged', direction: 'loses', reaction: 0.04, stand_in_for: null, forward: { 20: 0.00, 60: -0.02 } },
        { ticker: 'R1',   group: 'random',    direction: 'loses', reaction: null, stand_in_for: 'JBL', forward: { 20: 0.01, 60: 0.02 } },
        { ticker: 'R2',   group: 'random',    direction: 'loses', reaction: null, stand_in_for: 'JBL', forward: { 20: 0.03, 60: null } },
    ] },
    grades: { 20: { exit_date: '2026-12-17' }, 60: { exit_date: '2027-02-17' } },
})
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`)

test('a link\'s spread is its grade minus the mean of ITS OWN graded stand-ins', () => {
    const rows = graded().check.rows
    close(linkSpread(rows, rows[0], 20), 0.05 - 0.02)           // stand-ins 0.01, 0.03
    close(linkSpread(rows, rows[0], 60), 0.08 - 0.02)           // R2 ungraded at 60 → only R1
    assert.equal(linkSpread(rows, rows[1], 20), null, 'FLEX has no stand-ins → no spread')
    assert.equal(linkSpread(rows, rows[0], 120), null, 'not graded yet')
})

test('the event spread is over flagged links only (forward.py event_spread)', () => {
    close(eventSpread(graded().check.rows, 20), 0.03)
    assert.equal(eventSpread([], 20), null)
})

test('a mapped event: links listed, none flagged yet, no spread', () => {
    const s = shapeSummary(mapped())
    assert.equal(s.id, EVENT.id)
    assert.equal(s.status, 'mapped')
    assert.equal(s.links, 3)
    assert.deepEqual(s.flagged, [])
    assert.deepEqual(s.graded, [])
    assert.deepEqual(s.spread, { 20: null, 60: null, 120: null })
})

test('a checked event: the flagged link joined to its map entry, its grades and spread', () => {
    const s = shapeSummary(graded())
    assert.equal(s.flagged.length, 1)
    const f = s.flagged[0]
    assert.equal(f.ticker, 'JBL')
    assert.equal(f.relation, 'supplier')
    assert.equal(f.why, 'JBL sells to the origin.')
    assert.equal(f.reaction, 0.01)
    close(f.spread[20], 0.03)
    assert.equal(f.spread[120], null)
    assert.deepEqual(s.graded, [20, 60])
    close(s.spread[20], 0.03)
    assert.equal(s.spread[120], null, 'no event spread before the horizon is graded')
    assert.equal(s.checkDate, '2026-11-19')
})

test('the full event keeps every link — unpriced and layer 1 too — and who mapped it', () => {
    const e = shapeEvent(graded())
    assert.equal(e.all.length, 3)
    assert.equal(e.all.find(l => l.name === 'Foxconn').group, null, 'no ticker → not in the check')
    assert.equal(e.all.find(l => l.ticker === 'ANET').group, null, 'layer 1 is the yardstick, not a group')
    assert.equal(e.map.model, 'claude-opus-5-5')
    assert.deepEqual(e.map.dropped, ['XYZ: no US listing'])
})

test('a random stand-in is never shown as the link itself, even on a shared ticker', () => {
    const doc = graded()
    doc.check.rows.unshift({ ticker: 'JBL', group: 'random', direction: 'loses', stand_in_for: 'OTHER', forward: { 20: 9 } })
    assert.equal(shapeSummary(doc).flagged[0].forward[20], 0.05)
})

test('a late event lists with no map', () => {
    const s = shapeSummary({ _id: 'ceg-earnings-2026-11-09', event: { ...EVENT, id: 'ceg' }, status: 'late' })
    assert.equal(s.links, 0)
    assert.deepEqual(s.flagged, [])
    assert.equal(shapeEvent({ _id: 'x', event: EVENT, status: 'late' }).map, null)
})

test('the running record counts only events graded at each horizon, and says when the verdict reads', () => {
    const r = runningRecord([graded(), mapped()])
    assert.equal(r[20].n, 1)
    close(r[20].mean, 0.03)
    assert.equal(r[20].positive, 1)
    assert.equal(r[120].n, 0)
    assert.equal(r[120].mean, null)
    assert.equal(r.verdictAt, 30)
    assert.equal(r.gradedAt120, 0)
})

function fakeDb(docs) {
    const calls = []
    return { calls, collection(name) {
        assert.equal(name, COLLECTION)
        return {
            find(filter, opts) {
                calls.push(['find', filter, opts])
                let out = filter.grades ? docs.filter(d => d.grades) : [...docs]
                const chain = {
                    sort() { out.sort((a, b) => (a.event.date < b.event.date ? 1 : -1)); return chain },
                    limit(n) { out = out.slice(0, n); return chain },
                    async toArray() { return out },
                }
                return chain
            },
            async findOne(q) { calls.push(['findOne', q]); return docs.find(d => d._id === q._id) ?? null },
        }
    } }
}

test('listEvents: newest first, and the record over every graded event', async () => {
    const older = { ...graded(), _id: 'old-earnings-2026-10-01', event: { ...EVENT, date: '2026-10-01' } }
    const db = fakeDb([older, mapped()])
    _setDeps({ db })
    const { events, record } = await listEvents()
    assert.deepEqual(events.map(e => e.date), ['2026-11-12', '2026-10-01'])
    assert.equal(record[20].n, 1)
    _setDeps({ db: null })
})

test('getEvent: the shaped event, null when there is none', async () => {
    _setDeps({ db: fakeDb([graded()]) })
    assert.equal((await getEvent(EVENT.id)).flagged.length, 1)
    assert.equal(await getEvent('nope'), null)
    assert.equal(await getEvent(''), null)
    _setDeps({ db: null })
})
