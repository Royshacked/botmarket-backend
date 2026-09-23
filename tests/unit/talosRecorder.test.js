import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
    BUNDLE_VERSION, COLLECTION, userHash, stripCacheControl, buildDataPack, packRungs, buildBundle, bundlePath,
    diskSink, mongoSink, recordRead, isRecording,
} from '../../monitoring/talos.recorder.js'
import { normalizeSetup } from '../../services/setup.schema.js'

// The read recorder (docs/design/talos-replay-harness.md): what a bundle carries, that the pack is
// hole-tolerant, and that nothing here can throw back into the read.

const SETUP = {
    id: 'setup_NVDA_1', userId: 'u_roy', kind: 'setup', status: 'watching',
    ...normalizeSetup({
        asset: 'NVDA', asset_class: 'stock', direction: 'long', type: 'swing', trade_mode: 'classical', timeframe: '1hr',
        entry_zones: [{ id: 'ez1', lower: 237.8, upper: 238.6, quantity: 100 }],
        stop_zones:  [{ id: 'sz1', lower: 234.8, upper: 235.9 }],
        tp_zones:    [{ id: 'tz1', lower: 246, upper: 246, quantity: 100 }],
        conditions:  [{ id: 'c1', text: 'CHoCH up on the 15m', weight: 'primary', mode: 'judgment', persistence: 'live' }],
    }),
    referenced_symbols: ['SMH'],
    monitor_state: { timeframe: '15min', memo: 'watching the reclaim', guards: [] },
}

const TRACE = {
    model: 'claude-sonnet-4-6', reasoningEffort: 'low', thinking: null, maxTokens: 2500,
    tools: [{ name: 'get_chart' }],
    messages: [
        { role: 'user', content: 'SETUP: ...' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_chart', input: { ticker: 'NVDA', timeframe: '15min' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'chart', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: [{ type: 'text', text: '{"verdict":"wait"}' }] },
    ],
    stopReason: 'end_turn', rounds: 2, calls: ['get_chart'], usage: [{ input_tokens: 10 }, { input_tokens: 12 }], elapsedMs: 1234,
}

test('recorder: off by default — one boolean, no side effects', () => {
    const was = process.env.TALOS_RECORD_READS
    delete process.env.TALOS_RECORD_READS
    assert.equal(isRecording(), false)
    process.env.TALOS_RECORD_READS = '1'
    assert.equal(isRecording(), true)
    if (was === undefined) delete process.env.TALOS_RECORD_READS; else process.env.TALOS_RECORD_READS = was
})

test('recorder: the user is hashed, never named', () => {
    const h = userHash('u_roy')
    assert.equal(h.length, 16)
    assert.equal(h, userHash('u_roy'))
    assert.notEqual(h, userHash('u_marce'))
    assert.ok(!h.includes('roy'))
})

test('recorder: stripCacheControl drops the markers and leaves the messages alone', () => {
    const out = stripCacheControl(TRACE.messages)
    assert.equal(out.length, 4)
    assert.equal(out[0].content, 'SETUP: ...')
    assert.equal('cache_control' in out[2].content[0], false)
    assert.equal(out[2].content[0].content, 'chart')
    // A copy, not a mutation — the live loop's markers are its own business.
    assert.ok('cache_control' in TRACE.messages[2].content[0])
    assert.deepEqual(stripCacheControl(undefined), [])
})

test('recorder: the bundle carries prompt, routing, trajectory, verdict and every scenario', () => {
    const b = buildBundle({
        setup: SETUP,
        meta: { kind: 'pre_entry', reason: 'candle', price: 238.2, rung: '15min', ladder: ['4hr', '2hr', '1hr', '30min', '15min'], scenario: SETUP.scenarios[0], zone: null },
        systemText: 'SYS', userText: 'USER', trace: TRACE,
        result: { verdict: 'wait', _tools: ['get_chart'] },
        pack: { asOf: 'x', errors: [] },
        now: new Date('2026-09-21T14:30:00.000Z'),
    })
    assert.equal(b.v, BUNDLE_VERSION)
    assert.match(b.readId, /^20260921T143000_setup_NVDA_1_[0-9a-f]{4}$/)
    assert.equal(b.kind, 'pre_entry')
    assert.equal(b.setup.userHash, userHash('u_roy'))
    assert.equal('userId' in b.setup, false)
    assert.equal(b.setup.scenarios.length, SETUP.scenarios.length)
    assert.deepEqual(b.setup.referenced_symbols, ['SMH'])
    assert.equal(b.wake.price, 238.2)
    assert.equal(b.wake.rung, '15min')
    assert.equal(b.prompt.systemText, 'SYS')
    assert.equal(b.prompt.userText, 'USER')
    assert.deepEqual(b.prompt.tools, [{ name: 'get_chart' }])
    assert.equal(b.routing.model, 'claude-sonnet-4-6')
    assert.equal(b.trajectory.rounds, 2)
    assert.deepEqual(b.trajectory.calls, ['get_chart'])
    assert.equal(b.trajectory.usage.length, 2)
    assert.equal('cache_control' in b.trajectory.messages[2].content[0], false)
    assert.equal(b.result.verdict, 'wait')
    assert.equal(b.pack.asOf, 'x')
})

test('recorder: an empty trace (the read threw before routing) still builds a bundle', () => {
    const b = buildBundle({ setup: SETUP, systemText: 'SYS', userText: 'USER', trace: { error: 'boom' }, result: { _failReason: 'io' } })
    assert.equal(b.routing.model, null)
    assert.deepEqual(b.trajectory.messages, [])
    assert.equal(b.trajectory.rounds, 0)
    assert.equal(b.result._failReason, 'io')
})

test('recorder: the data pack covers every symbol × every rung, charts for the asset only, and a bad cell is a hole', async () => {
    const asked = []
    const pack = await buildDataPack(SETUP, ['NVDA', 'SMH'], {
        rungs: ['1hr', '15min'],
        fetchCandleRows: async (sym, tf) => {
            asked.push(`${sym}/${tf}`)
            if (sym === 'SMH' && tf === '15min') throw new Error('yahoo down')
            return { cfg: {}, bars: [{ timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }] }
        },
        renderChart: async (sym, tf) => {
            if (tf === '15min') throw new Error('renderer busy')
            return { png: `PNG-${sym}-${tf}`, source: 'own' }
        },
        quotes: async (syms) => syms.map(s => `${s}: $1.00`).join('\n'),
    })
    assert.deepEqual(asked.sort(), ['NVDA/15min', 'NVDA/1hr', 'SMH/15min', 'SMH/1hr'])
    assert.equal(pack.bars.NVDA['1hr'].length, 1)
    assert.equal(pack.bars.SMH['15min'], null)
    assert.equal(pack.charts.NVDA['1hr'].png, 'PNG-NVDA-1hr')
    assert.equal(pack.charts.NVDA['15min'], null)
    assert.equal('SMH' in pack.charts, false)
    assert.equal(pack.quotesText, 'NVDA: $1.00\nSMH: $1.00')
    assert.deepEqual(pack.errors.sort(), ['candles SMH/15min: yahoo down', 'chart NVDA/15min: renderer busy'])
    assert.deepEqual(pack.rungs, ['1hr', '15min'])
    assert.ok(pack.asOf)
})

// A pack is a candle fetch per symbol per rung PLUS a headless-browser render per rung, running
// beside live reads. It freezes what a replay plausibly opens on — never every rung in scope.
test('recorder: a pack freezes the premise, the rung read on, and any rung the plan is paced on', () => {
    assert.deepEqual(packRungs({ timeframe: 'day' }, '1hr'), ['day', '1hr'])
    assert.deepEqual(packRungs({ timeframe: '1hr' }, '1hr'), ['1hr'], 'deduped')
    assert.deepEqual(packRungs({ timeframe: 'day', pace_rungs: ['15min', '4hr'] }, '15min'),
        ['day', '4hr', '15min'], 'canonical order whatever order they arrive in')
    assert.deepEqual(packRungs({ timeframe: '1min' }, '5min'), ['5min'], 'never an unfetchable rung')
    assert.deepEqual(packRungs({}, null), [], 'nothing known yet is not an empty pack by accident')
})

const PACK_DEPS = { rungs: ['1hr'], fetchCandleRows: async () => ({ bars: [] }), renderChart: async () => ({ png: 'P', source: 'own' }), quotes: async () => 'NVDA: $1' }

test('recorder: the disk sink writes one JSON file under <dir>/<day>/ and recordRead returns its path', async () => {
    const writes = []
    const dirs   = []
    const file = await recordRead(
        { setup: SETUP, symbols: ['NVDA'], meta: { kind: 'pre_entry', reason: 'candle' }, systemText: 'SYS', userText: 'USER', trace: TRACE, result: { verdict: 'wait' } },
        { sink: diskSink({ dir: 'rec', ensureDir: async (d) => dirs.push(d), write: async (f, body) => writes.push({ f, body }) }), pack: PACK_DEPS },
    )
    assert.equal(writes.length, 1)
    assert.equal(file, writes[0].f)
    assert.equal(path.dirname(file), dirs[0])
    assert.match(path.basename(path.dirname(file)), /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(file.startsWith('rec'))
    const parsed = JSON.parse(writes[0].body)
    assert.equal(parsed.v, BUNDLE_VERSION)
    assert.equal(parsed.setup.id, 'setup_NVDA_1')
    assert.equal(parsed.pack.charts.NVDA['1hr'].png, 'P')
    assert.equal(parsed.pack.quotesText, 'NVDA: $1')
    // The pull script reproduces the same path from the bundle alone.
    assert.equal(bundlePath('rec', parsed), file)
})

test('recorder: the mongo sink inserts one document keyed by readId, unpulled', async () => {
    const inserted = []
    const db = { collection: (name) => ({ insertOne: async (doc) => { inserted.push({ name, doc }) } }) }
    const where = await recordRead(
        { setup: SETUP, symbols: ['NVDA'], meta: { kind: 'pre_entry' }, systemText: 'SYS', userText: 'USER', trace: TRACE, result: { verdict: 'wait' } },
        { sink: mongoSink({ db }), pack: PACK_DEPS },
    )
    assert.equal(inserted.length, 1)
    assert.equal(inserted[0].name, COLLECTION)
    assert.equal(inserted[0].doc._id, inserted[0].doc.readId)
    assert.equal(inserted[0].doc.pulled, false)
    assert.equal(inserted[0].doc.setup.id, 'setup_NVDA_1')
    assert.equal(where, `${COLLECTION}/${inserted[0].doc.readId}`)
})

test('recorder: a failed sink is a null and a log line — it never throws back into the read', async () => {
    const file = await recordRead(
        { setup: SETUP, symbols: [], meta: {}, systemText: 'S', userText: 'U', trace: TRACE, result: {} },
        { sink: async () => { throw new Error('disk full') }, pack: { ladder: [], quotes: async () => '' } },
    )
    assert.equal(file, null)
})
