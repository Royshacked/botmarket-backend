import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nearestEarnings8k, pickExhibit, plainText, guidanceText, sentenceDirection, guidanceDirection } from '../../services/guidance8k.service.js'

// The guidance in an earnings release (Roy, 2026-11-07: test O). The sentences are real, from the 2026-11-07 sample.

test('the 8-K nearest the report, from the day before to three days after', () => {
    const list = [{ filed: '2025-07-20' }, { filed: '2025-07-23' }, { filed: '2025-07-25' }, { filed: '2025-10-22' }]
    assert.equal(nearestEarnings8k(list, '2025-07-22').filed, '2025-07-23')
    assert.equal(nearestEarnings8k(list, '2025-07-26').filed, '2025-07-25')
    assert.equal(nearestEarnings8k(list, '2025-09-01'), null)
    assert.equal(nearestEarnings8k([{ filed: '2025-07-20' }], '2025-07-22'), null, 'two days before is another filing')
})

test('the press release is exhibit 99.1, never the cover or a presentation', () => {
    const items = [{ name: 'wmt-20250821.htm' }, { name: 'earningspresentationfy26.htm', size: 900 }, { name: 'earningsreleasefy26q2.htm', size: 100 }, { name: 'index.htm' }]
    assert.equal(pickExhibit(items, 'wmt-20250821.htm'), 'earningsreleasefy26q2.htm')
    assert.equal(pickExhibit([{ name: 'a8-k.htm' }, { name: 'ex99-2.htm' }, { name: 'ex99-1.htm' }], 'a8-k.htm'), 'ex99-1.htm')
    assert.equal(pickExhibit([{ name: 'pfe-06292025xex99.htm' }, { name: 'pfe-8k.htm' }], 'pfe-8k.htm'), 'pfe-06292025xex99.htm')
    assert.equal(pickExhibit([{ name: 'cover.htm' }], 'cover.htm'), null)
})

test('plain text: tags out, entities in, one line', () => {
    assert.equal(plainText('<p>Raises&#160;2025 EPS&nbsp;Guidance &#8212; <b>3M</b> &amp; co&#8217;s</p>\n<style>x{}</style>'), "Raises 2025 EPS Guidance - 3M & co's")
})

test('guidanceText keeps the guidance sentences and drops the safe-harbour paragraph', () => {
    const html = '<p>3M Reports Second-Quarter 2025 Results, Increases Full-Year EPS Guidance.</p><p>Sales were $6.3 billion.</p>' +
        '<p>This release contains forward-looking statements about our guidance.</p><p>The Company reaffirms its guidance for fiscal 2025.</p>'
    const t = guidanceText(html)
    assert.deepEqual(t.lines, ['3M Reports Second-Quarter 2025 Results, Increases Full-Year EPS Guidance.', 'The Company reaffirms its guidance for fiscal 2025.'])
    assert.ok(t.lead.startsWith('3M Reports'))
})

test('a sentence: the verb next to a guidance word, either order', () => {
    assert.equal(sentenceDirection('Raises Full-Year 2021 Guidance for Revenues to a Range of $78.0 to $80.0 Billion'), 'up')
    assert.equal(sentenceDirection('Based on our encouraging cash results, we are increasing our full-year free cash flow outlook.'), 'up')
    assert.equal(sentenceDirection('2025 adjusted EPS guidance increased from $7.60 - $7.90 to $7.75 - $8.00'), 'up')
    assert.equal(sentenceDirection('Given these factors, the company is lowering full-year free cash flow guidance from the $16 billion range to the $14 billion range.'), 'down')
    assert.equal(sentenceDirection('On May 13, 2025, UnitedHealth Group suspended its 2025 outlook.'), 'down')
    assert.equal(sentenceDirection('Reaffirms Fiscal 2025 Guidance ATLANTA, August 19, 2025'), 'hold')
    assert.equal(sentenceDirection('We are maintaining full year 2025 guidance for sales, cash from operations, capital expense, free cash flow, and share repurchases.'), 'hold')
    assert.equal(sentenceDirection('reaffirmed its 2025 Revenue guidance while raising guidance for Adjusted diluted EPS.'), 'up', 'a raise beside a reaffirm is a raise')
})

test('a sentence that only grades a result against the old guidance moves nothing', () => {
    assert.equal(sentenceDirection("Compared to the same period in 2019, adjusted operating revenue declined 49 percent, an improvement from the company's guidance update in June of down 50 to 52 percent."), null)
    assert.equal(sentenceDirection('We closed more homes than the high end of our guidance range, while maintaining a home sales gross margin of 21.8%.'), null)
    assert.equal(sentenceDirection('The board raised the quarterly dividend, consistent with our outlook.'), null)
    assert.equal(sentenceDirection('In the fourth quarter of fiscal 2021, Applied expects net sales to be approximately $6.33 billion.'), null)
})

test('the hand check (2026-11-07): expectations and targets, numbers that move, costs that are not the forecast', () => {
    assert.equal(sentenceDirection('For the full year ending December 31, 2024, GoDaddy raised its revenue expectations to a range of $4.545 billion to $4.565 billion.'), 'up')
    assert.equal(sentenceDirection('The Company increased its target for adjusted diluted earnings per share to a range of $3.25 to $3.34, up from its prior guidance of $3.20 to $3.30 per share.'), 'up')
    assert.equal(sentenceDirection('For fiscal year 2025, the Company is updating its revenue guidance from a range of $23.5 billion to $25.0 billion to a new range of $21.8 billion to $22.6 billion.'), 'down')
    assert.equal(sentenceDirection('2025 adjusted EPS guidance updated from $7.60 - $7.90 to $7.75 - $8.00.'), 'up')
    assert.equal(sentenceDirection('Reduced full year 2025 drilling and completion capital expenditures guidance by ~$100 million'), null)
    assert.equal(sentenceDirection('We are lowering our operating expense outlook for the year.'), null)
    assert.equal(sentenceDirection('Workday is updating guidance for the fiscal 2026 full year ending January 31, 2026 as follows:'), null, 'no way to tell which way')
})

test('the second hand check (2026-11-07): an agency\'s outlook and an outlook heading over commentary are not a raise', () => {
    assert.equal(sentenceDirection("Subsequent to quarter end, on April 3, 2025, S&P Global Ratings reaffirmed our issuer and issue-level credit ratings of 'BBB' and upgraded our outlook to 'Positive' from 'Stable.'"), null)
    assert.equal(sentenceDirection('Outlook "We anticipate that improving market conditions, including increased trade stability and a more favorable interest rate environment, will contribute to strong domestic demand.'), null)
    assert.equal(sentenceDirection('We are therefore pleased to reiterate our FY 2025 guidance as initially announced two months ago.'), 'hold')
})

test('the release: the headline decides when it states one', () => {
    assert.equal(guidanceDirection({ lead: 'Pfizer Reports Strong Second-Quarter 2025 Results And Raises 2025 EPS Guidance. NEW YORK', lines: ['The Company reaffirms its revenue guidance.'] }), 'raise')
    assert.equal(guidanceDirection({ lead: 'Q2 results. Sales grew.', lines: ['P&G reduced its guidance range for fiscal 2023 all-in sales to be down three percent.', 'The Company maintained its outlook for organic sales growth.'] }), 'cut')
    assert.equal(guidanceDirection({ lead: 'Q2 results.', lines: ['We raised our full-year outlook for revenue.', 'We are lowering our full-year free cash flow guidance.'] }), 'mixed')
    assert.equal(guidanceDirection({ lead: 'Q2 results.', lines: ['The company reaffirms its guidance for fiscal 2025.'] }), 'maintain')
    assert.equal(guidanceDirection({ lead: 'Q2 results.', lines: ['Business Outlook: fourth quarter guidance is net sales of approximately $6.3 billion.'] }), 'numbers')
    assert.equal(guidanceDirection({ lead: 'Q2 results.', lines: [] }), 'none')
    assert.equal(guidanceDirection({}), 'none')
})
