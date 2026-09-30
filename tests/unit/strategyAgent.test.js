import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TOOLS, _parseStrategyResponse, _coverageBySector, _buildTurnContext, _buildMessages } from '../../services/agents/strategy.agent.service.js'
import { ALL_EMIT_TAGS } from '../../services/llmStream.util.js'
import { SECTORS } from '../../services/entity/vocabulary.js'

// Pythia's agent seams (pure). The stream itself is contract-tested with the other desks.

// ── the emit tag must be registered or it leaks ──────────────────────────────
test('<tilt> is in the shared emit-tag registry', () => {
    // Not cosmetic: buildTagCaptures suppresses only registered tags, so an unregistered one streams
    // raw JSON into the user's chat. This is the exact bug the Axl <open> tag hit.
    assert.ok(ALL_EMIT_TAGS.includes('tilt'))
})

// ── draft extraction ─────────────────────────────────────────────────────────
test('a published turn yields the reply and the parsed draft, block stripped', () => {
    const raw = `<phase>5</phase>Here is the view.\n<tilt>{"benchmark":"SPX","tilts":[{"sector":"Energy","stance":"under","active_bp":-150}]}</tilt>`
    const { reply, tilt } = _parseStrategyResponse(raw)
    assert.equal(reply, 'Here is the view.')
    assert.equal(tilt.tilts[0].sector, 'Energy')
})

test('a discussion turn emits nothing, and that is normal', () => {
    const { reply, tilt } = _parseStrategyResponse('Financials look stretched, but I would not act yet.')
    assert.equal(tilt, null)
    assert.match(reply, /^Financials/)
})

test('a malformed or empty block is null, never a half-built view', () => {
    assert.equal(_parseStrategyResponse('<tilt>{not json}</tilt>').tilt, null)
    assert.equal(_parseStrategyResponse('<tilt>{"tilts":[]}</tilt>').tilt, null, 'a table with no rows is not a view')
    assert.equal(_parseStrategyResponse('<tilt>{"benchmark":"SPX"}</tilt>').tilt, null)
    assert.equal(_parseStrategyResponse('<tilt>[1,2]</tilt>').tilt, null)
    assert.equal(_parseStrategyResponse(null).tilt, null)
})

// ── the bottom-up cross-check ────────────────────────────────────────────────
/** The one line the table gives a bucket. Assertions about a bucket belong here and not in the
 *  whole block, where the closing paragraph also uses the words BULLISH and SPLIT. */
const lineFor = (out, bucket) => out.split('\n').find(l => l.trim().startsWith(bucket)) ?? ''

const BOOK = [
    { userId: 'u1', symbol: 'NVDA', sector: 'Technology' },
    { userId: 'u2', symbol: 'AMD',  sector: 'Technology' },
    { userId: 'u1', symbol: 'XOM',  sector: 'Energy' },
]

test('the cross-check reads the WHOLE institution’s book, not one user’s', async () => {
    // A house view is a broadcast, so "what does our research think" spans every analyst. The read
    // is coverage's owner-blind sweep for exactly that reason.
    let asked = null
    const out = await _coverageBySector({ listActiveBySector: async (s) => { asked = s; return BOOK } })
    assert.deepEqual(asked, SECTORS, 'it asks about every sector')
    assert.match(lineFor(out, 'Technology'), /2 names/)
    assert.match(lineFor(out, 'Technology'), /NVDA, AMD/)
    assert.match(lineFor(out, 'Energy'), /1 name\b/)
    assert.match(lineFor(out, 'Energy'), /XOM/)
})

test('sectors with NO coverage are named — silence would read as agreement', async () => {
    const out = await _coverageBySector({ listActiveBySector: async () => BOOK })
    assert.match(out, /No coverage at all in: .*Utilities/)
    assert.match(out, /has no bottom-up support/)
})

test('an empty book says so rather than implying our analysts agree', async () => {
    const out = await _coverageBySector({ listActiveBySector: async () => [] })
    assert.match(out, /coverage book is empty/)
    assert.match(out, /rather than implying our analysts agree/)
})

// ── the grain below the sector ──────────────────────────────────────────────────
//
// A stance can be held on an industry, and `bottom_up` on one has to mean our covered names in
// THAT industry. A live run took six SECTOR stances and reached for no industry at all, because
// every input it had was sector-shaped: it had the vocabulary to say "Semiconductors" and no
// evidence at that grain.

const DEEP = [
    { symbol: 'NVDA', sector: 'Technology', industry: 'Semiconductors' },
    { symbol: 'AVGO', sector: 'Technology', industry: 'Semiconductors' },
    { symbol: 'TXN',  sector: 'Technology', industry: 'Semiconductors' },
    { symbol: 'MSFT', sector: 'Technology', industry: 'Software - Infrastructure' },
    { symbol: 'XOM',  sector: 'Energy',     industry: 'Oil & Gas Integrated' },
]

test('an industry deep enough to argue from is broken out under its sector', async () => {
    const out = await _coverageBySector({ listActiveBySector: async () => DEEP })
    assert.match(lineFor(out, 'Technology'), /4 names/, 'the sector line still counts every name')
    assert.match(lineFor(out, 'Semiconductors'), /3 names/)
    assert.match(lineFor(out, 'Semiconductors'), /NVDA, AVGO, TXN/)
})

test('a THIN industry is not broken out — one name is an anecdote, not a basis', async () => {
    // It stays counted in its sector. Printing every singleton would bury the line above it and
    // dress up a sample of one as bottom-up support.
    const out = await _coverageBySector({ listActiveBySector: async () => DEEP })
    assert.doesNotMatch(out, /Software - Infrastructure/)
    assert.doesNotMatch(out, /Oil & Gas Integrated/)
    assert.match(lineFor(out, 'Energy'), /XOM/, 'but the name is still counted in its sector')
})

test('the threshold is STATED, so a missing industry reads as our gap and not the market\'s', async () => {
    const out = await _coverageBySector({ listActiveBySector: async () => DEEP })
    assert.match(out, /at least 3 covered names/)
    assert.match(out, /a gap in OUR book/)
})

// ── what the book CONCLUDED ──────────────────────────────────────────────
//
// Asked why it kept a call at sector grain, the desk answered: "the book provides coverage, not
// directional analyst conclusions, so it does not establish bottom-up support." It was reading a
// list of tickers — the rating was fetched and dropped by the formatter. `bottom_up` is a claim
// about what our analysts THINK, so the mix has to be on the line for the basis to be choosable.

const rated = (bucket, ...ratings) => ratings.map((rating, i) => ({
    symbol: `${bucket.slice(0, 3).toUpperCase()}${i}`, sector: 'Technology', industry: bucket, rating,
}))

test('the rating mix is on every line, with the lean stated', async () => {
    const out = await _coverageBySector({ listActiveBySector: async () => rated('Semiconductors', 'buy', 'buy', 'buy') })
    assert.match(out, /3 buy/)
    assert.match(out, /BULLISH/)
})

test('a lean needs a MAJORITY, not merely more than the other side', async () => {
    // "1 buy, 2 hold" has no bears. Counting it bullish would let one opinion out of three become
    // bottom-up support for an overweight, which is the failure this threshold exists to stop.
    const out = await _coverageBySector({ listActiveBySector: async () => rated('Computer Hardware', 'buy', 'hold', 'hold') })
    const ln = lineFor(out, 'Computer Hardware')
    assert.match(ln, /1 buy, 2 hold/)
    assert.match(ln, /SPLIT/)
    assert.doesNotMatch(ln, /BULLISH/)
})

test('holds are not agreement, and an all-hold bucket says so', async () => {
    const out = await _coverageBySector({ listActiveBySector: async () => rated('Steel', 'hold', 'hold', 'hold') })
    assert.match(out, /SPLIT/)
})

test('a bearish majority reads BEARISH — the lean cuts both ways', async () => {
    const out = await _coverageBySector({ listActiveBySector: async () => rated('Gold', 'sell', 'sell', 'hold') })
    assert.match(out, /2 sell/)
    assert.match(out, /BEARISH/)
})

test('an unrated bucket says so rather than leaning on nothing', async () => {
    const out = await _coverageBySector({ listActiveBySector: async () => rated('Copper', null, null, null) })
    const ln = lineFor(out, 'Copper')
    assert.match(ln, /no ratings yet/)
    assert.doesNotMatch(ln, /BULLISH|BEARISH/)
})

test('the tool explains what the lean MEANS, so the basis can be chosen honestly', async () => {
    const out = await _coverageBySector({ listActiveBySector: async () => rated('Semiconductors', 'buy', 'buy', 'buy') })
    assert.match(out, /what our analysts CONCLUDED, not where they looked/)
})

test('a book with no industries at all still reads exactly as it did', async () => {
    // Every document carried only a sector before the backfill, and a half-migrated book must not
    // produce a broken table — it produces the old one.
    const out = await _coverageBySector({ listActiveBySector: async () => BOOK })
    assert.match(lineFor(out, 'Technology'), /NVDA, AMD/)
    assert.doesNotMatch(out, /^ {6}\S/m, 'nothing is indented as an industry')
})

// ── the turn context ─────────────────────────────────────────────────────────
test('the published view rides the TURN context, not the system prompt', () => {
    // A volatile block in the system tail sits ahead of the whole conversation in the cache prefix,
    // so the history breakpoint can never hit. This is the measured fix, not a style choice.
    const ctx = _buildTurnContext({ current_tilt: { id: 'tilt1', tilts: [{ sector: 'Energy' }] } })
    assert.match(ctx, /CURRENT PUBLISHED VIEW/)
    assert.match(ctx, /reaffirmed stance keeps its original clock/)
    assert.match(ctx, /tilt1/)
    assert.equal(_buildTurnContext({}), null, 'no published view → nothing attached')
    assert.equal(_buildTurnContext(undefined), null)
})

// ── the tool surface ─────────────────────────────────────────────────────────
test('the desk gets the top-down reads and NOT the stock-picking ones', () => {
    const names = TOOLS.map(t => t.name)
    for (const t of ['get_macro_snapshot', 'get_sector_snapshot', 'get_priced_in', 'get_coverage_by_sector']) {
        assert.ok(names.includes(t), `missing ${t}`)
    }
    // Pythia does not pick names or size positions — giving it these would invite it to.
    for (const t of ['compute_valuation', 'get_fundamentals', 'screen_candidates', 'check_broker_symbol', 'get_trading_context']) {
        assert.ok(!names.includes(t), `${t} belongs to another desk`)
    }
})

test('the argument-free tools come from the SHARED registry with an empty schema', () => {
    // They used to be hand-rolled objects on this array, which bypassed the one place tool schemas
    // live — and therefore the orphan/snapshot guards that watch it.
    for (const t of TOOLS.filter(t => ['get_priced_in', 'get_coverage_by_sector'].includes(t.name))) {
        assert.equal(t.input_schema.type, 'object')
        assert.deepEqual(t.input_schema.properties, {}, `${t.name} should take no arguments`)
    }
})

// ── message assembly ─────────────────────────────────────────────────────────
test('a first turn becomes ONE user message — an empty array is a 400 at the API', () => {
    // normalizeMessages takes (messages, maxCount) and does NOT append userPrompt. Passing it as the
    // second argument yields [] silently, and the failure only surfaces as
    // "messages: at least one message is required" once the request is already in flight.
    assert.deepEqual(_buildMessages({ userPrompt: 'Publish the house view.' }),
        [{ role: 'user', content: 'Publish the house view.' }])
    assert.deepEqual(_buildMessages({ messages: [], userPrompt: 'go' }), [{ role: 'user', content: 'go' }])
})

test('a continuing conversation is trimmed and coalesced, not replaced by the prompt', () => {
    const msgs = [
        { role: 'user', content: 'what is your read on energy?' },
        { role: 'assistant', content: 'Underweight.' },
    ]
    const out = _buildMessages({ messages: msgs, userPrompt: 'ignored when history exists' })
    assert.equal(out.length, 2)
    assert.equal(out[0].content, 'what is your read on energy?')
})

test('nothing to say yields an empty array rather than a phantom turn', () => {
    assert.deepEqual(_buildMessages({}), [])
})

test('the current view rides the turn without the monitor\'s bookkeeping', () => {
    const text = _buildTurnContext({ current_tilt: {
        id: 'tilt_1', regime: { name: 'r' }, tilts: [{ sector: 'Energy', stance: 'over', active_bp: 150 }],
        monitor: { next_check_at: 't', checks: 12, total_bp: 4.5 },
    } })
    assert.match(text, /"sector": "Energy"/)
    assert.doesNotMatch(text, /"checks"|total_bp|next_check_at/)
})
