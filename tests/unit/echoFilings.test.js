import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shareIn, sentencesWith, isHedged, termsFor, namedIn, customerShare, supplySentences, _setDeps, BUSINESS_FORMS } from '../../services/echoFilings.service.js'
import { htmlToText } from '../../providers/sec.provider.js'

// Echo's filing evidence (docs/design/echo-pipeline.md Steps 1–3). The sentences are the real ones from the 2026-11-19
// sample of Cisco's links' filings.

const PLUS = 'Products manufactured by Cisco Systems represented approximately 29%, 32%, and 44% of net sales for the years ended March 31, 2026, 2025, and 2024, respectively.'
const SCSC = 'Products from two suppliers, Cisco and Zebra, each constituted more than 10% of our net sales for the fiscal year ended June 30, 2026.'
const FN = 'During fiscal year 2026, Cisco Systems, Inc., NVIDIA Corporation, Nokia Corporation and Amazon.com, Inc. contributed 19.9%, 16.3%, 10.7% and 10.5%, respectively, of our total revenues.'

test('shareIn: the latest period, a floor, and the place in a "respectively" list', () => {
    assert.deepEqual(shareIn(PLUS, 'Cisco'), { share: 0.29, atLeast: false })
    assert.deepEqual(shareIn(SCSC, 'Cisco'), { share: 0.1, atLeast: true })
    assert.deepEqual(shareIn(FN, 'Cisco'), { share: 0.199, atLeast: false })
    assert.deepEqual(shareIn(FN, 'NVIDIA'), { share: 0.163, atLeast: false }, 'the second name gets the second figure')
    assert.deepEqual(shareIn(FN, 'Amazon'), { share: 0.105, atLeast: false })
    assert.deepEqual(shareIn('Cisco Systems, Inc 13 % 14 % 12 %', 'Cisco'), { share: 0.13, atLeast: false }, 'a table row')
    assert.equal(shareIn('We sell to Cisco.', 'Cisco'), null)
    assert.equal(shareIn('Sales of Cisco products grew 12% in fiscal 2026.', 'Cisco'), null, 'a growth rate is no share')
    assert.deepEqual(shareIn('Cisco accounted for 14% of our net sales in fiscal 2026.', 'Cisco'), { share: 0.14, atLeast: false })
    // Insight's 10-K: a group's figure is no one's share.
    assert.equal(shareIn('Sales of product from our top five manufacturers/publishers as a group (Microsoft, Dell, Cisco Systems, HP Inc. and Lenovo) accounted for approximately 50% of our consolidated net sales during 2025.', 'Cisco'), null)
    assert.equal(shareIn(PLUS, 'Juniper'), null)
})

test('sentencesWith: matching sentences, deduplicated, bounded', () => {
    const text = 'We have experienced increased lead times. Our margins rose. We have experienced increased lead times. Short lead times help us.'
    assert.deepEqual(sentencesWith(text, /lead times/i), ['We have experienced increased lead times.', 'Short lead times help us.'])
    assert.equal(sentencesWith(text, /lead times/i, 1).length, 1)
})

test('isHedged: a risk is not a statement', () => {
    assert.equal(isHedged('We may experience a shortage of, or a delay in receiving, such materials.'), true)
    assert.equal(isHedged('Our record backlog provides clear visibility into what we expect to be another year of significant growth.'), false)
    assert.equal(isHedged('We have experienced increased lead times and expedite fees for the supply of materials.'), false)
})

test('termsFor: the name without its legal suffix', () => {
    assert.deepEqual(termsFor('Cisco Systems, Inc.'), ['Cisco Systems'])
    assert.deepEqual(termsFor('Amazon.com, Inc.'), ['Amazon.com'])
    assert.deepEqual(termsFor('Inc.'), [])
})

test('htmlToText: tags, scripts and entities out', () => {
    assert.equal(htmlToText('<p>Cisco&#160;Systems <b>19.9%</b></p><script>x()</script>&amp; more'), 'Cisco Systems 19.9% & more')
})

const filer = async (t) => (t === 'NOPE' ? null : { cik: '0000000001', title: t })

test('namedIn: business filings only, with the sentence; unread is null, not false', async () => {
    const calls = []
    _setDeps({
        cik: filer, now: () => new Date('2026-11-19T00:00:00Z'),
        search: async (q, o) => { calls.push([q, o]); return [{ form: '8-K', date: '2026-11-10', url: 'u1' }] },
        text: async () => 'Our partners include many. Cisco is a key customer of our networking unit. Thanks.',
    })
    const r = await namedIn('FLEX', ['Cisco'])
    assert.equal(r.named, true)
    assert.equal(r.excerpt, 'Cisco is a key customer of our networking unit.')
    assert.equal(calls[0][0], '"Cisco"')
    assert.deepEqual(calls[0][1].forms, BUSINESS_FORMS, 'no proxy: a director from Cisco is not a link')
    assert.equal(calls[0][1].since, '2023-11-19')
    _setDeps({ search: async () => [] })
    assert.equal((await namedIn('JBL', ['Cisco'])).named, false)
    assert.equal((await namedIn('NOPE', ['Cisco'])).named, null)
    _setDeps({ search: async () => { throw new Error('EDGAR 500') } })
    assert.equal((await namedIn('JBL', ['Cisco'])).named, null, 'a failed read is unknown, never "not named"')
})

test('customerShare: the 10-K sentence that gives the share', async () => {
    _setDeps({ annual: async () => ({ form: '10-K', date: '2026-08-18', url: 'k' }), text: async () => `Our customers are concentrated. ${FN} Other text.` })
    const r = await customerShare('FN', ['Cisco'])
    assert.equal(r.share, 0.199)
    assert.equal(r.form, '10-K')
    assert.match(r.excerpt, /^During fiscal year 2026, Cisco/)
    _setDeps({ text: async () => 'Cisco is a customer. No figures.' })
    assert.equal((await customerShare('JBL', ['Cisco'])).share, null)
    _setDeps({ annual: async () => null })
    assert.equal((await customerShare('X', ['Cisco'])).share, null)
})

test('supplySentences: statements first, repeats across filings dropped', async () => {
    _setDeps({
        cik: filer, search: async () => [{ form: '10-Q', date: '2026-11-03', url: 'q3' }, { form: '10-Q', date: '2026-08-03', url: 'q2' }],
        text: async (u) => (u === 'q3'
            ? 'We may experience a shortage of components. We have experienced increased lead times.'
            : 'We may experience a shortage of components. Our record backlog grew.'),
    })
    const r = await supplySentences('FN')
    assert.equal(r.filings, 2)
    assert.deepEqual(r.sentences.map(s => [s.hedged, s.text]), [
        [false, 'We have experienced increased lead times.'], [false, 'Our record backlog grew.'], [true, 'We may experience a shortage of components.']])
})
