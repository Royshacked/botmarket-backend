import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    sizeFromChannels, normalizeViews, normalizeReactions, normalizeExclusions, formatSizing, expandChannelDraft, withBases, readSizingInputs, _setSizingIO,
    CAP_BP, MAX_DZ, REACTIONS, K_EVIDENCE, CHANNEL_CONFIDENCE,
} from '../../api/strategy/channelSizing.service.js'
import { normalizeTilt, overlappingRows, incoherentRows } from '../../api/strategy/tilt.service.js'

// Step 6: the table sized from a few channel calls. What must hold: the arithmetic is beta × dz,
// the table balances and respects its caps, it never holds a sector beside its own industry, and the
// desk's own rows and stated reactions win over the numbers.

// A small map: two sectors, one with two industry funds.
const MAP = {
    'Energy':                             { symbol: 'XLE', weighting: 'cap', exact: true },
    'Utilities':                          { symbol: 'XLU', weighting: 'cap', exact: true },
    'Financial Services':                 { symbol: 'XLF', weighting: 'cap', exact: true },
    'Banks - Regional':                   { symbol: 'KRE', weighting: 'equal', exact: true },
    'Insurance - Life':                   { symbol: 'KIE', weighting: 'equal', exact: false },
    'Insurance - Property & Casualty':    { symbol: 'KIE', weighting: 'equal', exact: false },
}
const beta = (symbol, channel_id, b, significant = true) => ({ symbol, channel_id, beta: b, significant })
const BETAS = [
    beta('XLE', 'energy_cost', 0.046),
    beta('XLU', 'discount_rate', -0.013),
    beta('XLF', 'discount_rate', 0.005),
    beta('KRE', 'discount_rate', 0.024),
    beta('KIE', 'discount_rate', 0.004),
    beta('XLU', 'energy_cost', 0.001, false),   // measured zero — transmits nothing
]
const size = (over = {}) => sizeFromChannels({ betas: BETAS, proxyMap: MAP, ...over })
const net = (rows) => rows.reduce((s, r) => s + r.active_bp, 0)

test('the expected move is beta × dz, and only significant betas transmit', () => {
    const { candidates } = size({ views: [{ channel_id: 'energy_cost', dz: 1 }] })
    const xle = candidates.find(c => c.bucket === 'Energy')
    assert.equal(xle.e, CHANNEL_CONFIDENCE * 0.046)
    assert.equal(candidates.find(c => c.bucket === 'Utilities').e, 0, 'a measured zero moves nothing')
})

test('the table balances, signs follow the expected move, and every row is basis channels', () => {
    const { rows } = size({ views: [{ channel_id: 'energy_cost', dz: 1 }, { channel_id: 'discount_rate', dz: -1 }] })
    assert.ok(rows.length >= 2)
    assert.ok(Math.abs(net(rows)) <= 10, `net ${net(rows)}bp`)
    assert.ok(rows.every(r => r.basis === 'channels'))
    assert.equal(rows.find(r => r.bucket === 'Energy').stance, 'over')
    assert.deepEqual(incoherentRows({ tilts: rows }), [], 'stance and weight agree on every row')
})

test('no row breaks its grain cap', () => {
    const { rows } = size({ views: [{ channel_id: 'energy_cost', dz: 3 }, { channel_id: 'discount_rate', dz: 3 }] })
    for (const r of rows) {
        const cap = ['Energy', 'Utilities', 'Financial Services'].includes(r.bucket) ? CAP_BP.sector : CAP_BP.industry
        assert.ok(Math.abs(r.active_bp) <= cap, `${r.bucket} ${r.active_bp}bp`)
    }
})

test('a sector splits into its industries only where they diverge, and never sits beside them', () => {
    // Rates down 1z: KRE -2.4% vs XLF -0.5% — the industries diverge, so Financials is split.
    const split = size({ views: [{ channel_id: 'discount_rate', dz: -1 }] })
    const buckets = split.candidates.map(c => c.bucket)
    assert.ok(buckets.includes('Banks - Regional') && !buckets.includes('Financial Services'))
    assert.deepEqual(overlappingRows({ tilts: normalizeTilt({ tilts: split.rows }).tilts }), [])

    // Energy only: nothing in Financials moves, so it stays whole (and at benchmark weight).
    const whole = size({ views: [{ channel_id: 'energy_cost', dz: 1 }] })
    assert.ok(whole.candidates.some(c => c.bucket === 'Financial Services'))
})

test('a shared fund is one row, named for the bucket it is exact for or the first by name, and says what else it covers', () => {
    const { candidates, rows } = size({ views: [{ channel_id: 'discount_rate', dz: -2 }] })
    const kie = candidates.filter(c => c.symbol === 'KIE')
    assert.equal(kie.length, 1)
    assert.equal(kie[0].bucket, 'Insurance - Life')
    const row = rows.find(r => r.bucket === 'Insurance - Life')
    if (row) assert.match(row.rationale, /also stands for Insurance - Property & Casualty/)
})

test('a reaction scales the measured beta — opposite flips the bucket', () => {
    const views = [{ channel_id: 'energy_cost', dz: 1 }, { channel_id: 'discount_rate', dz: -1 }]
    const base = size({ views }).rows.find(r => r.bucket === 'Energy')
    const flipped = size({ views, reactions: [{ bucket: 'Energy', channel_id: 'energy_cost', reaction: 'opposite' }] })
        .rows.find(r => r.bucket === 'Energy')
    assert.equal(base.stance, 'over')
    assert.equal(flipped.stance, 'under')
    assert.equal(flipped.drivers[0].multiplier, REACTIONS.opposite)
})

test('the desk\'s own rows win, block their overlaps, and the sized rows absorb their net', () => {
    // Rates UP: Energy (oil) gains, Utilities loses — two sides to absorb a manual +50 with.
    const manual = [{ bucket: 'Financial Services', stance: 'over', active_bp: 50, basis: 'bottom_up' }]
    const { rows } = size({ views: [{ channel_id: 'discount_rate', dz: 1 }, { channel_id: 'energy_cost', dz: 1 }], manualRows: manual })
    assert.ok(!rows.some(r => ['Financial Services', 'Banks - Regional', 'Insurance - Life'].includes(r.bucket)),
        'no sized row for the manual sector or its industries')
    assert.ok(Math.abs(net(rows) + 50) <= 10, `sized rows net ${net(rows)}bp, should offset the manual +50`)
})

test('own rows too large to absorb leave the sized rows balanced among themselves, and say so', () => {
    const manual = [{ bucket: 'Financial Services', stance: 'over', active_bp: 400, basis: 'bottom_up' }]
    const { rows, notes } = size({ views: [{ channel_id: 'discount_rate', dz: 1 }, { channel_id: 'energy_cost', dz: 1 }], manualRows: manual })
    assert.ok(rows.length >= 2, 'the sized rows survive rather than shrinking to nothing')
    assert.ok(Math.abs(net(rows)) <= 10)
    assert.match(notes.join(' '), /own rows net \+400bp, more than the sized rows can offset/)
})

test('an exclusion leaves the bucket out', () => {
    const { rows, notes } = size({ views: [{ channel_id: 'energy_cost', dz: 1 }], exclude: ['Energy'] })
    assert.ok(!rows.some(r => r.bucket === 'Energy'))
    assert.match(notes.join(' '), /Excluded by the desk: Energy/)
})

test('a call no fund is measurably exposed to is reported, not silently dropped', () => {
    const { silent, notes } = size({ views: [{ channel_id: 'fiscal_impulse', dz: 1 }] })
    assert.deepEqual(silent, ['fiscal_impulse'])
    assert.match(notes.join(' '), /size nothing/)
})

test('calls: unknown channels, absurd and duplicate moves are dropped; "stays put" (0) is a call', () => {
    const known = new Set(['energy_cost', 'discount_rate', 'fx_usd'])
    const v = normalizeViews([
        { channel_id: 'energy_cost', dz: 1 }, { channel_id: 'energy_cost', dz: 2 }, { channel: 'discount_rate', dz: -0.5 },
        { channel_id: 'nope', dz: 1 }, { channel_id: 'fx_usd', dz: 0 }, { channel_id: 'x', dz: MAX_DZ + 1 }, { channel_id: 'energy_cost', dz: 'a' },
    ], known)
    assert.deepEqual(v.map(x => [x.channel_id, x.dz]), [['energy_cost', 1], ['discount_rate', -0.5], ['fx_usd', 0]])
})

// ── the base rate: only the departure from history is sized ──────────────────

const LATEST = { channels: { discount_rate: { z: 3.97, base_dz: -1.78 }, energy_cost: { z: 1.66, base_dz: -0.4 } } }

test('a call is sized on its DEVIATION from the base rate', () => {
    const [v] = withBases([{ channel_id: 'discount_rate', dz: -0.8 }], LATEST)
    assert.equal(v.base_dz, -1.78)
    assert.equal(v.deviation, 0.98)
    const { candidates } = size({ views: [v] })
    assert.equal(candidates.find(c => c.bucket === "Utilities").e, CHANNEL_CONFIDENCE * -0.013 * 0.98)
})

test('a call that repeats the base rate sizes nothing — it is already priced', () => {
    const views = withBases([{ channel_id: 'discount_rate', dz: -1.78 }, { channel_id: 'energy_cost', dz: -0.4 }], LATEST)
    assert.deepEqual(views.map(v => v.deviation), [0, 0])
    assert.equal(size({ views }).rows.length, 0)
})

test('the two calls that looked opposite were the same view, against the base rate', () => {
    // Measured: Pythia called real yields -0.8, then +0.8, on identical data. Base -1.78.
    const [a] = withBases([{ channel_id: 'discount_rate', dz: -0.8 }], LATEST)
    const [b] = withBases([{ channel_id: 'discount_rate', dz: 0.8 }], LATEST)
    assert.equal(Math.sign(a.deviation), Math.sign(b.deviation), 'both say "less reversion than usual"')
})

test('a call against the base rate, and one reversing the standing call, are flagged', () => {
    const [against] = withBases([{ channel_id: 'discount_rate', dz: 0.8 }], LATEST)
    assert.ok(against.flags.includes('against_base_rate'))
    const [withHistory] = withBases([{ channel_id: 'discount_rate', dz: -0.5 }], LATEST)
    assert.ok(!withHistory.flags.includes('against_base_rate'))

    const standing = [{ channel_id: 'discount_rate', dz: -0.8, base_dz: -1.78, deviation: 0.98 }]
    const [flip] = withBases([{ channel_id: 'discount_rate', dz: -2.5 }], LATEST, standing)
    assert.ok(flip.flags.includes('reverses_standing_call'), 'deviation +0.98 -> -0.72')
    assert.equal(flip.previous_dz, -0.8)
    const [kept] = withBases([{ channel_id: 'discount_rate', dz: 0.8 }], LATEST, standing)
    assert.ok(!kept.flags.includes('reverses_standing_call'), 'same side of the base rate is not a reversal')
})

test('a channel with no base rate is sized on the raw call and says so', () => {
    const [v] = withBases([{ channel_id: 'fx_usd', dz: 0.5 }], LATEST)
    assert.equal(v.base_dz, null)
    assert.equal(v.deviation, 0.5)
    assert.ok(v.flags.includes('no_base_rate'))
})

test('the preview shows call, base and what is sized, with each flag spelled out', () => {
    const views = withBases([{ channel_id: 'discount_rate', dz: 0.8 }, { channel_id: 'energy_cost', dz: 0.5 }], LATEST)
    const text = formatSizing(size({ views }), views)
    assert.match(text, /discount_rate\s+call +\+0\.80z\s+base -1\.78z\s+sized on +\+2\.58z/)
    assert.match(text, /AGAINST THE BASE RATE/)
})

test('reactions: only the three words, on a real bucket', () => {
    const r = normalizeReactions([
        { bucket: 'Energy', channel_id: 'energy_cost', reaction: 'stronger', reason: 'x' },
        { bucket: 'Energy', channel_id: 'energy_cost', reaction: '1.7' },
        { bucket: 'Narnia', channel_id: 'energy_cost', reaction: 'weaker' },
    ])
    assert.deepEqual(r.map(x => x.reaction), ['stronger'])
})

test('the preview says what to change, and what it will not do', () => {
    const views = [{ channel_id: 'energy_cost', dz: 1 }, { channel_id: 'discount_rate', dz: -1 }]
    const text = formatSizing(size({ views }), views)
    assert.match(text, /PROPOSED TABLE from 2 channel call/)
    assert.match(text, /change the CALLS/)
    assert.match(text, /Do not retype these rows/)
    assert.match(formatSizing({ rows: [], candidates: [], notes: [] }, []), /No valid channel calls/)
})

// ── the draft path ───────────────────────────────────────────────────────────

test('a draft carrying only channel calls expands into sized rows stamped with today\'s z', async () => {
    const tilt = { benchmark: 'SPX', channel_views: [{ channel_id: 'energy_cost', dz: 1 }, { channel_id: 'discount_rate', dz: -1 }], tilts: [] }

    _setSizingIO({ betas: async () => BETAS, latest: async () => ({ channels: { energy_cost: { z: 1.66 } } }), evidence: async () => [], record: async () => null })
    const expanded = await expandChannelDraft(tilt, '2026-10-01T00:00:00.000Z')
    assert.ok(expanded.tilts.length >= 1)
    assert.equal(expanded.channel_views[0].z_at_set, 1.66, 'the call is graded from the z it was made at')

    const stored = normalizeTilt(expanded)
    assert.equal(stored.channel_views[0].dz, 1)
    assert.ok(stored.tilts.every(t => t.drivers === null || Array.isArray(t.drivers)))
})

test('a fund the engine never fitted cannot split its sector away', () => {
    // KRE/KIE absent from the betas entirely (added to the map after the last fit): Financials must
    // stay whole and keep its own exposure, not vanish into two industries "expected" at zero.
    const betas = BETAS.filter(b => !['KRE', 'KIE'].includes(b.symbol))
    const { candidates } = sizeFromChannels({ views: [{ channel_id: 'discount_rate', dz: -1 }], betas, proxyMap: MAP })
    assert.ok(candidates.some(c => c.bucket === 'Financial Services'))
    assert.ok(!candidates.some(c => c.bucket === 'Banks - Regional'))
})

test('a draft without channel calls is returned untouched', async () => {
    const draft = { tilts: [{ bucket: 'Energy', stance: 'over', active_bp: 100 }] }
    assert.equal(await expandChannelDraft(draft), draft)
})

test('a bucket the calls favour is overweight whatever the other rows do — sides scale, rows never flip', () => {
    // Three gainers and one loser: the old demeaning shifted the small gainer to zero or below.
    const views = [{ channel_id: 'energy_cost', dz: 1 }, { channel_id: 'discount_rate', dz: -1 }]
    const { rows, candidates } = size({ views })
    for (const r of rows) {
        const c = candidates.find(x => x.bucket === r.bucket)
        assert.equal(Math.sign(r.active_bp), Math.sign(c.e), `${r.bucket}: row sign must be its expected move's sign`)
    }
    assert.ok(Math.abs(net(rows)) <= 10)
})

test('calls that move every bucket the same way say so instead of inventing a short', () => {
    const { rows, notes } = size({ views: [{ channel_id: 'energy_cost', dz: 1 }] , betas: [beta('XLE', 'energy_cost', 0.046), beta('XLU', 'energy_cost', 0.02)] })
    assert.equal(rows.length, 0)
    assert.match(notes.join(' '), /moves the same way/)
})

test('many small gainers against one capped loser keep their largest few, and the table still balances', () => {
    // Measured on Pythia's first sized run: eleven gainers vs Airlines at the 100bp industry cap.
    // Dropping every under-minimum row at once left only the loser, unbalanced. Here: three gainers
    // (Energy, Utilities, Financials) against Airlines, which splits out of an unfitted Industrials.
    const map = { ...MAP, 'Industrials': { symbol: 'XLI', exact: true }, 'Airlines, Airports & Air Services': { symbol: 'JETS', exact: true } }
    const betas = [...BETAS, beta('JETS', 'energy_cost', -0.06), beta('XLU', 'energy_cost', 0.01), beta('XLF', 'energy_cost', 0.008), beta('XLI', 'discount_rate', 0.001, false)]
    const { rows } = sizeFromChannels({ views: [{ channel_id: 'energy_cost', dz: 1 }], betas, proxyMap: map })
    const overs = rows.filter(r => r.active_bp > 0), unders = rows.filter(r => r.active_bp < 0)
    assert.ok(overs.length >= 1 && unders.length >= 1, JSON.stringify(rows))
    assert.ok(Math.abs(net(rows)) <= 10, `net ${net(rows)}bp`)
    assert.ok(rows.every(r => Math.abs(r.active_bp) >= 25))
})

test('an exclusion carries its reason onto the view, and a missing one is called out', async () => {
    const x = normalizeExclusions(['Energy', { bucket: 'Utilities', reason: 'regulated returns reset' }, { bucket: 'Narnia' }])
    assert.deepEqual(x, [{ bucket: 'Energy', reason: null }, { bucket: 'Utilities', reason: 'regulated returns reset' }])
    const { notes } = size({ views: [{ channel_id: 'energy_cost', dz: 1 }], exclude: ['Energy'] })
    assert.match(notes.join(' '), /Excluded WITHOUT a reason: Energy/)

    _setSizingIO({ betas: async () => BETAS, latest: async () => ({ channels: {} }), evidence: async () => [], record: async () => null })
    const draft = await expandChannelDraft({ channel_views: [{ channel_id: 'discount_rate', dz: -1 }], exclude: [{ bucket: 'Utilities', reason: 'r' }], tilts: [] })
    assert.deepEqual(normalizeTilt(draft).exclusions, [{ bucket: 'Utilities', reason: 'r' }])
})

test('excluding a sector also excludes its industries when the calls split it', () => {
    // Rates down 1z splits Financials into Banks - Regional / Insurance; the exclusion must follow.
    const { rows, candidates } = size({ views: [{ channel_id: 'discount_rate', dz: -1 }, { channel_id: 'energy_cost', dz: 1 }],
        exclude: [{ bucket: 'Financial Services', reason: 'our book disagrees' }] })
    assert.ok(candidates.some(c => c.bucket === 'Banks - Regional'), 'the sector did split')
    assert.ok(!rows.some(r => ['Financial Services', 'Banks - Regional', 'Insurance - Life'].includes(r.bucket)))
})

// ── the industry evidence ────────────────────────────────────────────────────

test('evidence adds to the expected move in the same units, at the measured rate', () => {
    const evidence = { XLE: { score: 0.5, beat: 0.8, surprise: 0.05, momentum: 0.1 } }
    const { candidates } = size({ views: [{ channel_id: 'energy_cost', dz: 1 }], evidence })
    const xle = candidates.find(c => c.bucket === 'Energy')
    assert.equal(xle.channelPart, CHANNEL_CONFIDENCE * 0.046)
    assert.equal(xle.evidencePart, K_EVIDENCE * 0.5)
    assert.equal(xle.e, CHANNEL_CONFIDENCE * 0.046 + K_EVIDENCE * 0.5)
})

test('with no channel calls the evidence alone sizes a table, and those rows say so', () => {
    const evidence = { XLE: { score: 0.5 }, XLU: { score: -0.5 }, XLF: { score: 0.3 } }
    const { rows } = size({ views: [], evidence })
    assert.ok(rows.length >= 2)
    assert.ok(rows.every(r => r.basis === 'evidence'))
    assert.equal(rows.find(r => r.bucket === 'Energy').stance, 'over')
    assert.equal(rows.find(r => r.bucket === 'Utilities').stance, 'under')
    assert.ok(Math.abs(net(rows)) <= 10)
    assert.match(rows[0].rationale, /industry evidence/)
})

test('a channel view and contrary evidence offset; the row is labelled by what carries it', () => {
    // Rates down 1z: Utilities +1.3% from the channel; evidence -0.5 takes off 1.75%.
    const withEv = size({ views: [{ channel_id: 'discount_rate', dz: -1 }], evidence: { XLU: { score: -0.5 } } }).candidates.find(c => c.bucket === 'Utilities')
    assert.ok(withEv.e < 0, 'the evidence outweighs a small channel part')
    const ch = size({ views: [{ channel_id: 'energy_cost', dz: 1 }, { channel_id: 'discount_rate', dz: -1 }], evidence: { XLE: { score: -0.1 } } })
    assert.equal(ch.rows.find(r => r.bucket === 'Energy').basis, 'channels')
})

test('a draft with no calls is still sized where there is evidence — that is how tech gets rows', async () => {
    _setSizingIO({ betas: async () => BETAS, latest: async () => ({ channels: {} }),
        evidence: async () => [{ _id: 'XLE', evidence: 0.5 }, { _id: 'XLU', evidence: -0.5 }] })
    const out = await expandChannelDraft({ tilts: [] })
    assert.ok(out.tilts.some(r => r.bucket === 'Energy' && r.basis === 'evidence'))
    const stored = normalizeTilt(out)
    assert.equal(stored.tilts.find(r => r.bucket === 'Energy').evidence.score, 0.5)
    _setSizingIO({ evidence: async () => [] })
})

test('the preview names the basis of every row and works with no calls at all', () => {
    const r = size({ views: [], evidence: { XLE: { score: 0.5 }, XLU: { score: -0.5 } } })
    const text = formatSizing(r, [])
    assert.match(text, /PROPOSED TABLE from the industry evidence alone/)
    assert.match(text, /\[evidence\]/)
})

test('the channel term is discounted for being a forecast; the measured evidence is not', () => {
    const { candidates } = size({ views: [{ channel_id: 'energy_cost', dz: 1 }], evidence: { XLE: { score: 0.5 } } })
    const xle = candidates.find(c => c.bucket === 'Energy')
    assert.equal(xle.channelPart, CHANNEL_CONFIDENCE * 0.046)
    assert.equal(xle.evidencePart, K_EVIDENCE * 0.5, 'evidence is already calibrated on realized returns')
    assert.ok(CHANNEL_CONFIDENCE > 0 && CHANNEL_CONFIDENCE < 1)
})

test('a fund grading industries in several sectors is ONE row, standing for all of them', () => {
    // MOO published as three +40bp rows — Agricultural Inputs, Farm Products, Machinery — one fund,
    // three sectors (tilt_SPX_11807d9e). Rebuilt here with each of those sectors splitting.
    const map = {
        'Basic Materials': { symbol: 'XLB', exact: true }, 'Consumer Defensive': { symbol: 'XLP', exact: true },
        'Industrials': { symbol: 'XLI', exact: true },
        'Agricultural Inputs': { symbol: 'MOO', exact: false }, 'Agricultural Farm Products': { symbol: 'MOO', exact: false },
        'Agricultural - Machinery': { symbol: 'MOO', exact: false },
        'Utilities': { symbol: 'XLU', exact: true },
    }
    const betas = [beta('MOO', 'energy_cost', 0.03), beta('XLB', 'energy_cost', 0.001, false), beta('XLP', 'energy_cost', 0.001, false),
        beta('XLI', 'energy_cost', 0.001, false), beta('XLU', 'energy_cost', -0.02)]
    const { candidates, rows } = sizeFromChannels({ views: [{ channel_id: 'energy_cost', dz: 1 }], betas, proxyMap: map })
    const moo = candidates.filter(c => c.symbol === 'MOO')
    assert.equal(moo.length, 1, 'one candidate for one fund')
    assert.equal(moo[0].bucket, 'Agricultural - Machinery', 'first by name when the fund is exact for none')
    assert.deepEqual(moo[0].stands_for, ['Agricultural - Machinery', 'Agricultural Farm Products', 'Agricultural Inputs'])
    assert.equal(rows.filter(r => ['Agricultural Inputs', 'Agricultural Farm Products', 'Agricultural - Machinery'].includes(r.bucket)).length, 1)
})

test('a measured call record replaces the placeholder confidence; without one the placeholder stands', async () => {
    _setSizingIO({ betas: async () => BETAS, latest: async () => ({ channels: {} }), evidence: async () => [],
        record: async () => ({ confidence: 0.7, measured: true }) })
    assert.equal((await readSizingInputs()).channelConfidence, 0.7)
    _setSizingIO({ record: async () => null })
    assert.equal((await readSizingInputs()).channelConfidence, CHANNEL_CONFIDENCE)

    const strong = size({ views: [{ channel_id: 'energy_cost', dz: 1 }], channelConfidence: 0.7 }).candidates.find(c => c.bucket === 'Energy')
    assert.equal(strong.channelPart, 0.7 * 0.046)
})
