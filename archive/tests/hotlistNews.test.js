import { test } from 'node:test'
import assert from 'node:assert/strict'
import { labelNews, normalizeLabels, buildNewsText } from '../services/hotlist.news.js'

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

test('a big pool is labelled in chunks — a cut-off chunk loses only its own labels', async () => {
    // The first live run (24 tickers on Luna) came back cut off mid-JSON: one reply cannot hold a pool.
    const pool = new Map(Array.from({ length: 90 }, (_, i) => [`T${i}`, [{ title: `news ${i}` }]]))
    let calls = 0
    const out = await labelNews(pool, { send: async ({ userText }) => {
        calls++
        if (calls === 2) return '{"labels":[{"ticker":"T40","material":true'   // the cut-off one
        const tickers = [...userText.matchAll(/^(T\d+):/gm)].map(m => m[1])
        return JSON.stringify({ labels: tickers.map(t => ({ ticker: t, material: true, type: 'short', surprise: 'positive' })) })
    } })
    assert.equal(calls, 3, '90 tickers in chunks of 40')
    assert.equal(out.size, 50, 'the 40 of the cut-off chunk are missing; the other 50 are labelled')
    assert.equal(out.has('T0'), true)
    assert.equal(out.has('T40'), false)
})

test('each label call\'s spend is reported under the model id ASKED for', async () => {
    const booked = []
    await labelNews(HEADLINES, {
        model: 'gpt-6-luna',
        send: async ({ onUsage }) => { onUsage?.({ input_tokens: 100, output_tokens: 20 }, 'luna-wire-name'); return '{}' },
        onUsage: (usage, model) => booked.push({ usage, model }),
    })
    assert.equal(booked.length, 1)
    assert.equal(booked[0].model, 'gpt-6-luna')
    assert.equal(booked[0].usage.input_tokens, 100)
})
