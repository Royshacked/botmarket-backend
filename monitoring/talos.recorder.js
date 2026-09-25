// The Talos read RECORDER — the replay eval's input (docs/design/talos-replay-harness.md).
//
// WHAT IT IS. Every read Talos makes, written to disk as ONE bundle a replay can run a different
// model through: the exact prompt, the exact tool list, the whole trajectory (every tool call and
// its result, chart PNGs included), the verdict, the usage — and a DATA PACK fetched right after
// the read: raw candles for every symbol in scope on every rung of the ladder, the quotes, and a
// plain chart of the setup's own asset on every rung. The pack is what lets a candidate that asks
// for a rung the real read never pulled still get FROZEN data, not live data weeks later.
//
// WHAT IT IS NOT. It changes nothing about the read. `recordRead` is fire-and-forget after
// `_runRead` has its answer, every fetch inside is guarded, and a failure here is a log line —
// never a failed wake. Off (the default) it is one boolean check.
//
// WHERE. Two sinks, one per deployment shape (`config.talosRecordSink`): `disk` writes
// `<talosRecordDir>/<day>/<readId>.json` (gitignored: bundles carry users' live trading plans; the
// userId is hashed and nothing else about the user is written); `mongo` inserts the same bundle into
// the `talos_reads` collection, because the deployed instance's disk does not survive a deploy —
// `scripts/eval/talos-replay/pull-reads.mjs` brings those down into the disk layout.

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../services/config.js'
import { logger } from '../services/logger.service.js'
import { getDb } from '../providers/mongodb.provider.js'
import { _fetchCandleRows } from '../services/tools/marketData.tools.js'
import { cachedChart } from '../services/chartImgCache.service.js'
import { getQuotes } from '../providers/yahoofinance.provider.js'
import { TF_RUNGS, isFetchableRung } from '../services/setup.schema.js'

const LOG = '[talos.recorder]'

/** Bump when the bundle shape changes so the replay scripts can refuse what they cannot read. */
export const BUNDLE_VERSION = 1

/** The Mongo sink's collection. `pulled: true` is stamped by the pull script, nothing else writes it. */
export const COLLECTION = 'talos_reads'

export function isRecording() {
    return config.talosRecordReads
}

/** A stable, non-reversible id for the user — the same read of the same user groups, nobody is named. */
export function userHash(userId) {
    return createHash('sha256').update(String(userId ?? '')).digest('hex').slice(0, 16)
}

/**
 * Cache markers are a request-time concern of the Anthropic loop, not part of the read. A replay
 * re-stamps its own; a non-Anthropic candidate would 400 on them. Pure — returns a copy.
 */
export function stripCacheControl(messages) {
    return (messages ?? []).map(m => ({
        ...m,
        content: Array.isArray(m.content)
            ? m.content.map(b => { const { cache_control: _, ...rest } = b ?? {}; return rest })
            : m.content,
    }))
}

/**
 * The rungs a pack freezes: the PREMISE the plan was drawn on, the rung the read actually opened on,
 * and any rung the plan is paced on — deduped, coarse→fine, fetchable only. Pure.
 *
 * A pack is not free: a candle fetch per symbol per rung plus a headless-browser render per rung,
 * running beside live reads. These are the rungs a replay plausibly opens on; anything else it asks
 * for is a hole in the pack, which is what `errors` is for.
 */
export function packRungs(setup, rung) {
    const want = new Set([setup?.timeframe, rung, ...(setup?.pace_rungs ?? [])].filter(Boolean))
    return TF_RUNGS.filter(r => want.has(r) && isFetchableRung(r))
}

/**
 * The frozen market as of the read. `symbols` is the read's own scope (`symbolScope`), rungs are
 * `packRungs`. Every cell fetched independently and guarded, so one bad symbol/rung leaves a hole
 * (recorded in `errors`), not an empty pack. Charts are drawn for the setup's OWN asset only and
 * one at a time — a render is a headless-browser page, and this runs beside live reads that also
 * need the renderer.
 *
 * Deps injectable for the tests.
 */
export async function buildDataPack(setup, symbols, deps = {}) {
    const {
        fetchCandleRows = _fetchCandleRows,
        renderChart     = cachedChart,
        quotes          = getQuotes,
        rungs           = packRungs(setup, setup?.monitor_state?.timeframe),
    } = deps

    const asset  = String(setup?.asset ?? '').toUpperCase()
    const errors = []
    const note   = (what, err) => errors.push(`${what}: ${err?.message ?? err}`)

    const bars = {}
    await Promise.all(symbols.map(async (sym) => {
        bars[sym] = {}
        await Promise.all(rungs.map(async (tf) => {
            try {
                const { bars: rows } = await fetchCandleRows(sym, tf)
                bars[sym][tf] = rows ?? []
            } catch (err) { bars[sym][tf] = null; note(`candles ${sym}/${tf}`, err) }
        }))
    }))

    const charts = {}
    if (asset) {
        for (const tf of rungs) {
            try {
                const { png, source } = await renderChart(asset, tf, [])
                charts[tf] = { png, source }
            } catch (err) { charts[tf] = null; note(`chart ${asset}/${tf}`, err) }
        }
    }

    let quotesText = null
    try { quotesText = symbols.length ? await quotes(symbols) : '' }
    catch (err) { note('quotes', err) }

    return { asOf: new Date().toISOString(), rungs, symbols, bars, charts: asset ? { [asset]: charts } : {}, quotesText, errors }
}

/**
 * The bundle. Pure — everything it needs is handed in. `trace` is what `_runRead` observed on its
 * way to `result`; `meta` is what the caller knew about the wake (reason, price, scenario, ...).
 */
export function buildBundle({ setup, meta = {}, systemText, userText, trace = {}, result, pack = null, now = new Date() }) {
    const recordedAt = now.toISOString()
    return {
        v: BUNDLE_VERSION,
        readId: `${recordedAt.replace(/[-:.]/g, '').slice(0, 15)}_${setup?.id ?? 'nosetup'}_${randomBytes(2).toString('hex')}`,
        recordedAt,
        kind: meta.kind ?? null,
        setup: {
            id: setup?.id ?? null,
            userHash: userHash(setup?.userId),
            asset: setup?.asset ?? null,
            asset_class: setup?.asset_class ?? null,
            direction: setup?.direction ?? null,
            type: setup?.type ?? null,
            trade_mode: setup?.trade_mode ?? null,
            timeframe: setup?.timeframe ?? null,
            thesis: setup?.thesis ?? null,
            conviction: setup?.conviction ?? null,
            valid_until: setup?.valid_until ?? null,
            status: setup?.status ?? null,
            referenced_symbols: setup?.referenced_symbols ?? [],
            // Every scenario, not just the one on the table: the label is "did price reach a target
            // before the stop", and that is scenario arithmetic the labeler redoes from here.
            scenarios: setup?.scenarios ?? [],
            armed_scenario_id: setup?.armed_scenario_id ?? null,
            armed_leg_id: setup?.armed_leg_id ?? null,
            monitor_state: setup?.monitor_state ?? null,
            position_state: setup?.position_state ?? null,
        },
        wake: {
            reason: meta.reason ?? null,
            woke: meta.woke ?? null,
            price: meta.price ?? null,
            rung: meta.rung ?? null,
            pace: meta.pace ?? null,
            scenario: meta.scenario ?? null,
            zone: meta.zone ?? null,
            watched: meta.watched ?? null,
        },
        prompt: { systemText, userText, tools: trace.tools ?? null },
        routing: {
            model: trace.model ?? null,
            reasoningEffort: trace.reasoningEffort ?? null,
            thinking: trace.thinking ?? null,
            maxTokens: trace.maxTokens ?? null,
        },
        trajectory: {
            messages: stripCacheControl(trace.messages),
            stopReason: trace.stopReason ?? null,
            rounds: trace.rounds ?? 0,
            calls: trace.calls ?? [],
            usage: trace.usage ?? [],
            elapsedMs: trace.elapsedMs ?? null,
            error: trace.error ?? null,
        },
        result: result ?? null,
        pack,
    }
}

/** Where a bundle goes on disk: `<dir>/<YYYY-MM-DD>/<readId>.json`. Pure. */
export function bundlePath(dir, bundle) {
    return path.join(dir, bundle.recordedAt.slice(0, 10), `${bundle.readId}.json`)
}

/** The disk sink. Resolves to the file written. */
export function diskSink({ dir = config.talosRecordDir, write = writeFile, ensureDir = (d) => mkdir(d, { recursive: true }) } = {}) {
    return async (bundle) => {
        const file = bundlePath(dir, bundle)
        await ensureDir(path.dirname(file))
        await write(file, JSON.stringify(bundle))
        return file
    }
}

/**
 * The Mongo sink. One document per read, keyed by readId, in the app's own database. A bundle is
 * well under the 16 MB document cap (~1 MB with five charts) and the volume is a few hundred a
 * week, so no index is worth its write.
 */
export function mongoSink({ db = null } = {}) {
    return async (bundle) => {
        const conn = db ?? await getDb()
        await conn.collection(COLLECTION).insertOne({ _id: bundle.readId, ...bundle, pulled: false })
        return `${COLLECTION}/${bundle.readId}`
    }
}

function _sinkFor(name) {
    return name === 'mongo' ? mongoSink() : diskSink()
}

/**
 * Fetch the pack, build the bundle, hand it to the sink. Resolves to where it went, or null when
 * anything went wrong — and it logs rather than throws, because the caller does not await it.
 */
export async function recordRead({ setup, symbols = [], meta, systemText, userText, trace, result }, deps = {}) {
    const { sink = _sinkFor(config.talosRecordSink), pack: packDeps = {} } = deps
    try {
        // `meta.rung` is what this read ACTUALLY opened on, which is what a replay most wants
        // frozen — buildDataPack's own default reads the stored rung, one wake behind.
        const pack   = await buildDataPack(setup, symbols,
            { rungs: packRungs(setup, meta?.rung ?? setup?.monitor_state?.timeframe), ...packDeps })
        const bundle = buildBundle({ setup, meta, systemText, userText, trace, result, pack })
        const where  = await sink(bundle)
        logger.info(LOG, `[${setup?.id}] recorded ${bundle.readId} → ${where} (${bundle.trajectory.rounds} round(s), ${pack.errors.length} pack error(s))`)
        return where
    } catch (err) {
        logger.warn(LOG, `[${setup?.id}] record failed:`, err.message)
        return null
    }
}
