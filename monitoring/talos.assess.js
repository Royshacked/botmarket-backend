import Anthropic from '@anthropic-ai/sdk'
import { getQuotes }             from '../providers/yahoofinance.provider.js'
import { buildStudies }          from './evaluators/chart.evaluator.js'
import { sessionPhase }          from '../services/market.service.js'
import { cachedChartImage }      from '../services/chartImgCache.service.js'
import { logger }                from '../services/logger.service.js'
import { extractFirstJSON }      from './parsers/llmReply.parser.js'
import { assessRouting, candlesText as _candlesText,
    ASSESS_MAX_TOKENS as MAX_TOKENS, ASSESS_MAX_TOKENS_THINKING as MAX_TOKENS_THINKING, bookAssessUsage, lensLine } from './assess.shared.js'
import { _allText, _formatEventRisk } from './assess.shared.js'
import { _thinkingConfig, advanceToolLoopCache } from '../providers/anthropic.provider.js'
import { buildAssessTools, makeAssessToolRunner } from './assessTools.js'
import { declaredConditions, pickScenario, scenarioLabel, usableLadder, clampRung } from '../services/setup.schema.js'
import { config } from '../services/config.js'

// Talos's assessment — the condition-driven counterpart to Hermes's four-axis read.
//
// SHARED: the tool kit and its dispatch (monitoring/assessTools.js, built on the same registry
// schemas and handler factories every agent uses), the thinking config, the model routing and the
// text extraction. Those are the pipe.
//
// NOT shared: the system prompt and what a wake actually costs. Hermes fetches chart + candles +
// headlines + market on EVERY wake because a call always scores four fixed axes. Talos fetches the
// base (chart + candles + any referenced symbols) and nothing else — a setup's conditions are prose,
// so what else is worth pulling is a decision only the model can make once it has read them, and it
// makes it with tools. A purely structural setup costs one chart + candles and never pays for a
// headline sweep it would not have read.

const LOG = '[talos.assess]'

const _client = new Anthropic({ apiKey: config.anthropicApiKey })

// Verdicts Talos may return pre-entry. Anything off-menu is coerced to 'wait' by the monitor.
export const READINESS_VERDICTS = new Set(['enter', 'wait', 'stand_aside', 'edit', 'let_expire'])

/**
 * The tool set for a setup — the shared monitor kit (monitoring/assessTools.js), unfiltered.
 *
 * Conditions are TEXT, so there is no declared `kind` to gate on — and gating never served the
 * model anyway: it read the factors back as prose either way (see _conditionsBlock). What bounds
 * the cost is not which tools are MOUNTED but which SYMBOLS may be read, and that lives in the
 * runner (`symbolScope` below).
 */
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
 * The rung this wake OPENS on — the chart and candles that arrive before the model asks for
 * anything. Whatever the last assessment said it wanted to look at next, else the finest rung.
 *
 * WHY THE MODEL PICKS IT. This used to be hardcoded to `ladder[ladder.length - 1]`, so every read
 * began at the FINEST rung the setup had — a 15-minute setup opened on a 1-minute chart and had to
 * climb, via a tool it was only ever *invited* to call ("pull another timeframe if the first look
 * leaves you unsure"). A read that is confidently wrong never feels unsure, so it never climbed:
 * the noisiest available view decided setups built on structure.
 *
 * A cheap wake never touches this, so the choice survives until the next assessment — unlike the
 * old `next_check_min`, which `_reschedule` overwrote on the very next tick.
 */
export function openingRung(setup) {
    const ladder = usableLadder(setup)
    return clampRung(setup?.monitor_state?.timeframe, ladder) ?? ladder[ladder.length - 1]
}

/**
 * The rungs this read may work on, and which of the two jobs each one is for.
 *
 * Stated rather than locked. The tool schemas deliberately do NOT enum the timeframe: assessTools.js
 * exists because the hand-rolled, ladder-clamped tool copies one layer down were too narrow to check
 * the conditions setups actually carry. So the ladder is guidance the model can read and act on, and
 * the ONE place it is enforced is `next_timeframe` — the value we store and open on ourselves.
 */
function _ladderLine(setup, ladder, tf) {
    const premise = setup?.timeframe && ladder.includes(setup.timeframe) ? setup.timeframe : ladder[0]
    return `LADDER (coarse→fine, the rungs you may work on): ${ladder.join(', ')}`
        + `\n  PREMISE rung (what this setup was drawn on): ${premise}`
        + `\n  YOU ARE LOOKING AT: ${tf}`
}

// ─── Gather ───────────────────────────────────────────────────────────────────


/**
 * The always-on base every read starts from: the chart, recent candles, and any symbols the setup
 * leans on. Both reads are independently guarded — a failed provider degrades its own block to
 * empty rather than killing the assessment, because a partial read is still worth judging.
 *
 * THE SPECULATIVE PRE-FETCH IS GONE. This used to pull headlines / index quotes / positioning /
 * fundamentals up front for every kind the setup declared, whether or not the model would have
 * looked at them — a setup declaring `news` paid for a headline sweep on every single wake, even
 * with price nowhere near a zone. Those are tools now: the model asks when the sentence needs it.
 * That trades predictable cost for lower expected cost (see the refactor plan §5), which is why
 * per-wake call accounting replaces the build-time estimate.
 *
 * Deps injectable so the monitor's tests exercise this without network IO.
 */
export async function gatherFor(setup, tf, deps = {}) {
    const {
        renderChart = cachedChartImage,
        candlesText = _candlesText,
        quotes      = getQuotes,
    } = deps

    const asset = String(setup.asset).toUpperCase()
    // Bounded by what Mentor extracted at build — free text can name anything, the fetch cannot.
    const refSymbols = (setup.referenced_symbols ?? []).slice(0, 6)

    const [png, candles, refQ] = await Promise.all([
        renderChart(asset, tf, buildStudies('vwap, ema(50), volume', { fillDefaults: false })).catch(() => null),
        candlesText(asset, tf).catch(() => ''),
        refSymbols.length ? quotes(refSymbols).catch(() => '') : Promise.resolve(''),
    ])

    return { png, candles, refQ }
}

// ─── Prompt assembly ──────────────────────────────────────────────────────────

const _SYSTEM = `You are Talos, the guardian watching a trade SETUP the user built with Mentor. You were woken to judge the moment. REASON WOKEN tells you why, and it changes what you are being asked:

- "zone_trip" — price reached one of the setup's zones. Judge whether this is the moment.
- "expiry_review" — the setup is near its expiry. Judge whether it dies, or is still worth carrying.
- "guard_price" — a guard you armed fired at a level that is NOT inside an entry zone. You are not being asked whether to enter — you cannot, nothing is armed at a zone yet. You are being asked: does the plan still make sense at current price, or does the map need re-drawing? If the premise holds and price is simply developing, return "wait" with a note and re-arm guards at the levels that now matter. If the map is stale, return "edit" with an edit_proposal. "enter" is NOT available on a guard_price wake with no armed zone and will be ignored.
- "guard_time" — a scheduled re-read on a setup where price IS inside an entry zone. Treat it the same as zone_trip.
- "momentum_pulse" — legacy name for what guard_price now handles. Treat it the same as guard_price.

You are given the setup — its THESIS, the SCENARIO price actually reached, and that scenario's CONDITIONS — plus a chart, recent candles and the current price. Anything else you want, you go and get with your tools.

A setup can hold more than one way in: a false break at one level and a break-and-go at another are rival premises, not two halves of one trade. Judge ONLY the scenario on the table, with its own zones, its own stop and its own conditions. If it isn't there, say so — the other scenarios stay armed on their own terms, and nothing you say here kills them.

THE CONDITIONS ARE YOUR MANDATE. They are written in plain language, the way a trader would say them. Read each one, work out what would actually confirm or deny it, and go check — call the tools you need, and pull another timeframe if the first look leaves you unsure. A condition marked "primary" is the trigger itself: if it is not happening, this is not the moment. A "confirming" condition that fails weakens the read but does not by itself veto it.

Each condition carries how it should be judged:
- "measured" — the user named a specific test. Apply THAT test, not your own.
- "judgment" — the user deliberately handed you the call ("weak = how the price action looks"). Use your eyes and say plainly what you see. Two traders can disagree here and both be doing their job; that is expected, not a failure.

Judge ONLY the declared conditions. If the setup says nothing about news or the broad market, that silence is deliberate — the user judged them immaterial. Don't grade them and don't go looking.

THE REFERENCED NAMES ARE THE EXCEPTION, and they are not a condition. When the setup lists other tickers, those are the names its author would glance at before taking this trade — the sector it trades inside, the benchmark it is really a bet on, the leg on the other side of a spread. You are given their live prices. LOOK at them before you say "enter": a long into a sector that is being sold, or a breakout no peer is confirming, is a worse trade than the chart alone shows. This never becomes a veto on its own and it never becomes a graded condition — it is weight on the decision, and if it is what tips you, say so in your "read".

If you genuinely cannot check a condition this wake — a tool failed, a search came back empty, a symbol won't quote — mark it "unchecked" and say so. NEVER mark a condition met because it is probably true or because you couldn't look. Unchecked is an honest answer; a guess dressed as a check is not.

The one always-on exception is SCHEDULED EVENT RISK. A high-impact event landing before this trade's expected exit, when the thesis is not itself an event play, is a real reason to prefer "wait" — do not walk into an unresolved binary just because price tagged the zone.

Weight price action over indicators. Be strict: most checks should NOT be "enter". Judge the whole picture, not a checklist — if material new information appears that the setup never mapped, say so and factor it in.

Weigh the author's CONVICTION as their own honest read at build time: a high-conviction setup earns the benefit of the doubt on a marginal call; a low-conviction one needs everything lining up. Never recompute their conviction — it is not yours to revise.

Always include "read": ONE short, plain first-person sentence — what you see and what you're doing about it. This is your live monologue; keep it human and specific.

Verdicts: "enter" (this is the moment), "wait" (not yet, keep watching), "stand_aside" (the premise is damaged — don't take it now), "edit" (the map is stale and needs re-drawing; provide edit_proposal), "let_expire" (expiry review only).

TWO TIMEFRAMES, TWO JOBS. You are shown one view up front and your LADDER lists every rung you may work on. The setup's own timeframe is where the PREMISE lives — is the map still true, is the level still the level. A rung or two finer is where the MOMENT lives — is this the entry, now. Judging both from one chart is how a read goes wrong in one of two ways: too fine and ordinary noise reads as the premise breaking; too coarse and the trigger cannot confirm until a candle closes hours from now, so the honest answer is "wait" all day. Pull the rungs you need.

"next_timeframe" is the rung you want to OPEN on next time, and it is also how you set the pace — asking for a coarser rung means you are content to look less often, a finer one means you want to watch closely. Pick it from your ladder; anything else is ignored.

"guards" ARE WHEN YOU WANT TO BE WOKEN, and they are the most consequential thing you write. Nothing looks at this setup between your reads except a cheap price check against these lines, so a guard you did not arm is a move you will not see, and a guard armed carelessly is a read someone pays for with nothing to say.

Each guard fires only when EVERY term it carries holds:
- {"price":311.5,"direction":"above","means":"entry"} — wake me the moment it crosses, ahead of any timer. Use these for the level that would actually change your answer.
- {"after_min":30,"price":305,"direction":"above"} — look again in 30 minutes, but ONLY if price is above 305 by then. The conjunction is what makes this cheap: if price is still nowhere near, the timer costs nothing.
- {"after_min":240} — the unconditional backstop. It runs even if price does nothing, because some things a chart cannot show — a catalyst landing, the session closing, the premise simply going stale.

Arm the levels that matter and no more. Price is at one place now; ask yourself where it would have to go for you to say something different, and put your lines THERE. Tighten them as price approaches and loosen them as it walks away — that is how you spend attention well. Every guard is rewritten from scratch each read, so what you do not re-arm is forgotten.

Output ONLY a JSON object, no prose. Return one entry per declared condition, keyed by its id:
{"timeframe_used":"15min","read":"<one first-person sentence>","conditions":[{"id":"c1","met":"yes|no|unchecked","note":"what you actually saw, or why you couldn't look"}],"verdict":"enter|wait|stand_aside|edit|let_expire","warning":"<one line, ONLY when the verdict is not enter: what is missing or wrong, for the setup's record — the user is NOT asked to enter on a non-enter verdict, so this is not pre-confirmation copy>","next_timeframe":"15min","guards":[{"price":311.5,"direction":"above","means":"entry"},{"after_min":30,"price":305,"direction":"above"},{"after_min":240}],"memo_update":"..."}
Include "edit_proposal":{"why":"...","changes":{}} only when the verdict is "edit".`

/**
 * The conditions, as prose with their ids. Note this is what the STRUCTURED watch[] was reduced to
 * anyway — the taxonomy was never something the model consumed, only something the code gated
 * tools on. The ids are here because the answer comes back keyed by them.
 *
 * An already-resolved LATCHING condition is presented as settled rather than re-asked: re-running
 * a search for a fact established three wakes ago both wastes the call and risks the model talking
 * itself out of it when results shift.
 */
function _conditionsBlock(setup, scenario = null) {
    // Root ∪ the armed scenario's. The rival premise's trigger is deliberately absent: it describes
    // a different trade, and grading it here would read as a setup that never fulfils.
    const conditions = declaredConditions(setup, scenario)
    if (!conditions.length) {
        return 'CONDITIONS: (none declared — judge on price structure at the zone alone)'
    }
    const resolved = setup?.monitor_state?.conditions ?? {}
    const lines = conditions.map(c => {
        const prior = resolved[c.id]
        if (c.persistence === 'latching' && prior?.met === true) {
            return `- [${c.id}] (${c.weight}) ${c.text}\n    ALREADY ESTABLISHED on ${prior.at ?? 'an earlier wake'}${prior.note ? ` — ${prior.note}` : ''}. Do not re-check; treat as met.`
        }
        return `- [${c.id}] (${c.weight}, ${c.mode}) ${c.text}`
    })
    return `CONDITIONS — judge exactly these, nothing else:\n${lines.join('\n')}`
}

/**
 * The rival premises, named only. Enough that the model knows a rejection here is not a rejection of
 * the whole setup ("wait" leaves the other one armed), and never enough to invite it to judge them —
 * their zones and triggers are deliberately withheld.
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
 * Run one readiness assessment. Never throws — a failed read returns a typed failure marker so
 * the caller's timeline entry can be honest about WHY (bad reply vs failed IO) and reschedule on
 * the normal cadence rather than wedging the loop.
 */
export async function assessSetup(setup, hit, ctx = {}) {
    try {
        const zone     = hit?.zone ?? null
        const scenario = hit?.scenario ?? pickScenario(setup)
        const ladder   = usableLadder(setup)
        const tf       = openingRung(setup)
        const g        = await gatherFor(setup, tf)

        const userText = [
            `SETUP: ${JSON.stringify({
                asset: setup.asset, direction: setup.direction, type: setup.type,
                trade_mode: setup.trade_mode, timeframe: setup.timeframe, thesis: setup.thesis,
                conviction: setup.conviction, valid_until: setup.valid_until,
            })}`,
            // ONE premise is on the table. A setup can hold rivals — a false break and a break-and-go
            // are different trades — and the one price actually reached is the one being judged.
            `SCENARIO ON THE TABLE${scenario?.name ? ` — "${scenario.name}"` : ''}: ${JSON.stringify({
                entry_zones: scenario?.entry_zones ?? [], stop_zones: scenario?.stop_zones ?? [],
                tp_zones: scenario?.tp_zones ?? [], quantity: scenario?.quantity ?? null, rr: scenario?.rr ?? null,
            })}`,
            _otherScenariosBlock(setup, scenario),
            _conditionsBlock(setup, scenario),
            // WHY THERE IS NO ZONE MATTERS. "Expiry" and "a guard fired outside every zone" are both
            // no-zone wakes, but they call for different reads. Naming the right one keeps the model
            // from framing a guard-woken re-evaluation as an expiry decision.
            `ARMED ZONE: ${zone ? JSON.stringify(zone) : `(none — ${
                ctx.reason === 'guard_price'  ? 'the guard you armed fired; price is not inside any entry zone' :
                ctx.reason === 'momentum_pulse' ? 'price is outside every zone' :
                'expiry review'
            })`}`,
            `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
            `SESSION NOW: ${sessionPhase(setup.asset, setup.asset_class)}`,
            `REASON WOKEN: ${ctx.reason ?? 'zone_trip'}`,
            _ladderLine(setup, ladder, tf),
            `LENS: ${lensLine(setup.trade_mode)}`,
            _armedLine(setup),
            `PRIOR MEMO: ${setup.monitor_state?.memo || '(none)'}`,
            ..._dataBlocks(setup, g, tf),
        ].filter(Boolean).join('\n\n')

        const primary = g.png
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: g.png } }, { type: 'text', text: userText }]
            : userText

        return _runRead(setup, _SYSTEM, primary)
    } catch (err) {
        logger.warn(LOG, `assessment failed for ${setup?.id}:`, err.message)
        return { _failReason: 'io' }
    }
}

/**
 * The model loop both reads share: route, run tools until the model stops asking, parse.
 *
 * Extracted rather than copied when the in-position read arrived — the verification loop is the one
 * part of an assessment that is pure mechanism (round handling, the server-tool empty-turn trap, the
 * runaway backstop, the failure taxonomy), and it is identical whether the question is "enter?" or
 * "still holding?". What differs between the two is only the SYSTEM prompt and the user content,
 * which is exactly the judgment each read owns.
 *
 * Never throws: a failed read returns a typed marker so the caller can be honest about WHY and
 * reschedule, rather than wedging the loop.
 */
async function _runRead(setup, systemText, primary) {
    try {
        const { model, reasoningEffort } = await assessRouting(setup.userId)
        // `model` is not optional here: _thinkingConfig floors the models that reason by
        // default (Opus 5, Sonnet 5) to 'low' when no effort is set, and without it that floor
        // is skipped — leaving Opus 5 with thinking OFF, where it can emit a tool call as plain
        // text that silently never runs. A monitor is entirely tool-driven, so that reads as a
        // wake that assessed nothing.
        const thinking  = _thinkingConfig(reasoningEffort, model)
        const maxTokens = thinking ? MAX_TOKENS_THINKING : MAX_TOKENS
        const system    = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
        const tools     = buildToolsFor(setup)
        const messages  = [{ role: 'user', content: primary }]

        // What this wake actually spent. With no round cap (below) this record IS the cost control:
        // measure what the reads really reach for, then set a ceiling from data rather than a guess.
        const calls = []
        const runToolUses = makeAssessToolRunner({
            symbols: symbolScope(setup),
            log: LOG,
            onCall: (name) => calls.push(name),
        })

        // The verification loop: the model checks each condition with whatever tools the sentence
        // needs, pulling another view when the first leaves it unsure.
        //
        // NO QUALITY CAP while developing (docs/desks/mentor-talos.md). A four-condition
        // setup spanning two symbols does not fit in the three rounds this used to allow, and
        // capping to a guessed number silently truncates the read into a verdict formed on partial
        // evidence — an invisible failure, because the model still answers. Measure with `calls`
        // first; size the real ceiling from that.
        //
        // RUNAWAY_ROUNDS is NOT that ceiling — it is a backstop set far above any honest read. The
        // caller's withTimeout ABANDONS a slow check but cannot CANCEL it, so a model that loops
        // (e.g. retrying a blocked symbol instead of marking it unchecked) would keep billing in a
        // detached promise long after the wake was given up on. Hitting this is a bug, and it logs
        // like one.
        const RUNAWAY_ROUNDS = 25
        let msg
        for (let round = 0; ; round++) {
            // Same breakpoint walk the desks use (anthropic.provider), so a 25-round read pays for
            // its earlier rounds once instead of on every round. `mutableTail: 0` because this loop
            // never rewrites a tool result — unlike the desk loop, nothing here is still in flux,
            // so the breakpoint can sit on the newest turn rather than lagging one behind.
            advanceToolLoopCache(messages, 1, { mutableTail: 0 })

            msg = await _client.messages.create({
                model, max_tokens: maxTokens, system, messages, tools,
                ...(thinking ?? {}),
            })
            bookAssessUsage(setup?.userId, model, msg?.usage, 'talosAssess')
            if (msg.stop_reason !== 'tool_use') break

            const results = await runToolUses(msg.content)
            // `web_search` is server-side: Anthropic runs it and the blocks come back as
            // `server_tool_use`, which the runner correctly ignores. If a turn contained ONLY those,
            // there is nothing for us to answer — and posting an empty user turn is both an API
            // error and an infinite loop, since the next reply would stop for the same reason.
            if (!results.length) {
                logger.info(LOG, `[${setup.id}] tool turn with no client-side calls — taking the reply as final`)
                break
            }

            messages.push({ role: 'assistant', content: msg.content })
            messages.push({ role: 'user', content: results })

            if (round >= RUNAWAY_ROUNDS) {
                logger.error(LOG, `[${setup.id}] RUNAWAY: ${round + 1} tool rounds (${calls.join(', ')}) — abandoning the read`)
                return { _failReason: 'runaway', _calls: calls }
            }
        }

        if (calls.length) logger.info(LOG, `[${setup.id}] ${calls.length} tool call(s): ${calls.join(', ')}`)

        try {
            // `_calls` rides back on the assessment so the monitor can record per-wake cost. Prefixed
            // like _failReason: it is envelope, not something the model authored.
            return { ...extractFirstJSON(_allText(msg)), _calls: calls }
        } catch (parseErr) {
            logger.warn(LOG, `reply unparseable for ${setup.id} (stop_reason=${msg?.stop_reason}):`, parseErr.message)
            return { _failReason: msg?.stop_reason === 'max_tokens' ? 'truncated' : 'malformed', _calls: calls }
        }
    } catch (err) {
        logger.warn(LOG, `assessment failed for ${setup?.id}:`, err.message)
        return { _failReason: 'io' }
    }
}

// ─── In-position read ──────────────────────────────────────────────────────────

/** What a management wake may decide. Ordered by urgency in the monitor's severity table. */
// `add_leg` is only ever offered when a PLANNED entry zone is printing and the gate is not
// adverse — the monitor never invents size the plan did not authorise.
export const MANAGEMENT_VERDICTS = new Set(['hold', 'let_run', 'add_leg', 'take_partial', 'move_stop', 'exit_now'])

const _SYSTEM_POSITION = `You are Talos, watching a trade the user is ALREADY IN. The entry is done and the broker is holding the protective orders. You were woken because something arithmetic changed — price is pressing the stop, a target came into reach, the trade crossed +1R, or enough time passed that the thesis is due a re-read.

IF A PLANNED SECOND LEG IS PRINTING you are told so, with the zone. add_leg takes it; anything else declines it for now. Only ever offer it when that zone is in front of you — never propose size the plan did not already authorise, and never to rescue a trade that is going against you. Declining is a real answer: the level printing does not oblige you to add if the reason for the trade has weakened.

YOU ARE NOT DECIDING WHETHER TO ENTER. That question is settled. You are deciding whether the reason for being in this trade still holds, and whether the protection around it is still right.

THE THESIS AND ITS CONDITIONS ARE STILL THE MANDATE. They were the reason for the trade; they are the reason to stay in it. Re-read them against what is happening NOW — a condition that was true at entry can stop being true, and that is the single most useful thing you can tell the user. Judge exactly the declared conditions, the same way you did at entry: "measured" means apply the user's own test, "judgment" means they handed you the call. If you cannot check one, mark it "unchecked" and say why — never mark it met because it probably still is.

WHAT THE NUMBERS MEAN. R is measured from the risk originally taken, so it does not move when the stop moves. MAE and MFE are how far the trade went against and in favour SINCE ENTRY — a position at +0.4R that has already seen +2.1R is a trade giving back its gains, and that is a different conversation from one grinding up to +0.4R for the first time.

Verdicts, and be strict — "hold" is the right answer most of the time:
- "hold" — the thesis is intact and the protection is right. Nothing to do. Say so plainly.
- "let_run" — working, and working for the reason you expected. Bare, this is you explicitly declining to take profit here. If the move has genuinely more in it than the plan assumed, carry "new_tp" (and "why") to propose moving the target OUT to a level the chart justifies — a level, not a hope. Never move a target IN; that is take_partial, and dressing it as a target move hides a decision to reduce.
- "take_partial" — bank part of it. Say WHICH fraction of the ORIGINAL position: "third", "half" or "two_thirds". Never a share of what is left, or the position never reaches flat.
- "move_stop" — the protection is wrong for where the trade now is. Give the new level and say what it is anchored to (structure, breakeven, a level price has now defended). Never move a stop further from entry — protection only ever tightens.
- "exit_now" — the reason for the trade has gone, and waiting for the stop would be paying for information you already have. This is the strongest thing you can say; the thesis must actually be broken, not merely uncomfortable.

You never execute. Every verdict becomes a card the user confirms, so write for someone deciding in ten seconds.

Always include "read": ONE short first-person sentence — what you see and what you are doing about it.

TWO TIMEFRAMES, TWO JOBS. Your LADDER lists the rungs you may work on. The setup's own timeframe is where the THESIS lives; a rung or two finer is where the management decision lives — where the stop is actually being pressed, where a target is actually being reached. "next_timeframe" is the rung you want to open on next time, and it sets the pace with it: a coarser rung means you are content to look less often, a finer one means you want to watch this closely. Pick it from your ladder; anything else is ignored.

TARGETS COME IN TWO KINDS, and "resting" tells you which. A target with a resting limit is already an ORDER: it fills at that price on its own and needs nothing from you, so the question is only ever "shall we take something HERE, on the way", not "shall we take the target". A target with NO resting limit is one the author made conditional — nothing is holding it at the broker, so if you say nothing, nothing happens. Read its condition and answer.

THE STOP ALWAYS RESTS, whatever conditions it carries. You can propose tightening it and never removing it; if you say nothing, the position is still protected. That is deliberate — you propose, the user confirms, and neither of you is awake at 3am.

"guards" ARE WHEN YOU WANT TO BE WOKEN, and in a position they are what stands between a move and a missed reaction. Nothing looks at this trade between your reads except a cheap price check against these lines. Each guard fires only when EVERY term it carries holds:
- {"price":306,"direction":"below","means":"invalidation"} — wake me the moment it goes, ahead of any timer.
- {"after_min":30,"price":330,"direction":"above"} — look again in 30 minutes, but only if price got there.
- {"after_min":240} — the unconditional backstop, for what a chart cannot show.

Arm the levels where you would actually say something different: where the stop starts being pressed, where a conditional target comes into reach, where the thesis would break. Every guard is rewritten each read, so what you do not re-arm is forgotten.

Output ONLY a JSON object, no prose:
{"timeframe_used":"15min","read":"<one first-person sentence>","conditions":[{"id":"c1","met":"yes|no|unchecked","note":"what you actually saw"}],"verdict":"hold|let_run|take_partial|move_stop|exit_now","proposal":{"fraction":"third|half|two_thirds","stop":123.45,"new_tp":123.45,"why":"<what the level is anchored to>"},"next_timeframe":"15min","guards":[{"price":306,"direction":"below","means":"invalidation"},{"after_min":240}],"memo_update":"..."}
Include "proposal" ONLY for take_partial (fraction), move_stop (stop + why) or a let_run that moves the target (new_tp + why). Omit it entirely otherwise.`

/**
 * Run one in-position management read.
 *
 * Deliberately given the SAME conditions block as the readiness read. The alternative — a fresh
 * "how does it look" — throws away the only objective record of why this trade was taken, and turns
 * management into a second opinion rather than a re-check of the first.
 */
export async function assessPosition(setup, ps, ctx = {}) {
    try {
        const scenario = _armedScenario(setup)
        const ladder   = usableLadder(setup)
        const tf       = openingRung(setup)
        const g        = await gatherFor(setup, tf)

        const m = ps?.metrics ?? {}
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
                // Both ends of the window: `resting` is where the limit sits (the target the user
                // named), `wake_at` is where this conversation is allowed to start. A model shown
                // only one of them cannot tell "take it here" from "let the limit have it".
                targets: (ps?.targets ?? []).map(t => ({ resting: t.resting ?? t.price, wake_at: t.price, asked: t.hit_at != null })),
            })}`,
            `WHERE IT STANDS: ${JSON.stringify({
                r_now: m.r_multiple_now ?? null, worst_r: m.mae ?? null, best_r: m.mfe ?? null,
            })}`,
            _conditionsBlock(setup, scenario),
            `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
            `SESSION NOW: ${sessionPhase(setup.asset, setup.asset_class)}`,
            // The arithmetic that earned this wake. Naming it stops the read starting from scratch —
            // "price is pressing the stop" is a different question from "a target came into reach".
            `WHY YOU WERE WOKEN: ${_wakeReason(ctx.reason)}`,
            _ladderLine(setup, ladder, tf),
            _armedLine(setup),
            `PRIOR MEMO: ${setup.monitor_state?.memo || '(none)'}`,
            ..._dataBlocks(setup, g, tf),
        ].filter(Boolean).join('\n\n')

        const primary = g.png
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: g.png } }, { type: 'text', text: userText }]
            : userText

        return _runRead(setup, _SYSTEM_POSITION, primary)
    } catch (err) {
        logger.warn(LOG, `position assessment failed for ${setup?.id}:`, err.message)
        return { _failReason: 'io' }
    }
}

/** The premise that actually won the entry — its conditions are the ones still on the hook. */
function _armedScenario(setup) {
    const id = setup?.armed_scenario_id
    return (setup?.scenarios ?? []).find(s => s.id === id) ?? pickScenario(setup)
}

/**
 * The guards standing right now — what the LAST read asked to be woken by
 * (docs/desks/talos-guards.md).
 *
 * Shown because a guard set is REPLACED WHOLE on every read, never merged: a model that cannot see
 * what it armed three hours ago is re-deriving the watch from scratch each time, and the lines it
 * happens not to re-arm go quiet without anyone deciding they should. Seeing them makes the rewrite
 * a decision — keep this one, move that one in, drop the one the trade has walked away from.
 *
 * Absent on the first read of a setup, which is honest: there is nothing armed yet.
 */
function _armedLine(setup) {
    const guards = setup?.monitor_state?.guards
    if (!Array.isArray(guards) || !guards.length) return null
    return `CURRENTLY ARMED (you wrote these last read; they are replaced by whatever you return now): ${JSON.stringify(guards)}`
}

function _wakeReason(reason) {
    switch (reason) {
        case 'adverse':   return 'price is pressing the working stop — this is the look BEFORE it, while there is still a decision to make.'
        case 'scale_out': return 'price has entered a target WINDOW — the limit is still resting above it, so this is the chance to take something here rather than wait for the whole position to go at the target.'
        case 'breakeven': return 'the trade is at or past +1R and the stop is not yet protected past entry.'
        default:          return 'a periodic thesis review is due — price has not done anything in particular, which is not the same as nothing having changed.'
    }
}
