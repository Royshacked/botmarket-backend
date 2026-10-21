import { test } from 'node:test'
import assert from 'node:assert/strict'
import { labelNews, normalizeLabels, buildNewsText } from '../../services/hotlist.news.js'

// The hotlist's news labels (docs/design/daily-names.md §3). One cheap call per checkpoint; it must
// FAIL SOFT — a board goes out unlabelled rather than not at all (on 2026-10-21 the Anthropic credit
// balance was at zero, which is exactly that case).

const HEADLINES = new Map([
    ['ABC', [{ title: 'ABC beats and raises full-year guidance' }, { title: 'Is ABC a buy?' }]],
    ['XYZ', [{ title: '5 stocks to watch this week' }]],
])

test('the user turn lists each ticker\'s headlines, capped per ticker', () => {
    const many = new Map([['ABC', Array.from({ length: 9 }, (_, i) => ({ title: `h${i}` }))]])
    const text = buildNewsText(many)
    assert.match(text, /^ABC:\n- h0/)
    assert.equal((text.match(/^- /gm) ?? []).length, 5)
})

test('labels are held to their vocabulary; only asked-for tickers survive', () => {
    const out = normalizeLabels({ labels: [
        { ticker: 'abc', material: true, type: 'drift', surprise: 'positive', magnitude: 'major', headline: 'ABC beats and raises full-year guidance' },
        { ticker: 'XYZ', material: false, type: 'lasting', surprise: 'wild' },
        { ticker: 'NOPE', material: true, type: 'drift' },
    ] }, HEADLINES.keys())
    assert.deepEqual(out.get('ABC'), { material: true, type: 'drift', surprise: 'positive', magnitude: 'major', headline: 'ABC beats and raises full-year guidance' })
    assert.equal(out.get('XYZ').type, 'none', 'not material → no catalyst type, whatever the model said')
    assert.equal(out.get('XYZ').surprise, 'none', 'off-vocabulary → none')
    assert.equal(out.has('NOPE'), false)
    const blank = normalizeLabels({ labels: [{ ticker: 'XYZ', material: false, headline: '  ' }] }, ['XYZ'])
    assert.equal(blank.get('XYZ').headline, null, 'an empty headline is no headline')
})

test('one call for the whole pool, through the injected sender', async () => {
    let calls = 0
    const out = await labelNews(HEADLINES, { send: async ({ userText }) => {
        calls++
        assert.match(userText, /ABC:/)
        assert.match(userText, /XYZ:/)
        return '{"labels":[{"ticker":"ABC","material":true,"type":"drift","surprise":"positive","magnitude":"major"}]}'
    } })
    assert.equal(calls, 1)
    assert.equal(out.get('ABC').type, 'drift')
})

test('a failed call — no credits, a dead provider, junk — is an EMPTY map, never a throw', async () => {
    const dead = await labelNews(HEADLINES, { send: async () => { throw new Error('Your credit balance is too low') } })
    assert.equal(dead.size, 0)
    const junk = await labelNews(HEADLINES, { send: async () => 'sorry, I cannot' })
    assert.equal(junk.size, 0)
})

test('nothing to label → no call at all', async () => {
    let called = false
    const out = await labelNews(new Map(), { send: async () => { called = true } })
    assert.equal(out.size, 0)
    assert.equal(called, false)
})
