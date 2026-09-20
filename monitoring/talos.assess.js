import Anthropic from '@anthropic-ai/sdk'
import { getQuotes }             from '../providers/yahoofinance.provider.js'
import { sessionPhase }          from '../services/market.service.js'
import { logger }                from '../services/logger.service.js'
import { extractFirstJSON }      from './parsers/llmReply.parser.js'
import { assessRouting, candlesText as _candlesText,
    ASSESS_MAX_TOKENS as MAX_TOKENS, ASSESS_MAX_TOKENS_THINKING as MAX_TOKENS_THINKING, assessSystem,
    bookAssessUsage, lensLine } from './assess.shared.js'
import { _allText, _formatEventRisk } from './assess.shared.js'
import { _thinkingConfig, advanceToolLoopCache, _finalizeServerTools } from '../providers/anthropic.provider.js'
import { buildAssessTools, makeAssessToolRunner } from './assessTools.js'
import { declaredConditions, pickScenario, scenarioLabel, usableLadder, clampRung, allowedVerdicts } from '../services/setup.schema.js'
import { config } from '../services/config.js'

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
 * read said it wanted to look at next, else the finest rung. The model picks it — a read that is
 * confidently wrong never feels unsure, so it never climbs on its own; letting it choose the rung
 * up front is what stops the noisiest view deciding setups built on structure.
 */
export function openingRung(setup) {
    const ladder = usableLadder(setup)
    return clampRung(setup?.monitor_state?.timeframe, ladder) ?? ladder[ladder.length - 1]
}

function _ladderLine(setup, ladder, tf) {
    const premise = setup?.timeframe && ladder.includes(setup.timeframe) ? setup.timeframe : ladder[0]
    return `LADDER (coarse→fine, the rungs you may work on): ${ladder.join(', ')}`
        + `\n  PREMISE rung (what this setup was drawn on): ${premise}`
        + `\n  YOU ARE ON: ${tf} — you are read again at its next close`
}

// ─── Opening context ──────────────────────────────────────────────────────────

/**
 * What a read starts with: the recent candles on its rung and the live prices of the names the
 * setup leans on. Text only — no chart. Each fetch is independently guarded so a failed provider
 * degrades its own block to empty rather than killing the read.
 *
 * Deps injectable so the monitor's tests exercise this without network IO.
 */
export async function openingContext(setup, tf, deps = {}) {
    const { candlesText = _candlesText, quotes = getQuotes } = deps
    const asset      = String(setup.asset).toUpperCase()
    const refSymbols = (setup.referenced_symbols ?? []).slice(0, 6)

    const [candles, refQ] = await Promise.all([
        candlesText(asset, tf).catch(() => ''),
        refSymbols.length ? quotes(refSymbols).catch(() => '') : Promise.resolve(''),
    ])
    return { candles, refQ }
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
//
// One core both reads share — how to spend, how to be woken, how to answer — and a tail per read
// that says what the question is. The core is what this design changed; the tails carry the
// judgment each read owned before.

const _CORE = `HOW YOU LOOK. You open with numbers, not a picture: the recent candles on your rung, the live price, your own memo from last time. Read them first. Call get_chart when a condition needs a SHAPE the rows cannot show you — structure, a pattern, a discretionary read of how price is behaving. Call get_indicators when a condition names a level the plan was built on. Call the structure, correlation, positioning or search tools when a condition actually rests on them. Do NOT call a tool to confirm what the rows already say, and do not pull the chart out of habit: every call is money the user is paying for this read, and a read that spent nothing because the numbers answered is a good read.

WHEN YOU ARE READ AGAIN. At the next close of the rung you are on — every candle. That is your timer and your backstop both. "next_timeframe" is the rung you want to open on next time, and it sets the pace with it: a coarser rung means fewer reads, a finer one means you want to watch closely. Pick it from your LADDER; anything else is ignored.

"guards" ARE THE PRICES THAT MUST NOT WAIT FOR A CANDLE. Between your reads nothing looks at this trade except a cheap price check against these lines. Do not arm one for what the next close will show you anyway; arm one where price arriving would change your answer NOW — the trigger, the level that breaks the premise, the level where the stop starts being pressed. Each is {"price":311.5,"direction":"above|below|any","means":"entry|invalidation|manage"}; "any" is a touch from either side. Every guard is rewritten from scratch each read, so what you do not re-arm is forgotten. Arm the levels that matter and no more.

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

"enter" is only honoured when price is AT an entry level (ARMED LEVEL says so). Off a level, the question is whether the plan still makes sense here: "wait" with a note and re-arm guards at the levels that now matter, or "edit" with an edit_proposal if the map is stale.

A setup can hold more than one way in: a false break at one level and a break-and-go at another are rival premises, not two halves of one trade. Judge ONLY the scenario on the table, with its own levels, its own stop and its own conditions. If it isn't there, say so — the others stay armed on their own terms.

THE CONDITIONS ARE YOUR MANDATE. They are written in plain language, the way a trader would say them. Read each one, work out what would actually confirm or deny it, and check it — with the numbers in front of you first, with tools when they cannot answer. A condition marked "primary" is the trigger itself: if it is not happening, this is not the moment. A "confirming" condition that fails weakens the read but does not by itself veto it.

Judge ONLY the declared conditions. If the setup says nothing about news or the broad market, that silence is deliberate — the user judged them immaterial. Don't grade them and don't go looking.

THE REFERENCED NAMES ARE THE EXCEPTION, and they are not a condition. When the setup lists other tickers, those are the names its author would glance at before taking this trade. You are given their live prices. Look at them before you say "enter": a long into a sector that is being sold, or a breakout no peer is confirming, is a worse trade than the chart alone shows. This never becomes a veto on its own — it is weight on the decision, and if it is what tips you, say so in your "read".

SCHEDULED EVENT RISK is always on. A high-impact event landing before this trade's expected exit, when the thesis is not itself an event play, is a real reason to prefer "wait".

Weight price action over indicators. Be strict: most reads should NOT be "enter". Weigh the author's CONVICTION as their own honest read at build time: a high-conviction setup earns the benefit of the doubt on a marginal call; a low-conviction one needs everything lining up.

TWO TIMEFRAMES, TWO JOBS. The setup's own timeframe is where the PREMISE lives — is the map still true. A rung or two finer is where the MOMENT lives — is this the entry, now. Too fine and ordinary noise reads as the premise breaking; too coarse and the trigger cannot confirm until a candle closes hours from now. Pull the rung you need.

Verdicts: "enter" (this is the moment), "wait" (not yet, keep watching), "stand_aside" (the premise is damaged — don't take it now), "edit" (the map is stale and needs re-drawing; provide edit_proposal), "let_expire" (expiry review only).

${_CORE}
Return one entry per declared condition, keyed by its id:
{"timeframe_used":"15min","read":"<one first-person sentence>","conditions":[{"id":"c1","met":"yes|no|unchecked","note":"what you actually saw, or why you couldn't look"}],"verdict":"enter|wait|stand_aside|edit|let_expire","warning":"<one line, ONLY when the verdict is not enter: what is missing or wrong, for the record>","next_timeframe":"15min","guards":[{"price":311.5,"direction":"above","means":"entry"}],"memo_update":"..."}
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
    const isLong = setup?.direction !== 'short'
    const lvl    = (z, which) => (which === 'stop' ? (isLong ? z.lower : z.upper) : (which === 'tp' ? (isLong ? z.upper : z.lower) : (isLong ? z.upper : z.lower)))
    const lines  = []
    if (watched.stop) {
        lines.push(`- STOP [${watched.stop.id}] at ${lvl(watched.stop, 'stop')} — a stop-market RESTS here regardless; your read can only tighten it or exit ahead of it:`)
        lines.push(..._conditionLines(setup, watched.stop.conditions).map(l => '  ' + l))
    }
    for (const t of watched.targets) {
        lines.push(`- TARGET [${t.id}] at ${lvl(t, 'tp')}${t.quantity != null ? ` (size ${t.quantity})` : ''} — NOTHING rests here; if you say nothing, nothing happens:`)
        lines.push(..._conditionLines(setup, t.conditions).map(l => '  ' + l))
    }
    for (const e of watched.entries) {
        lines.push(`- PENDING ENTRY [${e.id}] at ${lvl(e, 'entry')}${e.quantity != null ? ` (size ${e.quantity})` : ''} — not yet filled; add_leg only if its condition is true AT the level:`)
        lines.push(..._conditionLines(setup, e.conditions).map(l => '  ' + l))
    }
    return `WATCHED LEGS — your whole mandate:\n${lines.join('\n')}`
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
        const ladder   = usableLadder(setup)
        const tf       = openingRung(setup)
        const g        = await openingContext(setup, tf)

        const userText = [
            `SETUP: ${JSON.stringify({
                asset: setup.asset, direction: setup.direction, type: setup.type,
                trade_mode: setup.trade_mode, timeframe: setup.timeframe, thesis: setup.thesis,
                conviction: setup.conviction, valid_until: setup.valid_until,
            })}`,
            `SCENARIO ON THE TABLE${scenario?.name ? ` — "${scenario.name}"` : ''}: ${JSON.stringify({
                entry_zones: scenario?.entry_zones ?? [], stop_zones: scenario?.stop_zones ?? [],
                tp_zones: scenario?.tp_zones ?? [], quantity: scenario?.quantity ?? null, rr: scenario?.rr ?? null,
            })}`,
            _otherScenariosBlock(setup, scenario),
            _conditionsBlock(setup, scenario),
            `ARMED LEVEL: ${zone ? JSON.stringify(zone) : '(none — price is not at an entry level; "enter" is not available)'}`,
            `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
            `SESSION NOW: ${sessionPhase(setup.asset, setup.asset_class)}`,
            _wokenLine(ctx.reason, ctx.woke),
            _ladderLine(setup, ladder, tf),
            `LENS: ${lensLine(setup.trade_mode)}`,
            _armedLine(setup),
            `PRIOR MEMO: ${setup.monitor_state?.memo || '(none)'}`,
            ..._dataBlocks(setup, g, tf),
        ].filter(Boolean).join('\n\n')

        return _runRead(setup, _PRE_ENTRY, userText)
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
        const ladder   = usableLadder(setup)
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
            _ladderLine(setup, ladder, tf),
            `LENS: ${lensLine(setup.trade_mode)}`,
            _armedLine(setup),
            `PRIOR MEMO: ${setup.monitor_state?.memo || '(none)'}`,
            ..._dataBlocks(setup, g, tf),
        ].filter(Boolean).join('\n\n')

        return _runRead(setup, _IN_POSITION, userText)
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
 */
async function _runRead(setup, systemText, userText) {
    try {
        const { model, reasoningEffort } = await assessRouting(setup.userId)
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
        const tools     = _finalizeServerTools(buildToolsFor(setup), model)
        const messages  = [{ role: 'user', content: userText }]

        const calls = []
        const runToolUses = makeAssessToolRunner({
            symbols: symbolScope(setup),
            log: LOG,
            onCall: (name) => calls.push(name),
            // A tool's own model call (the structure-vision reads) lands on this wake's row too, at
            // the model the provider says it used — usedModel, not `model`.
            onUsage: (usage, usedModel) => bookAssessUsage(setup?.userId, usedModel ?? model, usage, 'talosAssess'),
        })

        // NO QUALITY CAP on rounds: a four-condition setup spanning two symbols does not fit a
        // guessed number, and capping silently truncates the read into a verdict formed on partial
        // evidence. RUNAWAY_ROUNDS is a backstop far above any honest read — the caller's
        // withTimeout ABANDONS a slow check but cannot CANCEL it, so a model that loops would keep
        // billing in a detached promise. Hitting this is a bug, and it logs like one.
        const RUNAWAY_ROUNDS = 25
        let msg
        for (let round = 0; ; round++) {
            // Same breakpoint walk the desks use, so a long read pays for its earlier rounds once.
            // `mutableTail: 0` because this loop never rewrites a tool result.
            advanceToolLoopCache(messages, 1, { mutableTail: 0 })

            msg = await _client.messages.create({
                model, max_tokens: maxTokens, system, messages, tools,
                ...(thinking ?? {}),
            })
            bookAssessUsage(setup?.userId, model, msg?.usage, 'talosAssess')
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
                return { _failReason: 'runaway', _tools: calls }
            }
        }

        if (calls.length) logger.info(LOG, `[${setup.id}] ${calls.length} tool call(s): ${calls.join(', ')}`)

        try {
            // `_tools` is envelope, not something the model authored — prefixed like _failReason.
            return { ...extractFirstJSON(_allText(msg)), _tools: calls }
        } catch (parseErr) {
            logger.warn(LOG, `reply unparseable for ${setup.id} (stop_reason=${msg?.stop_reason}):`, parseErr.message)
            return { _failReason: msg?.stop_reason === 'max_tokens' ? 'truncated' : 'malformed', _tools: calls }
        }
    } catch (err) {
        logger.warn(LOG, `assessment failed for ${setup?.id}:`, err.message)
        return { _failReason: 'io' }
    }
}
