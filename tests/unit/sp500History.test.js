import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellText, fmpTicker, isoDate, parseCurrent, parseChanges, membership, memberOn } from '../../services/sp500History.service.js'
import { sectorStats } from '../../services/screenerLab.data.js'

// The S&P 500 as it was (Roy, 2026-10-27: "rebuild with the delisted names") — Wikipedia's tables walked back from today.

const CURRENT = `intro
{| class="wikitable sortable" id="constituents"
|-
![[Ticker symbol|Symbol]]
! Security !! GICS Sector
|-
|| {{NyseSymbol|BRK.B}} <!-- DO NOT CHANGE -->
|| [[Berkshire Hathaway]]
|| Financials
|-
|| {{NasdaqSymbol|NEW}}
|| [[New Co|NewCo]]
|| Industrials
|}
after`

const CHANGES = `{| class="wikitable sortable" id="changes"
|-
! Effective Date !! Added !! Removed
|-
|| March 1, 2024
|| NEW
|| [[NewCo]]
|| OLD
|| [[Old Co]]
|| Market capitalization changes.
|| <ref name="x">{{Cite web |title=t}}</ref>
|-
|June 3, 2019
|OLD
|[[Old Co]]
|GONE|| [[Gone Inc]]
|Acquired
|<ref name="x" />
|-
|July 1, 1990
|OLDER
|[[Older]]
|
|
|
|
|}`

test('a cell → its text: templates, links, refs and comments', () => {
    assert.equal(cellText('{{NyseSymbol|BRK.B}} <!-- x -->'), 'BRK.B')
    assert.equal(cellText('[[New Co|NewCo]]'), 'NewCo')
    assert.equal(cellText('<ref name="x">{{Cite web |title=t}}</ref>'), '')
    assert.equal(fmpTicker('brk.b'), 'BRK-B')
    assert.equal(isoDate('June 3, 2019'), '2019-06-03')
    assert.equal(isoDate('Junetember 3, 2019'), null)
})

test('the tables: today’s members and every change, `||` with or without spaces', () => {
    assert.deepEqual(parseCurrent(CURRENT), [{ symbol: 'BRK-B', name: 'Berkshire Hathaway', sector: 'Financials' }, { symbol: 'NEW', name: 'NewCo', sector: 'Industrials' }])
    const ch = parseChanges(CHANGES)
    assert.equal(ch.length, 3)
    assert.deepEqual(ch[1], { date: '2019-06-03', added: 'OLD', addedName: 'Old Co', removed: 'GONE', removedName: 'Gone Inc' })
    assert.equal(ch[2].removed, null)
})

test('walked back from today: a name joins on its date, a removed one was in up to the session before', () => {
    const m = membership(parseCurrent(CURRENT), parseChanges(CHANGES), { from: '2018-01-01' })
    assert.deepEqual(m.spans.NEW, [['2024-03-01', null]])
    assert.deepEqual(m.spans.OLD, [['2019-06-03', '2024-03-01']])
    assert.deepEqual(m.spans.GONE, [['2018-01-01', '2019-06-03']])
    assert.deepEqual(m.spans['BRK-B'], [['2018-01-01', null]])
    assert.equal(m.spans.OLDER, undefined, 'a change before `from` is not read')
    assert.equal(m.names.GONE, 'Gone Inc')
    assert.equal(memberOn(m.spans, 'OLD', '2024-02-29'), true)
    assert.equal(memberOn(m.spans, 'OLD', '2024-03-01'), false)
    assert.equal(memberOn(m.spans, 'GONE', '2019-06-03'), false)
})

test('an added ticker with no open span (a rename since) is listed, not guessed', () => {
    const m = membership([{ symbol: 'CPAY', name: 'Corpay' }], [{ date: '2018-06-20', added: 'FLT', removed: 'TWX', removedName: 'Time Warner' }], { from: '2017-11-01' })
    assert.equal(m.unmatched.length, 1)
    assert.deepEqual(m.spans.TWX, [['2017-11-01', '2018-06-20']])
})

test('the sectors’ stats count only the day’s members when a membership is given', () => {
    const name = (r) => ({ sector: 'X', ind: { date: ['d1'], ret5: [r] } })
    const names = new Map(Array.from({ length: 9 }, (_, k) => [`S${k}`, name(k)]))
    assert.equal(sectorStats(names).get('d1').get('X').n, 9)
    assert.equal(sectorStats(names, (sym) => sym !== 'S8').get('d1').get('X').n, 8)
    assert.equal(sectorStats(names, (sym) => sym !== 'S8' && sym !== 'S7').get('d1').has('X'), false, 'under 8 names')
})
