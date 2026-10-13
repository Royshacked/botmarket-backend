import { test } from 'node:test'
import assert from 'node:assert/strict'

import { labelsFrom, houseLabels, booksForStyle, wireLabel, formatHouseLabel } from '../../services/houseLabel.service.js'
import { _attachHouseLabels } from '../../services/agents/scanner.agent.service.js'

// The house label on a name (docs/design/argus-on-pythia.md §3.4, step 5): worked out by code from the name's
// industry and the house's list for the book — never taken from the model or a request body.

const E = (code, name, over = {}) => ({ code, name, sector: 'S', rated: true, hype: false, avoid: false, thesis: `${name} thesis`, themes: [], ...over })
const LISTS = {
    swing:     [E('45201020', 'Communications Equipment', { hype: true })],
    long_term: [E('45103020', 'Systems Software'), E('45201020', 'Communications Equipment')],
}
const IND = { LITE: '45201020', MSFT: '45103020', XOM: '10102010' }

test('the style asks its own book; intraday and day ask none', () => {
    assert.deepEqual(booksForStyle('swing'), ['swing'])
    assert.deepEqual(booksForStyle('long term'), ['long_term'])
    for (const s of ['intraday', 'day', null, 'scalp']) assert.deepEqual(booksForStyle(s), [])
})

test("a name is labelled when its industry is on the book's list; the first book asked wins", () => {
    const m = labelsFrom(['LITE', 'MSFT', 'XOM', 'NOPE'], IND, LISTS, ['swing', 'long_term'])
    assert.deepEqual(m.get('LITE'), { book: 'swing', code: '45201020', industry: 'Communications Equipment', hype: true, avoid: false, themes: [], thesis: 'Communications Equipment thesis' })
    assert.equal(m.get('MSFT').book, 'long_term')
    assert.equal(m.has('XOM'), false, 'industry not on any list')
    assert.equal(m.has('NOPE'), false, 'not classified')
    assert.equal(labelsFrom(['LITE'], IND, LISTS, ['long_term', 'swing']).get('LITE').book, 'long_term')
})

test("a theme-only industry carries the theme's name and reason", () => {
    const lists = { swing: [E('20104010', 'Electrical Components', { rated: false, thesis: null, themes: [{ name: 'AI power', thesis: 'grid build-out' }] })] }
    const l = labelsFrom(['ETN'], { ETN: '20104010' }, lists, ['swing']).get('ETN')
    assert.deepEqual(l.themes, ['AI power'])
    assert.equal(l.thesis, 'grid build-out')
    assert.match(formatHouseLabel(l), /on the house's swing list — Electrical Components \(via the theme "AI power"\)\. The house's reason: grid build-out/)
})

test('houseLabels reads each book once, upper-cases, and never throws', async () => {
    const asked = []
    const deps = { forBooks: async (books) => { asked.push(...books); return Object.fromEntries(books.map(b => [b, LISTS[b]])) }, industryOf: async () => IND }
    const m = await houseLabels(['lite', 'LITE', 'msft'], { books: ['swing', 'long_term'] }, deps)
    assert.deepEqual([...m.keys()].sort(), ['LITE', 'MSFT'])
    assert.deepEqual(asked.sort(), ['long_term', 'swing'])
    assert.equal((await houseLabels(['LITE'], { books: ['watch'] }, deps)).size, 0, 'not a book')
    assert.equal((await houseLabels([], {}, deps)).size, 0)
    assert.equal((await houseLabels(['LITE'], {}, { ...deps, forBooks: async () => { throw new Error('db down') } })).size, 0)
})

test('the wire carries the facts, not the thesis; the prompt line carries the flags', () => {
    const l = labelsFrom(['LITE'], IND, LISTS, ['swing']).get('LITE')
    assert.deepEqual(wireLabel(l), { book: 'swing', industry: 'Communications Equipment', hype: true, avoid: false, themes: [] })
    assert.equal(wireLabel(undefined), null)
    assert.match(formatHouseLabel(l), /HYPE/)
    assert.match(formatHouseLabel({ ...l, book: 'long_term', hype: false, avoid: true }), /long-term list.*AVOID/)
    assert.equal(formatHouseLabel(null), '')
})

test("Argus's scan and pick are labelled by code: the scan's style picks the book, the pick asks both", async () => {
    const calls = []
    const labels = async (symbols, { books }) => { calls.push(books); return labelsFrom(symbols, IND, LISTS, books) }
    const scan = { style: 'swing', candidates: [{ ticker: 'LITE' }, { ticker: 'MSFT' }] }
    const pick = { ticker: 'MSFT' }
    await _attachHouseLabels(scan, pick, { labels })
    assert.equal(scan.candidates[0].house.book, 'swing')
    assert.equal(scan.candidates[1].house, null, 'Systems Software is long-term, not swing')
    assert.equal(pick.house.book, 'long_term')
    assert.deepEqual(calls, [['swing'], ['swing', 'long_term']])
    const day = { style: 'day', candidates: [{ ticker: 'LITE' }] }
    await _attachHouseLabels(day, null, { labels })
    assert.equal(day.candidates[0].house, null, 'a day scan has no house list')
    const inv = { style: null, candidates: [{ ticker: 'MSFT' }] }
    await _attachHouseLabels(inv, null, { profile: 'investing', labels })
    assert.equal(inv.candidates[0].house.book, 'long_term', 'an investing list with no style asks long term')
    await _attachHouseLabels(null, null, { labels })
})
