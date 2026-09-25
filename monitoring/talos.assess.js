import Anthropic from '@anthropic-ai/sdk'
import { getQuotes }             from '../providers/yahoofinance.provider.js'
import { sessionPhase }          from '../services/market.service.js'
import { logger }                from '../services/logger.service.js'
import { extractFirstJSON }      from './parsers/llmReply.parser.js'
import { assessRouting, candleRows as _candleRows, formatCandles, indicatorsText,
    ASSESS_MAX_TOKENS as MAX_TOKENS, ASSESS_MAX_TOKENS_THINKING as MAX_TOKENS_THINKING, assessSystem,
    bookAssessUsage, lensLine, legText, legsText } from './assess.shared.js'
import { _allText, _formatEventRisk } from './assess.shared.js'
import { _thinkingConfig, advanceToolLoopCache, _finalizeServerTools } from '../providers/anthropic.provider.js'
import { buildAssessTools, makeAssessToolRunner } from './assessTools.js'
import { declaredConditions, pickScenario, scenarioLabel, paceRungs, resolveRung, allowedVerdicts, legPrice } from '../services/setup.schema.js'
import { config } from '../services/config.js'
import { isRecording, recordRead } from './talos.recorder.js'
import { runOpenAICompatRead } from '../providers/openaiCompat.provider.js'

// Talos's read — the model call behind every wake (docs/design/talos-per-candle.md).
//
// EVERY READ OPENS CHEAP. The model is handed numbers — the last candles on its rung, the price,
// its memo, what it armed — and nothing else. The chart, the indicators, the structure reads, the
// correlations and the web are TOOLS it calls when the numbers cannot answer. What a read costs is
// the model's own decision, per read; the image that used to arrive before it asked for anything
// is gone.
//
// SHARED: the tool kit and its dispatch (monitoring/assessTools.js, built on the same registry
// schemas and handler factories every agent uses), the thinking config, the model routing and the
// text extraction. Those are the pipe. NOT shared: the prompts, which are this desk's judgment.

const LOG = '[talos.assess]'

const _client = new Anthropic({ apiKey: config.anthropicApiKey })

/** Verdicts Talos may return pre-entry. Anything off-menu is coerced to 'wait' by the monitor. */
export const READINESS_VERDICTS = new Set(['enter', 'wait', 'stand_aside', 'edit', 'let_expire'])

/**
 * Everything an in-position read may EVER decide. Which of these a given read is offered is
 * `allowedVerdicts(watchedLegs)` — the menu follows the legs the user made conditional, and the
 * monitor refuses anything outside it.
 */
export const MANAGEMENT_VERDICTS = new Set(['hold', 'add_leg', 'take_partial', 'move_stop', 'exit_now'])

/** The tool set for a setup — the shared monitor kit, unfiltered. What bounds cost is `symbolScope`. */
export function buildToolsFor(_setup) {
    return buildAssessTools()
}

/**
 * Everything this wake is allowed to look at: the setup's own asset plus whatever Mentor extracted
 * from the condition text at build. Free text can name any ticker; the fetch stays bounded by what
 * was actually authored. Pure.
 */
export function symbolScope(setup) {
    return [...new Set([
        String(setup?.asset ?? '').toUpperCase().trim(),
        ...(setup?.referenced_symbols ?? []).map(s => String(s).toUpperCase().trim()),
    ].filter(Boolean))]
}

/**
 * The rung this wake OPENS on, and therefore the candle whose close paced it: whatever the last
 * read said it wanted to look at next, else the PREMISE, else the coarsest rung this setup is paced
 * on. The model picks it — a read that is confidently wrong never feels unsure, so it never climbs
 * on its own; letting it choose the rung up front is what stops the noisiest view deciding setups
 * built on structure.
 *
 * Falling back to the premise rather than the finest rung (as it did until 2026-09-23, when the
 * fence was the derived ±2 ladder) is both cheaper and more honest: the FIRST read of a plan opens
 * on the chart that plan was drawn on, and walks down when it has a reason to. Every step runs
 * through `resolveRung`, so named rungs beat the premise — "watch it on the 15min" is not a
 * preference the fallback chain can talk its way around.
 */
export function openingRung(setup) {
    return resolveRung(setup?.monitor_state?.timeframe, setup)
        ?? resolveRung(setup?.timeframe, setup)
        ?? paceRungs(setup)[0]
}

/**
 * What the model is told about rungs. THE SET IS PRINTED, never merely enforced: a request that is
 * silently dropped teaches the model nothing, and it will ask again next wake.
 */
function _ladderLine(setup, rungs, tf) {
    const named   = (setup?.pace_rungs ?? []).length > 0
    const premise = setup?.timeframe || rungs[0]
    return `RUNGS`
        + `\n  PREMISE (what this plan was drawn on): ${premise}`
        + `\n  YOU MAY BE READ ON: ${rungs.join(', ')}${named ? ' — chosen deliberately; not yours to move' : ''}`
        + `\n  YOU ARE ON: ${tf} — you are read again at its next close`
        + `\n  You may CHART any rung at any time. This list is only about when you are read NEXT.`
}

// ─── Opening context ──────────────────────────────────────────────────────────

/**
 * What a read starts with: the recent candles on its rung, the indicators computed from them, and
 * the live prices of the names the setup leans on. Text only — no chart. Each fetch is
 * independently guarded so a failed provider degrades its own block to empty rather than killing
 * the read.
 *
 * Deps injectable so the monitor's tests exercise this without network IO.
 */
export async function openingContext(setup, tf, deps = {}) {
    const { candleRows = _candleRows, quotes = getQuotes } = deps
    const asset      = String(setup.asset).toUpperCase()
    const refSymbols = (setup.referenced_symbols ?? []).slice(0, 6)

    const [bars, refQ] = await Promise.all([
        candleRows(asset, tf).catch(() => []),
        refSymbols.length ? quotes(refSymbols).catch(() => '') : Promise.resolve(''),
    ])
    // ONE fetch, two blocks. The indicators are arithmetic on the bars already in hand — no second
    // fetch, no tool round trip, no model call.
    return { candles: formatCandles(bars), indicators: indicatorsText(asset, bars, tf), refQ }
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
//
// One core both reads share — how to spend, how to be woken, how to answer — and a tail per read
// that says what the question is. The core is what this design changed; the tails carry the
// judgment each read owned before.

const _CORE = `HOW YOU LOOK. You open with numbers, not a picture: the recent candles on your rung, the live price, your own memo from last time. Read them first. Call get_chart when a condition needs a SHAPE the rows cannot show you — structure, a pattern, a discretionary read of how price is behaving. Call get_indicators when a condition names a level the plan was built on. Call the structure, correlation, positioning or search tools when a condition actually rests on them. Do NOT call a tool to confirm what the rows already say, and do not pull the chart out of habit: every call is money the user is paying for this read, and a read that spent nothing because the numbers answered is a good read.

WHEN YOU ARE READ AGAIN. At the close of the rung you are on, "next_expensive_in" closes from now — YOU set that below. "next_timeframe" is the rung you want to open on next time, and the two together are your pace: a coarser rung and a longer countdown mean fewer, bigger looks. Pick the rung from the ones RUNGS says you may be read on — anything else is ignored and you stay where you are. Charting is separate and unrestricted: pull any timeframe a condition needs, whatever you are paced on. Between your reads, the cheap pass you configure with "watch" keeps an eye on the numbers and wakes you early if anything moves.

"guards" ARE THE PRICES THAT MUST NOT WAIT FOR A CANDLE. Between your reads nothing looks at this trade except a cheap price check against these lines. Do not arm one for what the next close will show you anyway; arm one where price arriving would change your answer NOW — the trigger, the level that breaks the premise, the level where the stop starts being pressed. Each is {"price":311.5,"direction":"above|below|any","means":"entry|invalidation|manage"}; "any" is a touch from either side. Every guard is rewritten from scratch each read, so what you do not re-arm is forgotten. Arm the levels that matter and no more.

"next_expensive_in" IS HOW FAR THIS IS FROM BEING DECIDABLE, in closes of the rung you are on — not a budget, and not how often you would like to run. You are the only thing here that can answer it: if a pattern still needs two more legs to form, or a level is far away and nothing is near it, say 6 or 12 and mean it. Reading again next candle to look at the same half-built shape costs the user real money for no information. Say 1 when the next close genuinely could change your answer. The most you may say is 24.

"watch" IS WHAT A NUMBERS-ONLY PASS SHOULD CHECK between now and then — {"rung":"15min","indicators":["vwap","ema(20)"]}. Every close until your next read, a cheap pass gets those candles and those indicators and the plan's conditions, and wakes you early if anything fired or it could not tell. Name only what a NUMBER could settle. If the whole question is a shape forming, or news, or anything a row of OHLCV cannot answer, return "watch":null — the setup then rests until your countdown elapses or a guard fires, which is exactly right and costs nothing. Both fields are rewritten from scratch each read, like guards.

Each condition carries how it should be judged:
- "measured" — the user named a specific test. Apply THAT test, not your own.
- "judgment" — the user deliberately handed you the call. Use your eyes and say plainly what you see. Two traders can disagree here and both be doing their job.

If you genuinely cannot check a condition this read — a tool failed, a search came back empty, a symbol won't quote — mark it "unchecked" and say so. NEVER mark a condition met because it is probably true or because you couldn't look.

Always include "read": ONE short, plain first-person sentence — what you see and what you are doing about it. This is your live journal; keep it human and specific.

Output ONLY a JSON object, no prose.`

const _PRE_ENTRY = `You are Talos, the guardian watching a trade SETUP the user built with Mentor. You are read on every candle close of the rung you watch, and ahead of it when a guard you armed fires. REASON WOKEN tells you which:

- "candle" — the rung's candle closed. Judge where the plan stands now: is this the moment, or is it developing, or has the map gone stale.
- "guard" — a price you armed was reached, ahead of the close. The guard's meaning tells you what you were waiting for.
- "first_look" — your first read of this setup. Read the map, arm your guards.
- "expiry_review" — the setup is near its expiry. Judge whether it dies, or is still worth carrying.

"enter" IS YOUR DECISION, not the level's. ARMED LEVEL tells you whether price is standing on one of this plan's entry levels right now; it is information, not permission. If the conditions are fulfilled, say "enter" and the user gets a confirm card.

WHAT AN "enter" ACTUALLY PLACES: an order at the plan's OWN authored entry price, never at wherever price happens to be. So an "enter" while price sits well past that level is a resting order that may simply never fill — and if price has run far enough that the plan no longer works from here, the honest answers are "wait" with the guards re-armed at the levels that now matter, or "edit" with an edit_proposal if the map is stale. Entering because the conditions are technically true, at a price that left your entry behind, is the one way this verdict goes wrong.

A setup can hold more than one way in: a false break at one level and a break-and-go at another are rival premises, not two halves of one trade. Judge ONLY the scenario on the table, with its own levels, its own stop and its own conditions. If it isn't there, say so — the others stay armed on their own terms.

THE CONDITIONS ARE YOUR MANDATE. They are written in plain language, the way a trader would say them. Read each one, work out what would actually confirm or deny it, and check it — with the numbers in front of you first, with tools when they cannot answer. A condition marked "primary" is the trigger itself: if it is not happening, this is not the moment. A "confirming" condition that fails weakens the read but does not by itself veto it.

Judge ONLY the declared conditions. If the setup says nothing about news or the broad market, that silence is deliberate — the user judged them immaterial. Don't grade them and don't go looking.

THE REFERENCED NAMES ARE THE EXCEPTION, and they are not a condition. When the setup lists other tickers, those are the names its author would glance at before taking this trade. You are given their live prices. Look at them before you say "enter": a long into a sector that is being sold, or a breakout no peer is confirming, is a worse trade than the chart alone shows. This never becomes a veto on its own — it is weight on the decision, and if it is what tips you, say so in your "read".

SCHEDULED EVENT RISK is always on. A high-impact event landing before this trade's expected exit, when the thesis is not itself an event play, is a real reason to prefer "wait".

Weight price action over indicators. Be strict: most reads should NOT be "enter". Weigh the author's CONVICTION as their own honest read at build time: a high-conviction setup earns the benefit of the doubt on a marginal call; a low-conviction one needs everything lining up.

TWO TIMEFRAMES, TWO JOBS. The setup's own timeframe is where the PREMISE lives — is the map still true. A rung or two finer is where the MOMENT lives — is this the entry, now. Too fine and ordinary noise reads as the premise breaking; too coarse and the trigger cannot confirm until a candle closes hours from now. Pull the rung you need.

"premise" IS A SEPARATE QUESTION FROM THE VERDICT, and you answer both every read. The verdict is about the MOMENT — is this the entry. "premise" is about the MAP — does this plan still describe what price is doing at all. "intact": it does. "damaged": the premise is hurt and this may not be a trade any more. "stale": the levels no longer describe this chart and it wants re-drawing. You can be "wait" and "intact" for weeks, which is the normal case; you can also be "wait" and "stale", which says keep your hands off while somebody re-draws it. Say "damaged" or "stale" when you mean it — it is how a rotting setup gets noticed by someone other than you, and it pulls your next read forward to the very next close.

Verdicts: "enter" (this is the moment), "wait" (not yet, keep watching), "stand_aside" (the premise is damaged AND you are standing down now), "edit" (the map is stale and you are proposing the re-draw; provide edit_proposal), "let_expire" (expiry review only).

${_CORE}
Return one entry per declared condition, keyed by its id:
{"timeframe_used":"15min","read":"<one first-person sentence>","conditions":[{"id":"c1","met":"yes|no|unchecked","note":"what you actually saw, or why you couldn't look"}],"verdict":"enter|wait|stand_aside|edit|let_expire","premise":"intact|damaged|stale","warning":"<one line, ONLY when the verdict is not enter: what is missing or wrong, for the record>","next_timeframe":"15min","next_expensive_in":1,"watch":{"rung":"15min","indicators":["vwap","ema(20)"]},"guards":[{"price":311.5,"direction":"above","means":"entry"}],"memo_update":"..."}
Include "edit_proposal":{"why":"...","changes":{}} only when the verdict is "edit".`

const _IN_POSITION = `You are Talos, watching a trade the user is ALREADY IN. The entry is done. The stop and every plain target are ORDERS resting at the broker, and nobody reads those — you are here because the user attached a CONDITION IN WORDS to one or more legs, and a sentence has to be judged. WATCHED LEGS lists exactly those, with their conditions. They are your whole mandate.

YOU ARE NOT DECIDING WHETHER TO ENTER, and you are not re-grading the thesis. The thesis and the entry conditions are shown for context — they are why the trade exists — but the question each read is only: has a watched leg's condition come true, and what does the plan say to do then.

REASON WOKEN: "candle" — the rung's candle closed; "guard" — a price you armed was reached ahead of it.

WHAT THE NUMBERS MEAN. R is measured from the risk originally taken, so it does not move when the stop moves. MAE and MFE are how far the trade went against and in favour SINCE ENTRY — a position at +0.4R that has already seen +2.1R is a trade giving back its gains, and that is a different conversation from one grinding up to +0.4R for the first time.

YOU MAY ANSWER lists the verdicts this read may give — only what the watched legs make yours to decide. "hold" is the right answer most of the time; be strict.
- "hold" — no watched condition has come true. Nothing to do. Say so plainly.
- "move_stop" — the watched stop's condition says the protection should be tighter. Give the new level and what it is anchored to. Never move a stop further from entry; the resting stop-market stays behind whatever you propose.
- "exit_now" — the watched stop's condition says get out ahead of the resting stop. The thesis must actually be broken, not merely uncomfortable.
- "take_partial" — a watched target's condition has come true. Name the leg by its id; its size is already the user's decision.
- "add_leg" — a watched pending entry's condition has come true AT its level. Name the leg. Never to rescue a trade that is going against you; declining is a real answer.

You never execute. Every verdict becomes a card the user confirms, so write for someone deciding in ten seconds.

TWO TIMEFRAMES, TWO JOBS. The setup's own timeframe is where the THESIS lives; a rung or two finer is where a watched condition actually resolves — where the stop is being pressed, where a target is being reached. Pull the rung you need.

${_CORE}
Return one entry per WATCHED condition, keyed by its id:
{"timeframe_used":"15min","read":"<one first-person sentence>","conditions":[{"id":"s1c1","met":"yes|no|unchecked","note":"what you actually saw"}],"verdict":"<one of YOU MAY ANSWER>","proposal":{"leg":"t2"} | {"stop":123.45,"why":"<what the level is anchored to>"},"next_timeframe":"15min","guards":[{"price":306,"direction":"below","means":"invalidation"}],"memo_update":"..."}
Include "proposal" ONLY for take_partial / add_leg ({"leg": the zone id}) or move_stop ({"stop", "why"}). Omit it otherwise.`

// ─── Blocks ───────────────────────────────────────────────────────────────────

/**
 * The conditions, as prose with their ids — the answer comes back keyed by them.
 *
 * An already-resolved LATCHING condition is presented as settled rather than re-asked: re-running
 * a search for a fact established three wakes ago both wastes the call and risks the model talking
 * itself out of it when results shift.
 */
function _conditionLines(setup, conditions) {
    const resolved = setup?.monitor_state?.conditions ?? {}
    return conditions.map(c => {
        const prior = resolved[c.id]
        if (c.persistence === 'latching' && prior?.met === true) {
            return `- [${c.id}] (${c.weight}) ${c.text}\n    ALREADY ESTABLISHED on ${prior.at ?? 'an earlier wake'}${prior.note ? ` — ${prior.note}` : ''}. Do not re-check; treat as met.`
        }
        return `- [${c.id}] (${c.weight}, ${c.mode}) ${c.text}`
    })
}

function _conditionsBlock(setup, scenario = null) {
    // Root ∪ the armed scenario's. The rival premise's trigger is deliberately absent: it describes
    // a different trade, and grading it here would read as a setup that never fulfils.
    const conditions = declaredConditions(setup, scenario)
    if (!conditions.length) return 'CONDITIONS: (none declared — judge on price structure at the level alone)'
    return `CONDITIONS — judge exactly these, nothing else:\n${_conditionLines(setup, conditions).join('\n')}`
}

/**
 * The watched legs, each with its level, its size and its conditions — the in-position mandate
 * (docs/design/talos-per-candle.md). What rests behind each is said outright, because it is the
 * difference between "propose" and "nothing happens if you say nothing".
 */
function _watchedBlock(setup, watched) {
    // Through `legPrice`, not a local copy: the price a prompt SAYS a leg is at and the price
    // `protectionPlan` rests it at have to come from one place. It used to be a local edge rule
    // here — `isLong ? z.lower : z.upper`, per leg type — which is exactly the duplication the
    // band removal deleted.
    const lvl   = legPrice
    const lines = []
    if (watched.stop) {
        lines.push(`- STOP [${watched.stop.id}] at ${lvl(watched.stop)} — a stop-market RESTS here regardless; your read can only tighten it or exit ahead of it:`)
        lines.push(..._conditionLines(setup, watched.stop.conditions).map(l => '  ' + l))
    }
    for (const t of watched.targets) {
        lines.push(`- TARGET [${t.id}] at ${lvl(t)}${t.quantity != null ? ` (size ${t.quantity})` : ''} — NOTHING rests here; if you say nothing, nothing happens:`)
        lines.push(..._conditionLines(setup, t.conditions).map(l => '  ' + l))
    }
    for (const e of watched.entries) {
        lines.push(`- PENDING ENTRY [${e.id}] at ${lvl(e)}${e.quantity != null ? ` (size ${e.quantity})` : ''} — not yet filled; add_leg only if its condition is true AT the level:`)
        lines.push(..._conditionLines(setup, e.conditions).map(l => '  ' + l))
    }
    return `WATCHED LEGS — your whole mandate:\n${lines.join('\n')}`
}

/**
 * The premise on the table — its legs as PRICES, in the same sentence `_watchedBlock` uses.
 *
 * It used to be `JSON.stringify({entry_legs, stop_legs, target_legs, ...})`, which handed the read the
 * STORAGE shape: `{"id":"s1e1","lower":238.2,"upper":238.2,"quantity":100,"note":null,"conditions":[]}`
 * for a level the user wrote as 238.2 (docs/desks/mentor-talos.md §Guards — the two keys survive in
 * Mongo alone, and only to spare live documents a cosmetic migration). Every read of this desk
 * therefore opened on a band shape, on a desk that has not drawn a band since 2026-08-22.
 *
 * `rr` and the scenario size ride the same block because they are read together with the legs.
 */
export function _scenarioBlock(setup, scenario) {
    const legs = [
        legsText(scenario?.entry_legs, 'ENTRY'),
        legsText(scenario?.stop_legs, 'STOP'),
        legsText(scenario?.target_legs, 'TARGET'),
    ].filter(Boolean).join('\n')

    const tail = [
        scenario?.quantity != null ? `size ${scenario.quantity}` : null,
        scenario?.rr != null ? `r:r ${scenario.rr}` : null,
    ].filter(Boolean).join(' · ')

    return [
        `SCENARIO ON THE TABLE${scenario?.name ? ` — "${scenario.name}"` : ''}:`,
        legs || '- (no priced legs)',
        tail ? `THIS PREMISE: ${tail}` : null,
    ].filter(Boolean).join('\n')
}

/**
 * Where price is standing, and NOTHING about what the read may answer.
 *
 * The old line ended `"enter" is not available`, which was the zone gate talking three weeks after
 * it was removed (docs/desks/mentor-talos.md §Entry — the verdict is the whole gate, and
 * `_applyVerdict` honours an `enter` with no zone). It contradicted the prompt's own paragraph —
 * *it is information, not permission* — and it forbade the exact shape the removal existed for:
 * price reaches the level, the conditions confirm two candles later, the satisfied entry guard has
 * already been dropped by `clampGuards`, and nothing is standing on a level any more.
 */
export function _armedLevelLine(setup, zone) {
    if (!zone) return 'ARMED LEVEL: (none — price is not standing on one of this plan\'s entry levels right now)'
    // No trailing gloss: the label already means "price is standing here", and a leg that carries a
    // note ends in one em-dash clause already — two in a row read as a sentence nobody wrote.
    const text = legText(zone)
    return `ARMED LEVEL (price is standing on it): ${text ?? `[${zone.id ?? '?'}]`}`
}

/**
 * The rival premises, named only. Enough that the model knows a rejection here is not a rejection of
 * the whole setup ("wait" leaves the other one armed), and never enough to invite it to judge them.
 */
function _otherScenariosBlock(setup, scenario) {
    const others = (setup?.scenarios ?? []).filter(s => s.id !== scenario?.id)
    if (!others.length) return ''
    return `OTHER SCENARIOS ON THIS SETUP (not yours to judge — they stay armed either way): ${
        others.map(s => scenarioLabel(s)).join(', ')}`
}

function _dataBlocks(setup, g, tf) {
    const out = []
    if (g.candles) out.push(`RECENT CANDLES (${tf}):\n${g.candles}`)
    // Computed from those same bars, free, and handed over WITHOUT being asked for. A read given
    // nothing but OHLCV rows reaches for a picture; these are the numbers most conditions are
    // actually written against, and they are the same numbers get_indicators would return.
    if (g.indicators) out.push(`INDICATORS (${tf}, computed from the candles above):\n${g.indicators}`)
    if (g.refQ)    out.push(`REFERENCED NAMES (live quotes):\n${g.refQ}`)

    const ev = _formatEventRisk(setup?.event_risk)
    out.push(ev
        ? `SCHEDULED EVENT RISK (frozen at build — always checked):\n${ev}`
        : 'SCHEDULED EVENT RISK: (none flagged in the next ~10 days)')
    return out
}

/**
 * The guards standing right now — what the LAST read asked to be woken by. Shown because a guard
 * set is REPLACED WHOLE on every read: a model that cannot see what it armed is re-deriving the
 * watch from scratch, and the lines it happens not to re-arm go quiet without anyone deciding.
 */
function _armedLine(setup) {
    const guards = setup?.monitor_state?.guards
    if (!Array.isArray(guards) || !guards.length) return null
    return `CURRENTLY ARMED (you wrote these last read; they are replaced by whatever you return now): ${JSON.stringify(guards)}`
}

/** WHY this wake happened, in the prompt's vocabulary. A fired guard says what it meant. */
function _wokenLine(reason, woke) {
    if (reason === 'guard' && woke) {
        return `REASON WOKEN: guard — price reached ${woke.price} (${woke.direction ?? 'any'}${woke.means ? `, meaning "${woke.means}"` : ''}), ahead of the candle close`
    }
    return `REASON WOKEN: ${reason ?? 'candle'}`
}

// ─── Pre-entry read ───────────────────────────────────────────────────────────

/**
 * Run one readiness read. Never throws — a failed read returns a typed failure marker so the
 * caller's journal row can be honest about WHY (bad reply vs failed IO) and reschedule rather than
 * wedging the loop.
 *
 * @param {object} hit  `{ scenario, zone }` when price is at an entry level, else null
 * @param {object} ctx  `{ reason, price, woke }`
 */
export async function assessSetup(setup, hit, ctx = {}) {
    try {
        const zone     = hit?.zone ?? null
        const scenario = hit?.scenario ?? pickScenario(setup)
        const rungs    = paceRungs(setup)
        const tf       = openingRung(setup)
        const g        = await openingContext(setup, tf)

        const userText = [
            `SETUP: ${JSON.stringify({
                asset: setup.asset, direction: setup.direction, type: setup.type,
                trade_mode: setup.trade_mode, timeframe: setup.timeframe, thesis: setup.thesis,
                conviction: setup.conviction, valid_until: setup.valid_until,
            })}`,
            _scenarioBlock(setup, scenario),
            _otherScenariosBlock(setup, scenario),
            _conditionsBlock(setup, scenario),
            _armedLevelLine(setup, zone),
            `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
            `SESSION NOW: ${sessionPhase(setup.asset, setup.asset_class)}`,
            _wokenLine(ctx.reason, ctx.woke),
            _ladderLine(setup, rungs, tf),
            `LENS: ${lensLine(setup.trade_mode)}`,
            _armedLine(setup),
            `PRIOR MEMO: ${setup.monitor_state?.memo || '(none)'}`,
            ..._dataBlocks(setup, g, tf),
        ].filter(Boolean).join('\n\n')

        return _runRead(setup, _PRE_ENTRY, userText,
            { kind: 'pre_entry', reason: ctx.reason, woke: ctx.woke, price: ctx.price, rung: tf, pace: rungs, scenario, zone })
    } catch (err) {
        logger.warn(LOG, `assessment failed for ${setup?.id}:`, err.message)
        return { _failReason: 'io' }
    }
}

// ─── In-position read ──────────────────────────────────────────────────────────

/**
 * Run one in-position read, over the WATCHED legs only.
 *
 * @param {object} ps   position_state
 * @param {object} ctx  `{ price, reason, woke, metrics, watched }` — `watched` from setup.schema.watchedLegs
 */
export async function assessPosition(setup, ps, ctx = {}) {
    try {
        const scenario = _armedScenario(setup)
        const rungs    = paceRungs(setup)
        const tf       = openingRung(setup)
        const g        = await openingContext(setup, tf)
        const watched  = ctx.watched ?? { stop: null, targets: [], entries: [] }
        const menu     = allowedVerdicts(watched)

        const m = ctx.metrics ?? ps?.metrics ?? {}
        const userText = [
            `SETUP: ${JSON.stringify({
                asset: setup.asset, direction: setup.direction, type: setup.type,
                trade_mode: setup.trade_mode, timeframe: setup.timeframe, thesis: setup.thesis,
                conviction: setup.conviction,
            })}`,
            `THE POSITION: ${JSON.stringify({
                entry: ps?.entry?.fill_price ?? ps?.entry?.intended ?? null,
                size: ps?.entry?.size ?? null,
                direction: ps?.entry?.direction ?? setup.direction,
                stop_initial: ps?.stop?.initial ?? null,
                stop_current: ps?.stop?.current ?? null,
            })}`,
            `WHERE IT STANDS: ${JSON.stringify({
                r_now: m.r_multiple_now ?? null, worst_r: m.mae ?? null, best_r: m.mfe ?? null,
            })}`,
            _watchedBlock(setup, watched),
            `YOU MAY ANSWER: ${menu.join(' | ')}`,
            `CONTEXT — why the trade exists (not re-graded):\n${_conditionLines(setup, declaredConditions(setup, scenario)).join('\n') || '(no entry conditions declared)'}`,
            `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
            `SESSION NOW: ${sessionPhase(setup.asset, setup.asset_class)}`,
            _wokenLine(ctx.reason, ctx.woke),
            _ladderLine(setup, rungs, tf),
            `LENS: ${lensLine(setup.trade_mode)}`,
            _armedLine(setup),
            `PRIOR MEMO: ${setup.monitor_state?.memo || '(none)'}`,
            ..._dataBlocks(setup, g, tf),
        ].filter(Boolean).join('\n\n')

        return _runRead(setup, _IN_POSITION, userText,
            { kind: 'in_position', reason: ctx.reason, woke: ctx.woke, price: ctx.price, rung: tf, pace: rungs, scenario, watched })
    } catch (err) {
        logger.warn(LOG, `position assessment failed for ${setup?.id}:`, err.message)
        return { _failReason: 'io' }
    }
}

/** The premise that actually won the entry — its legs are the ones on the hook. */
function _armedScenario(setup) {
    const id = setup?.armed_scenario_id
    return (setup?.scenarios ?? []).find(s => s.id === id) ?? pickScenario(setup)
}

// ─── The model loop ───────────────────────────────────────────────────────────

/**
 * The loop both reads share: route, run tools until the model stops asking, parse.
 *
 * Never throws: a failed read returns a typed marker so the caller can be honest about WHY and
 * reschedule, rather than wedging the loop. `_tools` rides back on the result — the journal row
 * says what the read pulled, and per-wake cost is measured rather than guessed.
 *
 * `meta` is what the caller knew about the wake. It is not read here — it rides into the recorder
 * (TALOS_RECORD_READS) so a replay has the scenario, the price and the rung beside the prompt.
 */
async function _runRead(setup, systemText, userText, meta = {}) {
    const trace  = { messages: [], usage: [], calls: [], rounds: 0 }
    const result = { ...await _readLoop(setup, systemText, userText, trace), ...(trace.model ? { _model: trace.model } : {}) }
    // Fire-and-forget: the recorder fetches its data pack AFTER the answer is in hand, and its
    // failure is its own log line. The read is already over by the time it runs.
    if (isRecording()) {
        recordRead({ setup, symbols: symbolScope(setup), meta, systemText, userText, trace, result })
            .catch(err => logger.warn(LOG, `[${setup?.id}] recorder rejected:`, err.message))
    }
    return result
}

/** The body of `_runRead`. `trace` is filled as it goes — what the recorder writes is what happened. */
async function _readLoop(setup, systemText, userText, trace) {
    const t0 = Date.now()
    try {
        const { model, provider, endpoint, wire, reasoningEffort } = await assessRouting(setup.userId)
        const calls = trace.calls
        const runToolUses = makeAssessToolRunner({
            symbols: symbolScope(setup),
            log: LOG,
            onCall: (name) => calls.push(name),
            // A tool's own model call (the structure-vision reads) lands on this wake's row too, at
            // the model the provider says it used — usedModel, not `model`.
            onUsage: (usage, usedModel) => bookAssessUsage(setup?.userId, usedModel ?? model, usage, 'talosAssess'),
        })
        trace.model = model
        trace.provider = provider

        // A NON-ANTHROPIC candidate (TALOS_MODELS, admin-only while under evaluation): same prompts,
        // same tool kit and runner, same parse — the wire format is the adapter's business. The
        // rest of this function is the Anthropic loop.
        if (provider === 'openai-compat') {
            const out = await runOpenAICompatRead({
                endpoint, wire, model, systemText, userText, tools: buildToolsFor(setup), runToolUses, trace,
                onUsage: (usage) => bookAssessUsage(setup?.userId, model, usage, 'talosAssess'),
                runawayRounds: RUNAWAY_ROUNDS, log: LOG, tag: `[${setup.id}]`,
            })
            trace.elapsedMs = Date.now() - t0
            if (out.runaway) return { _failReason: 'runaway', _tools: calls }
            if (calls.length) logger.info(LOG, `[${setup.id}] ${calls.length} tool call(s) on ${model}: ${calls.join(', ')}`)
            return _parseReply(setup, out.text, out.stopReason, calls)
        }

        // `model` is not optional here: _thinkingConfig floors the models that reason by default to
        // 'low' when no effort is set, and without it that floor is skipped — leaving such a model
        // with thinking OFF, where it can emit a tool call as plain text that silently never runs.
        const thinking  = _thinkingConfig(reasoningEffort, model)
        const maxTokens = thinking ? MAX_TOKENS_THINKING : MAX_TOKENS
        // Carries the 1-hour marker (ASSESS_PREFIX_CACHE): this prefix is the same for every setup
        // and the candle-close pacing outlives the 5-minute default. It also covers `tools`, which
        // precede the system block in the cached prefix.
        const system    = assessSystem(systemText)
        // This loop calls the client DIRECTLY, so it must finalize the server tools itself — the
        // registry's web_search is at its modern base, and a Haiku-routed wake would 400 on a variant
        // Haiku does not take. Same one-model resolution streamAnthropicWithTools does.
        const tools     = _finalizeServerTools(buildToolsFor(setup), wire)
        const messages  = [{ role: 'user', content: userText }]
        Object.assign(trace, { reasoningEffort, thinking, maxTokens, tools, messages })

        // NO QUALITY CAP on rounds: a four-condition setup spanning two symbols does not fit a
        // guessed number, and capping silently truncates the read into a verdict formed on partial
        // evidence. RUNAWAY_ROUNDS is a backstop far above any honest read — the caller's
        // withTimeout ABANDONS a slow check but cannot CANCEL it, so a model that loops would keep
        // billing in a detached promise. Hitting this is a bug, and it logs like one.
        let msg
        for (let round = 0; ; round++) {
            // Same breakpoint walk the desks use, so a long read pays for its earlier rounds once.
            // `mutableTail: 0` because this loop never rewrites a tool result.
            advanceToolLoopCache(messages, 1, { mutableTail: 0 })

            msg = await _client.messages.create({
                model: wire, max_tokens: maxTokens, system, messages, tools,
                ...(thinking ?? {}),
            })
            bookAssessUsage(setup?.userId, model, msg?.usage, 'talosAssess')
            trace.usage.push(msg?.usage ?? null)
            trace.rounds = round + 1
            trace.stopReason = msg?.stop_reason ?? null
            if (msg.stop_reason !== 'tool_use') break

            const results = await runToolUses(msg.content)
            // `web_search` is server-side: its blocks come back as `server_tool_use`, which the runner
            // ignores. A turn with ONLY those has nothing for us to answer — and an empty user turn
            // is both an API error and an infinite loop.
            if (!results.length) {
                logger.info(LOG, `[${setup.id}] tool turn with no client-side calls — taking the reply as final`)
                break
            }

            messages.push({ role: 'assistant', content: msg.content })
            messages.push({ role: 'user', content: results })

            if (round >= RUNAWAY_ROUNDS) {
                logger.error(LOG, `[${setup.id}] RUNAWAY: ${round + 1} tool rounds (${calls.join(', ')}) — abandoning the read`)
                trace.elapsedMs = Date.now() - t0
                return { _failReason: 'runaway', _tools: calls }
            }
        }
        // The final reply is not pushed by the loop (nothing follows it) — the record needs it.
        trace.messages = [...messages, { role: 'assistant', content: msg.content }]
        trace.elapsedMs = Date.now() - t0

        if (calls.length) logger.info(LOG, `[${setup.id}] ${calls.length} tool call(s): ${calls.join(', ')}`)

        return _parseReply(setup, _allText(msg), msg?.stop_reason, calls)
    } catch (err) {
        trace.elapsedMs = Date.now() - t0
        trace.error = err.message
        logger.warn(LOG, `assessment failed for ${setup?.id}:`, err.message)
        return { _failReason: 'io' }
    }
}

// The backstop on tool rounds, shared by both loops — see the comment above the Anthropic one.
const RUNAWAY_ROUNDS = 25

/** The end of a read, whichever loop ran it: the verdict JSON out of the reply text, or a typed failure. */
function _parseReply(setup, text, stopReason, calls) {
    try {
        // `_tools` is envelope, not something the model authored — prefixed like _failReason.
        return { ...extractFirstJSON(text), _tools: calls }
    } catch (parseErr) {
        logger.warn(LOG, `reply unparseable for ${setup.id} (stop_reason=${stopReason}):`, parseErr.message)
        return { _failReason: stopReason === 'max_tokens' ? 'truncated' : 'malformed', _tools: calls }
    }
}
