import Anthropic from '@anthropic-ai/sdk'
import { getDb } from '../providers/mongodb.provider.js'
import { getQuote, getTickerAggregates } from '../providers/yahoofinance.provider.js'
import { fetchChartImage } from '../providers/chartImg.provider.js'
import { buildStudies } from './evaluators/chart.evaluator.js'
import { userService } from '../api/user/user.service.js'
import { isAssetOpen, getMarketStatus } from '../services/market.service.js'
import { logger } from '../services/logger.service.js'
import { notifyCallReady, notifyCallExpiry } from '../services/tradeNotify.service.js'

// Hermes — the Kairos-call readiness monitor: a self-scheduling readiness loop (KAIROS_PLAN.md,
// Phase 2). Its own tick, its own collection (`kairos_calls`), sharing NO mutable state with Minos
// (the live idea monitor).
// Design: a CHEAP arithmetic gate (is price inside a mapped zone?) runs every wake; the EXPENSIVE
// four-axis LLM assessment fires only when a zone is tripped or the call is near expiry. Each
// assessment writes back the verdict + a self-chosen next_check_at (clamped to the call's cadence)
// + a running memo carried across wakes. Pre-entry readiness only — hands off at the enter card.

const LOG          = '[hermes.monitor]'
const COLLECTION   = 'kairos_calls'
const POLL_INTERVAL_MS = 60_000
// Only these are re-checked by the loop. `expiry_review` is triggered TIME-based on these two
// (via _isExpiring), so 'expiring' is NOT here — like 'ready', it's an awaiting-user state (an
// edit card was fired) that Phase 3 re-queues to 'waiting' on accept, preventing card spam.
const ACTIVE_STATUSES  = ['waiting', 'watching']
const EXPIRY_THRESHOLD_MS = 15 * 60_000   // run the final "expiry review" within 15m of valid_until
// A single check must never wedge the loop. If any IO inside _checkCall (vision assess / chart /
// price fetch) hangs with no timeout, the awaited call never returns, `_running` stays true, and
// every later tick skips forever. Bounding each check lets a hung one reject so the loop recovers.
const CHECK_TIMEOUT_MS = 90_000

let _timer   = null
let _running = false

export const hermesService = { start, stop }

function start() {
    if (_timer) return
    logger.info(LOG, 'Kairos monitor starting')
    _tick()
    _timer = setInterval(_tick, POLL_INTERVAL_MS)
}

function stop() {
    if (!_timer) return
    clearInterval(_timer)
    _timer = null
    logger.info(LOG, 'Kairos monitor stopped')
}

// Race a promise against a timeout so a hung await can't wedge the loop. The underlying promise is
// left to settle on its own (best-effort); the caller just stops waiting on it. Pure — exported for test.
export function _withTimeout(promise, ms) {
    let t
    const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`check timed out after ${ms}ms`)), ms) })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

// ─── Poll loop ────────────────────────────────────────────────────────────────
async function _tick() {
    if (_running) { logger.warn(LOG, 'previous tick still running — skipping'); return }
    _running = true
    try {
        const db  = await getDb()
        const now = new Date().toISOString()
        // Due = active status AND (never checked OR next_check_at has passed). ISO strings compare
        // lexicographically for same-format UTC timestamps, so $lte on the string is correct.
        const calls = await db.collection(COLLECTION).find({
            status: { $in: ACTIVE_STATUSES },
            $or: [
                { 'monitor_state.next_check_at': null },
                { 'monitor_state.next_check_at': { $lte: now } },
            ],
        }).toArray()

        if (!calls.length) return
        logger.info(LOG, `checking ${calls.length} due call(s)`)
        for (const call of calls) {
            try { await _withTimeout(_checkCall(db, call, Date.now(), _deps), CHECK_TIMEOUT_MS) }
            catch (err) { logger.error(LOG, `checkCall failed for ${call.id}:`, err.message) }
        }
    } catch (err) {
        logger.error(LOG, 'tick failed:', err.message)
    } finally {
        _running = false
    }
}

// Orchestrate one call: cheap gate → (only if tripped/expiring) expensive assessment → persist.
// `deps` is injectable so tests exercise the branching without real price/LLM/notify IO.
export async function _checkCall(db, call, nowMs, deps = _deps) {
    const expiring = _isExpiring(call, nowMs)

    // Market closed for this asset → no entry can happen; skip the check (no price fetch, no LLM)
    // and SLEEP until the market reopens (not the normal cadence). Expiry review is exempt — a
    // call may need to roll/expire at the close.
    if (!expiring && !deps.isAssetOpen(call.asset, call.asset_class)) {
        const patch  = _scheduledPatch(call, nowMs)   // also resets a stale 'watching' → 'waiting'
        const openMs = deps.nextOpenMs?.(call.asset, call.asset_class)
        if (Number.isFinite(openMs) && openMs > nowMs) patch['monitor_state.next_check_at'] = new Date(openMs).toISOString()
        const entry = _timelineEntry('closed', { nowMs, call, nextAt: patch['monitor_state.next_check_at'] })
        await _persist(db, call.id, patch, entry)
        return { reason: 'closed' }
    }

    const price  = await deps.getPrice(call)
    const zone   = Number.isFinite(price) ? _zoneGate(call, price) : null

    const reason = expiring ? 'expiry_review' : (zone ? 'zone_trip' : 'scheduled')

    // Cheap path: not near a zone and not expiring → no LLM, just reschedule further out.
    if (reason === 'scheduled') {
        const patch = _scheduledPatch(call, nowMs)
        const entry = _timelineEntry('scheduled', { nowMs, price, call, nextAt: patch['monitor_state.next_check_at'] })
        await _persist(db, call.id, patch, entry)
        return { reason }
    }

    // Expensive path: the four-axis readiness read (LLM + vision).
    const raw = await deps.assess(call, zone, { reason, price }, deps)
    if (!raw) {
        // Assessment failed — retry soon (min cadence) rather than dropping the call.
        const patch = _scheduledPatch(call, nowMs, true)
        const entry = _timelineEntry(reason, { nowMs, price, call, nextAt: patch['monitor_state.next_check_at'], failed: true })
        await _persist(db, call.id, patch, entry)
        return { reason, failed: true }
    }

    const { set, fireCard, lastAssessment } = _applyAssessment(call, zone, raw, nowMs, reason)
    const entry = _timelineEntry(reason, { nowMs, price, zone, call, raw, nextAt: set['monitor_state.next_check_at'], fetched: _fetchedLabel(call) })
    await _persist(db, call.id, set, entry)
    if (fireCard) {
        try { await deps.onCard(call, lastAssessment) }
        catch (err) { logger.warn(LOG, `onCard failed for ${call.id}:`, err.message) }
    }
    return { reason, verdict: raw.verdict, fireCard }
}

// Persist the $set patch and, when given, APPEND a journal entry (capped to the last TIMELINE_MAX).
async function _persist(db, id, set, logEntry = null) {
    const update = { $set: set }
    if (logEntry) update.$push = { 'monitor_state.timeline': { $each: [logEntry], $slice: -TIMELINE_MAX } }
    await db.collection(COLLECTION).updateOne({ id }, update)
}

// ─── Pure decision helpers (unit-tested) ───────────────────────────────────────

// The arithmetic gate. Scan every zone's band; return the FIRST zone price is inside (others
// stay latent), or null. This is what makes multi-zone "long the reclaim OR the pullback" work.
export function _zoneGate(call, price) {
    if (!Number.isFinite(price)) return null
    const zones = Array.isArray(call?.entry_zones) ? call.entry_zones : []
    for (const z of zones) {
        const lo = Number(z?.lower), hi = Number(z?.upper)
        if (Number.isFinite(lo) && Number.isFinite(hi) && price >= lo && price <= hi) return z
    }
    return null
}

// Within EXPIRY_THRESHOLD of valid_until (or already past) → time for the final expiry review.
export function _isExpiring(call, nowMs, thresholdMs = EXPIRY_THRESHOLD_MS) {
    if (!call?.valid_until) return false
    const exp = Date.parse(call.valid_until)
    if (!Number.isFinite(exp)) return false
    return nowMs >= exp - thresholdMs
}

// Clamp the agent's requested gap (minutes) to the call's cadence, return an ISO next_check_at.
export function _computeNextCheckAt(nowMs, requestedMin, cadence) {
    const lo = Number(cadence?.min_gap_min) || 1
    const hi = Number(cadence?.max_gap_min) || 60
    let m = Number(requestedMin)
    if (!Number.isFinite(m)) m = hi
    m = Math.max(lo, Math.min(hi, m))
    return new Date(nowMs + m * 60_000).toISOString()
}

// Status transition from the verdict (+ why we were looking).
export function _nextStatus(verdict, reason) {
    if (verdict === 'enter')      return 'ready'
    if (verdict === 'edit')       return 'expiring'   // edit card fired; awaiting the user
    if (verdict === 'let_expire') return 'expired'
    return reason === 'zone_trip' ? 'watching' : 'waiting'
}

// Actually past valid_until (not merely within the pre-expiry review window, which _isExpiring covers).
export function _isPastExpiry(call, nowMs) {
    if (!call?.valid_until) return false
    const exp = Date.parse(call.valid_until)
    return Number.isFinite(exp) && nowMs >= exp
}

// Reconcile the model's verdict against WHY we assessed + the clock, so two off-menu cases can't
// misbehave:
//   • let_expire on a zone trip would terminally kill a call still inside its validity window —
//     let_expire is only on the menu for an expiry review, so downgrade it to stand_aside.
//   • an expiry review that's actually PAST valid_until but still won't commit (wait/stand_aside)
//     would re-queue to 'waiting' and be re-assessed (chart + vision LLM) every cadence forever —
//     force it to let_expire so the call terminates. Within the pre-expiry window (not yet past),
//     wait/stand_aside stay legitimate. Pure.
export function _effectiveVerdict(verdict, reason, pastExpiry) {
    if (verdict === 'let_expire' && reason !== 'expiry_review') return 'stand_aside'
    if (reason === 'expiry_review' && pastExpiry && verdict !== 'enter' && verdict !== 'edit') return 'let_expire'
    return verdict
}

// Snap a proposed price to the nearest reference level on the correct side of entry, so the
// stop/TP land on pre-mapped structure rather than a conjured number. No suitable level → keep
// the proposed price with ref=null.
export function _snapToReference(price, refs, dir, entry) {
    if (!Number.isFinite(price)) return { price: null, ref: null }
    const list = (Array.isArray(refs) ? refs : []).filter(r => {
        const rp = Number(r?.price)
        if (!Number.isFinite(rp)) return false
        if (dir === 'below') return rp < entry
        if (dir === 'above') return rp > entry
        return true
    })
    if (!list.length) return { price, ref: null }
    let best = list[0], bestD = Math.abs(Number(list[0].price) - price)
    for (const c of list) {
        const d = Math.abs(Number(c.price) - price)
        if (d < bestD) { best = c; bestD = d }
    }
    return { price: Number(best.price), ref: best.id ?? null }
}

// Clean an enter proposal: snap stop/TP to reference structure, clamp size to the user cap,
// compute R:R off the first target. Pure.
export function _finalizeProposal(p, call, zone) {
    if (!p || typeof p !== 'object') return null

    const side    = zone?.side ?? call?.bias ?? 'long'
    const entry   = Number(p.entry)
    const refs    = call?.reference_levels ?? []
    const maxSize = Number(call?.sizing?.max_size) || 0

    // Size: server-authoritative cap. Default to the cap; clamp any proposed size into (0, max].
    let size = Number(p.size)
    if (!Number.isFinite(size) || size <= 0) size = maxSize
    size = Math.min(size, maxSize)

    const stopDir = side === 'short' ? 'above' : 'below'
    const tpDir   = side === 'short' ? 'below' : 'above'
    const stopSnap = _snapToReference(Number(p.stop), refs, stopDir, entry)

    const tps = (Array.isArray(p.take_profit) ? p.take_profit : []).map(t => {
        const s = _snapToReference(Number(t?.price), refs, tpDir, entry)
        return { price: s.price, ref: s.ref }
    })

    const stop    = stopSnap.price
    const firstTp = tps[0]?.price
    const rr = (Number.isFinite(entry) && Number.isFinite(stop) && Number.isFinite(firstTp) && Math.abs(entry - stop) > 0)
        ? Math.round((Math.abs(firstTp - entry) / Math.abs(entry - stop)) * 100) / 100
        : null

    return {
        entry:       Number.isFinite(entry) ? entry : null,
        stop:        Number.isFinite(stop) ? stop : null,
        stop_ref:    stopSnap.ref,
        take_profit: tps,
        size,
        rr,
        rationale:   p.rationale ?? null,
    }
}

// Turn a raw assessment into the persisted $set patch (+ whether to fire a card). Pure.
export function _applyAssessment(call, zone, raw, nowMs, reason) {
    // Resolve the effective verdict first (guards the two off-menu cases in _effectiveVerdict),
    // then derive proposal / status / card from it — never from the raw model verdict.
    const verdict  = _effectiveVerdict(raw.verdict, reason, _isPastExpiry(call, nowMs))
    const nextAt   = _computeNextCheckAt(nowMs, raw.next_check_min, call?.cadence)
    const proposal = verdict === 'enter' ? _finalizeProposal(raw.proposal, call, zone) : null
    const status   = _nextStatus(verdict, reason)
    // Running memo: update only when the assessment provides one, else carry the prior note.
    const memo = raw.memo_update != null && raw.memo_update !== ''
        ? String(raw.memo_update)
        : (call?.monitor_state?.memo ?? '')

    const lastAssessment = {
        at:            new Date(nowMs).toISOString(),
        reason,
        zone_id:       zone?.id ?? null,
        timeframe_used: raw.timeframe_used ?? null,
        read:          raw.read ?? null,
        market:        raw.market ?? null,
        news:          raw.news ?? null,
        price_action:  raw.price_action ?? null,
        patterns_seen: Array.isArray(raw.patterns_seen) ? raw.patterns_seen : [],
        verdict,
        ...(proposal ? { proposal } : {}),
        ...(raw.edit_proposal ? { edit_proposal: raw.edit_proposal } : {}),
        next_check_at: nextAt,
        memo_update:   raw.memo_update ?? null,
    }

    const set = {
        status,
        'monitor_state.armed_zone_id':    zone?.id ?? call?.monitor_state?.armed_zone_id ?? null,
        'monitor_state.chosen_timeframe': raw.timeframe_used ?? null,
        'monitor_state.check_count':      (call?.monitor_state?.check_count ?? 0) + 1,
        'monitor_state.memo':             memo,
        'monitor_state.next_check_at':    nextAt,
        'monitor_state.last_assessment':  lastAssessment,
    }

    // 'let_expire' now fires a card too (the expiry notification) — previously it was a silent
    // terminal 'expired'. enter → ready card; edit → re-map card; let_expire → expired card.
    return { set, fireCard: ['enter', 'edit', 'let_expire'].includes(verdict), lastAssessment }
}

// Cheap-path reschedule (no assessment ran). Idle → check further out (max gap); after a failed
// assessment → retry soon (min gap). Bumps the check counter. Pure $set patch.
export function _scheduledPatch(call, nowMs, short = false) {
    const cadence = call?.cadence ?? {}
    const gap = short ? (Number(cadence.min_gap_min) || 1) : (Number(cadence.max_gap_min) || 60)
    return {
        // No zone tripped (or market closed) → the call isn't actively being assessed, so a stale
        // 'watching' returns to 'waiting'. Keeps 'watching' meaning exactly "price in a zone now".
        ...(call?.status === 'watching' ? { status: 'waiting' } : {}),
        'monitor_state.check_count':   (call?.monitor_state?.check_count ?? 0) + 1,
        'monitor_state.next_check_at': new Date(nowMs + gap * 60_000).toISOString(),
    }
}

// ─── Timeline / monologue (the monitor journal) ────────────────────────────────
// An append-only, first-person log of EVERY wake — the "brain" the call pop-out reads. Cheap
// wakes (closed / not-near-a-zone) get a one-line arithmetic note; a real assessment carries the
// model's own first-person `read` + the four-axis detail. Kept compact and capped on the doc.
const TIMELINE_MAX = 50

function _fmt(n) { return Number.isFinite(Number(n)) ? String(Number(n)) : '?' }
function _num(n) { return Number.isFinite(Number(n)) ? Number(n) : null }

// "188–189" (single) or "188–189, 192–193" (multi). { text, multi }.
export function _zonesLabel(call) {
    const zones = Array.isArray(call?.entry_zones) ? call.entry_zones : []
    const parts = zones
        .filter(z => Number.isFinite(Number(z?.lower)) && Number.isFinite(Number(z?.upper)))
        .map(z => `${_fmt(z.lower)}–${_fmt(z.upper)}`)
    return { text: parts.length ? parts.join(', ') : '(no zones)', multi: parts.length > 1 }
}

// Whole-minute gap between now and an ISO next-check (≥1), or null if unparseable.
function _gapMin(nextAt, nowMs) {
    const t = Date.parse(nextAt)
    if (!Number.isFinite(t)) return null
    return Math.max(1, Math.round((t - nowMs) / 60_000))
}

// What the assessment deterministically pulls (mirrors _defaultAssess) — the "fetched" line.
function _fetchedLabel(call) {
    const tf = call?.timeframe_ladder?.at(-1) ?? '15min'
    return `chart ${tf} (vwap+ema50+vol) · ~30 candles · price`
}

// When the model gives no first-person note, synthesize one from the verdict so the log still reads.
function _verdictFallbackNote(raw) {
    switch (raw?.verdict) {
        case 'enter':       return 'This finally looks ready — proposing an entry.'
        case 'wait':        return "In the zone, but the trigger isn't here yet — waiting."
        case 'stand_aside': return 'Conditions are against this one right now — standing aside.'
        case 'let_expire':  return 'Nothing materialized — letting it expire.'
        case 'edit':        return 'The setup has drifted — proposing a re-map.'
        default:            return 'Read the chart; no change.'
    }
}

// Build one compact append-only journal entry for a wake. Pure — `at` derives from nowMs so tests
// are deterministic. reason ∈ closed | scheduled | zone_trip | expiry_review.
export function _timelineEntry(reason, { nowMs, price = null, zone = null, call, raw = null, nextAt = null, fetched = null, failed = false }) {
    const at  = new Date(nowMs).toISOString()
    const gap = _gapMin(nextAt, nowMs)

    if (reason === 'closed') {
        return { at, reason, price: null, verdict: null,
            note: `Market's closed for ${call?.asset ?? 'this asset'} — holding. I'll look again at the open.`,
            next_check_at: nextAt }
    }
    if (reason === 'scheduled') {
        const zl = _zonesLabel(call)
        return { at, reason, price: _num(price), verdict: null,
            note: `Price ${_fmt(price)} is outside my zone${zl.multi ? 's' : ''} ${zl.text}. No setup forming${gap ? ` — checking back in ${gap}m` : ''}.`,
            next_check_at: nextAt }
    }
    if (failed) {
        return { at, reason, price: _num(price), verdict: null,
            note: `Went to read ${call?.asset ?? 'the chart'} but the data/vision call failed — retrying shortly.`,
            next_check_at: nextAt }
    }
    // A real assessment (zone tripped or expiry review) — the model's own read + four-axis detail.
    return {
        at, reason,
        price:   _num(price),
        zone_id: zone?.id ?? null,
        fetched,
        verdict: raw?.verdict ?? null,
        note:    (raw?.read && String(raw.read).trim()) ? String(raw.read).trim() : _verdictFallbackNote(raw),
        axes: {
            market:        raw?.market ?? null,
            news:          raw?.news ?? null,
            price_action:  raw?.price_action ?? null,
            patterns_seen: Array.isArray(raw?.patterns_seen) ? raw.patterns_seen : [],
        },
        next_check_at: nextAt,
    }
}

// ─── Default IO deps (real price / LLM assessment / card) ───────────────────────
const _deps = {
    getPrice:    _defaultGetPrice,
    assess:      _defaultAssess,
    onCard:      _defaultOnCard,
    isAssetOpen: (asset, assetClass) => isAssetOpen(asset, assetClass),
    nextOpenMs:  (asset, assetClass) => getMarketStatus(asset, assetClass).nextOpenMs,
}

async function _defaultGetPrice(call) {
    try {
        const q = await getQuote(call.asset)
        const p = Number(q?.price ?? q?.regularMarketPrice ?? q?.last ?? q?.c)
        if (Number.isFinite(p)) return p
    } catch { /* fall through to candles */ }
    try {
        const rows = await getTickerAggregates(String(call.asset).toUpperCase(), { timeSpan: 'minute', multiplier: 1, from: Date.now() - 3 * 24 * 60 * 60 * 1000 })
        const last = rows?.at(-1)
        if (Number.isFinite(last?.close)) return last.close
    } catch { /* give up */ }
    return null
}

// Post the readiness/expiry card to social chat (notify + route to the call pop-out). `enter`
// → "ready to enter"; `edit`/`let_expire` → the expiry card (re-map or delete). The fresh
// `assessment` carries the proposal / edit rationale (the persisted doc may lag). Best-effort:
// a notify failure must never wedge the monitor loop.
async function _defaultOnCard(call, assessment) {
    logger.info(LOG, 'READINESS CARD', { id: call.id, asset: call.asset, verdict: assessment?.verdict, entry: assessment?.proposal?.entry })
    const verdict = assessment?.verdict
    try {
        if (verdict === 'enter')            await notifyCallReady(call, assessment)
        else if (verdict === 'edit')        await notifyCallExpiry(call, 'edit', assessment?.edit_proposal?.why ?? null)
        else if (verdict === 'let_expire')  await notifyCallExpiry(call, 'expired')
    } catch (err) {
        logger.warn(LOG, `onCard notify failed for ${call.id}:`, err.message)
    }
}

// ─── Real four-axis assessment (LLM + vision) — mocked in unit tests ───────────
const _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const ASSESS_MODEL    = 'claude-sonnet-4-6'
const ALLOWED_MODELS  = new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8'])
const ALLOWED_EFFORTS = new Set(['off', 'low', 'high'])
// The visible reply is a small JSON object, but when thinking is on the hidden reasoning tokens
// ALSO count toward max_tokens — so give generous headroom to avoid truncating the JSON.
const ASSESS_MAX_TOKENS          = 900
const ASSESS_MAX_TOKENS_THINKING = 16_000

// Map the reasoning-effort knob onto Anthropic adaptive extended thinking — mirrors
// anthropic.provider.js. 'off'/invalid → null (no thinking block, zero reasoning cost). Adaptive
// (NOT budget_tokens, which 400s on Opus 4.8) + effort is supported across all allowed models. Pure.
export function _thinkingConfig(effort) {
    return (effort === 'low' || effort === 'high')
        ? { thinking: { type: 'adaptive' }, output_config: { effort } }
        : null
}

// Hermes (this monitor) runs under the user's AI preferences: read their synced `hermesModel` +
// `hermesReasoning` from the account preferences and use them for the readiness assessment. Falls
// back to Sonnet / no-thinking when unset, invalid, or unreadable. All allowed models are
// vision-capable, so the chart read is safe whichever the user picks.
async function _hermesRouting(userId) {
    if (!userId) return { model: ASSESS_MODEL, reasoningEffort: 'off' }
    try {
        const prefs = await userService.getPreferences(userId)
        return {
            model:           ALLOWED_MODELS.has(prefs?.hermesModel)      ? prefs.hermesModel     : ASSESS_MODEL,
            reasoningEffort: ALLOWED_EFFORTS.has(prefs?.hermesReasoning) ? prefs.hermesReasoning : 'off',
        }
    } catch {
        return { model: ASSESS_MODEL, reasoningEffort: 'off' }
    }
}

// Pull the first text block from an assessment response. With extended thinking on, content[0] is a
// thinking block, so a bare content[0].text would miss the JSON — find the text block explicitly. Pure.
export function _assessText(msg) {
    const block = (msg?.content ?? []).find(b => b?.type === 'text')
    return block?.text ?? ''
}

const _ASSESS_SYSTEM = `You are Kairos, a discretionary day/swing trader running a readiness check on a pre-built trade "call".
You are given the call (zones, reference levels, patterns), a rendered chart image, recent candles, the current price, and why you were woken.
Decide if NOW is a good moment to enter around the armed zone. Weight price action over indicators. Be strict — most checks should NOT be "enter".
Assess four axes: market conditions, news/catalyst, price action (from the chart), and whether the mapped patterns are actually happening.
On an expiry_review, choose enter (it finally looks good), edit (re-map/roll — provide edit_proposal), or let_expire.
Always include "read": ONE short, plain first-person sentence — what you see right now and what you're doing about it (e.g. "Price is coiling just under the zone, no trigger yet — I'll keep waiting."). This is your live monologue, so keep it human and specific.
Output ONLY a JSON object, no prose:
{"timeframe_used":"15min","read":"<one first-person sentence>","market":{"read":"...","score":"supportive|neutral|adverse"},"news":{"read":"...","score":"supportive|neutral|adverse|blocking"},"price_action":{"read":"...","strength":"strong|weak|mixed"},"patterns_seen":[{"id":"p1","present":true,"note":"..."}],"verdict":"enter|wait|stand_aside|let_expire|edit","proposal":{"entry":0,"stop":0,"take_profit":[{"price":0}],"rationale":"..."},"next_check_min":15,"memo_update":"..."}
Include "proposal" only when verdict is "enter"; include "edit_proposal":{"why":"...","changes":{}} only when verdict is "edit".`

export async function _defaultAssess(call, zone, ctx, _d) {
    try {
        const tf = call.timeframe_ladder?.at(-1) ?? '15min'
        const [png, candlesText] = await Promise.all([
            fetchChartImage(String(call.asset).toUpperCase(), tf, buildStudies('vwap, ema(50), volume')).catch(() => null),
            _candlesText(call.asset, tf).catch(() => ''),
        ])

        const userText = [
            `CALL: ${JSON.stringify({ asset: call.asset, trade_type: call.trade_type, bias: call.bias, entry_zones: call.entry_zones, reference_levels: call.reference_levels, patterns: call.patterns, timeframe_ladder: call.timeframe_ladder, valid_until: call.valid_until })}`,
            `ARMED ZONE: ${zone ? JSON.stringify(zone) : 'none (expiry review)'}`,
            `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
            `REASON WOKEN: ${ctx.reason}`,
            `PRIOR MEMO: ${call.monitor_state?.memo || '(none)'}`,
            candlesText ? `RECENT CANDLES (${tf}):\n${candlesText}` : '',
        ].filter(Boolean).join('\n\n')

        const content = png
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: userText }]
            : userText

        const { model, reasoningEffort } = await _hermesRouting(call.user_id)
        const thinking = _thinkingConfig(reasoningEffort)
        const msg = await _client.messages.create({
            model,
            max_tokens: thinking ? ASSESS_MAX_TOKENS_THINKING : ASSESS_MAX_TOKENS,
            system: [{ type: 'text', text: _ASSESS_SYSTEM, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content }],
            ...(thinking ?? {}),
        })
        return _extractJSON(_assessText(msg))
    } catch (err) {
        logger.warn(LOG, `assessment failed for ${call.id}:`, err.message)
        return null
    }
}

async function _candlesText(asset, tf) {
    const spec = tf === 'day' ? { timeSpan: 'day', multiplier: 1 }
        : tf === '1hr' || tf === '4hr' ? { timeSpan: 'hour', multiplier: 1 }
        : { timeSpan: 'minute', multiplier: tf === '5min' ? 5 : tf === '30min' ? 30 : 15 }
    const rows = await getTickerAggregates(String(asset).toUpperCase(), { ...spec, from: Date.now() - 10 * 24 * 60 * 60 * 1000 })
    return (rows ?? []).slice(-30).map(c => {
        const d = new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
        return `${d} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`
    }).join('\n')
}

function _extractJSON(text) {
    const start = text.indexOf('{')
    if (start === -1) throw new Error(`no JSON in assessment — ${text.slice(0, 120)}`)
    let depth = 0
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1))
    }
    throw new Error('unclosed JSON in assessment')
}
