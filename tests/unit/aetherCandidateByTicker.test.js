// One name, every event that reached it.
//
// The list answers "what has Aether found". This answers "why is THIS name here" — the
// question someone arrives with from a position, a chart or a search, already holding the
// ticker. That difference in the question drives the two decisions worth guarding: dropped
// appearances are INCLUDED here where the list hides them, and a name the engine never
// touched is a 404 rather than an empty shell.
//
// The DB read is not stubbed — ESM bindings are immutable, and the repo's answer to that is
// to split the pure part out and test it, the same way groupCandidatesByRun was. The
// validation runs BEFORE the read, so it is reachable here too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
    getCandidatesForTicker, shapeTickerResult, tickerWindowDays,
} from '../../api/aether/aether.service.js'
import { getCandidatesByTicker } from '../../api/aether/aether.controller.js'
import { runHandler } from '../helpers/http.js'

const app = (over = {}) => ({ ticker: 'CENX', rank: 3, subject: 'Canada', survived: true, ...over })

// ── the shape ────────────────────────────────────────────────────────────────

test('appearances lead with the strongest claim, whichever event made it', () => {
    const out = shapeTickerResult('CENX', [
        app({ subject: 'Canada', rank: 2.1 }),
        app({ subject: 'Iran', rank: 5.4 }),
        app({ subject: 'Bombardier', rank: 3.3 }),
    ])
    assert.deepEqual(out.appearances.map(a => a.subject), ['Iran', 'Bombardier', 'Canada'])
    assert.equal(out.best.subject, 'Iran')
    assert.equal(out.events, 3)
})

test('it does not reorder the caller’s array', () => {
    const rows = [app({ subject: 'Canada', rank: 1 }), app({ subject: 'Iran', rank: 9 })]
    shapeTickerResult('CENX', rows)
    assert.equal(rows[0].subject, 'Canada', 'the input was sorted in place')
})

test('survived is true when ANY appearance is still live', () => {
    // A name dropped by one event and kept by another is still worth looking at.
    const out = shapeTickerResult('CENX', [app({ survived: false }), app({ survived: true })])
    assert.equal(out.survived, true)
})

test('an appearance stored before survival ran does not count as surviving', () => {
    // `undefined` is not a claim that it survived — it is the absence of the evaluation,
    // which is exactly the state 90 candidates sat in on 2026-09-10.
    const out = shapeTickerResult('CENX', [{ ticker: 'CENX', rank: 1 }])
    assert.equal(out.survived, false)
})

test('a name with no appearances is null, not an empty shell', () => {
    assert.equal(shapeTickerResult('ZZZZ', []), null)
    assert.equal(shapeTickerResult('ZZZZ'), null)
})

test('an unranked appearance sorts last rather than throwing', () => {
    const out = shapeTickerResult('CENX', [app({ subject: 'A', rank: undefined }), app({ subject: 'B', rank: 2 })])
    assert.deepEqual(out.appearances.map(a => a.subject), ['B', 'A'])
})

// ── the window ───────────────────────────────────────────────────────────────

test('the window is wider than the list’s, and clamped', () => {
    // 90 rather than the list's 30: a name is worth remembering longer than a screen is
    // worth filling. Clamped because it arrives on a query string.
    assert.equal(tickerWindowDays(undefined), 90)
    assert.equal(tickerWindowDays('soon'), 90)
    assert.equal(tickerWindowDays(0), 90, 'zero is a missing value, not a request for nothing')
    assert.equal(tickerWindowDays('99999'), 365)
    assert.equal(tickerWindowDays('-5'), 1)
    assert.equal(tickerWindowDays('120'), 120)
})

// ── the ticker itself ────────────────────────────────────────────────────────

test('junk never reaches Mongo', async () => {
    // Validation runs before the read, so these resolve without a database — which is also
    // the property being asserted: a malformed path parameter is refused, not queried.
    // 'a'.repeat(40) is the one that mattered: it used to be TRUNCATED to a valid
    // twelve-character ticker and queried for, inventing a symbol nobody asked about.
    for (const bad of ['', '   ', 'a'.repeat(40), 'DROP TABLE', '../etc', 'NUE;DROP',
                       { $ne: null }, null, undefined]) {
        assert.equal(await getCandidatesForTicker(bad), null, `accepted ${JSON.stringify(bad)}`)
    }
})

test('real tickers with dots and dashes reach the read rather than being refused', async () => {
    // BRK.B and RDS-A exist; a regex that rejected them would look exactly like "no
    // candidate for that ticker". Getting PAST validation means hitting the database,
    // which is absent here — so the tell is that it throws about Mongo rather than
    // returning null, which is what a refusal looks like.
    for (const good of ['BRK.B', 'RDS-A', 'nue']) {
        await assert.rejects(
            () => getCandidatesForTicker(good),
            /MONGODB_URI|ENOTFOUND|ECONNREFUSED|topology/i,
            `${good} was refused by validation instead of reaching the read`,
        )
    }
})

// ── the endpoint ─────────────────────────────────────────────────────────────

test('a ticker the engine never named is 404', async () => {
    // An invalid symbol is refused before the read, so this exercises the controller's
    // not-found path without a database.
    const res = await runHandler(getCandidatesByTicker, { params: { ticker: '!!!' }, query: {} })
    assert.equal(res.statusCode, 404)
    assert.match(res.body.error, /No Aether candidate/)
})

test('“no such candidate” and “the read failed” are different answers', () => {
    // 404 is a claim about the world; 500 is a claim about the connection. The candidate
    // list learnt this distinction the hard way on 2026-09-10 and it holds here too: the 404 is
    // minted in the handler, and a failed read is left to throw — the global handler's 500.
    const body = readFileSync(new URL('../../api/aether/aether.controller.js', import.meta.url), 'utf8')
    const fn = body.slice(body.indexOf('export const getCandidatesByTicker'))
    assert.match(fn.slice(0, 900), /httpError\(404,/)
    assert.doesNotMatch(fn.slice(0, 900), /status\(500\)/, 'no hand-rolled 500 — the pipe answers it')
})
