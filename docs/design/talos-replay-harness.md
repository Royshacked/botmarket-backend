# Talos replay harness — build plan

**STATUS: IN BUILD.** Step 1 (the recorder) shipped 2026-09-20; the same day the runner's
adapter shipped as a LIVE admin menu instead of an offline replayer (see *The live comparison*
below); steps 2, 4 and 5 are not started. This file is the plan and the record of what each step
settled; the recorder's contract is the paragraph in
[desks/mentor-talos.md](../desks/mentor-talos.md#what-a-read-is).

## What it is

A cost-AND-quality measurement for the Talos read. Every read Talos makes is recorded — prompt,
tools, trajectory, verdict, and the market as it stood — so a candidate model can be run through the
SAME read later, on frozen data, and graded against what price actually did. It decides whether a
cheaper model gets the verdicts right. **It changes nothing about the monitor**: Talos keeps reading
on Sonnet; the harness only measures.

Why a replay and not a public board: tool-calling leaderboards are vendor-skewed and none of them
measures a candle read. Talos is the one flow in the app with a natural outcome label — the trade's
own stop and targets — so a replay is cheap and honest.

## The steps

1. **Recorder** — `monitoring/talos.recorder.js`, behind `TALOS_RECORD_READS=1`. **BUILT
   2026-09-20.** `_runRead` in `talos.assess.js` is now a wrapper over `_readLoop` that fills a
   `trace` (routing, finalized tools, messages, per-round usage, calls, stop reason, elapsed) and
   hands it to `recordRead` after the answer is in — fire-and-forget, never awaited by the read.
   One JSON bundle per read under `data/eval/talos-reads/<day>/` (gitignored: bundles carry live
   plans; the userId is hashed and nothing else about the user is written). The bundle:
   - `setup` — the plan snapshot, **every** scenario (not just the one on the table), armed ids,
     monitor/position state.
   - `wake` — reason, price, rung, ladder, the scenario and zone on the table, the watched legs.
   - `prompt` — the exact system text and user text, the finalized tool list.
   - `routing` — model, effort, thinking config, max tokens.
   - `trajectory` — every message including the final reply, cache markers stripped; usage per
     round; calls; stop reason; elapsed ms; `error` when the loop threw.
   - `result` — what `_runRead` returned (the verdict, or `_failReason`).
   - `pack` — fetched right after the read: raw candle rows (`_fetchCandleRows`, forming bar
     included) for every symbol in scope × every rung of the ladder; the `getQuotes` text; a plain
     chart PNG of the setup's own asset on every rung (one at a time — the renderer serves live
     reads too); `errors` naming every cell that failed (a failed cell is `null`, never a missing
     pack). Raw bars rather than pre-formatted candle text so the replay's frozen tool runner can
     serve `get_candles` AND compute `get_indicators` for any spec a candidate asks for, with the
     app's own math.

   Two sinks (`TALOS_RECORD_SINK`): `disk` for the laptop; `mongo` (the `talos_reads` collection
   of the app's own db) for the deployed instance, whose disk is ephemeral — `pull-reads.mjs
   --db=test` brings those down into the disk layout and stamps them `pulled`. Decided 2026-09-20
   because the reads worth recording are real users' setups, and those run on Render.

   Measured on the smoke read: ~0.7 MB per bundle, pack fetched in ~5 s after a 40 s read.
2. **Label from price, not from Sonnet.** `should_enter` = entry reached and the first target
   printed before the stop within N candles of the rung; `should_not` otherwise; `undetermined`
   while the horizon has not elapsed (excluded, not scored). Decided 2026-09-20: the label is
   MECHANICAL — stop and targets are stop-market / limit orders at the broker anyway, so
   "target-before-stop" is exactly what would have happened; no judgment call. `N` per rung is the
   one open number. The zone arithmetic lives in `talos.gates.js`.
3. **Runner.** Anthropic candidates go through the REAL `_runRead` with injected `{ model, effort,
   client, toolRunner }`; other vendors through ONE new `providers/openaiCompat.provider.js` tool
   loop (the adapter that would ship if a candidate won; `MODELS` already carries provider /
   streamFn). The frozen tool runner serves `(tool, canonical args)` from the trajectory and the
   pack; a miss is the normal tool-error string, COUNTED per candidate as a scaffold limitation, not
   a score. `web_search` becomes a client tool answered from the frozen trajectory; cases that used
   it are tagged. Cost per call through the app's `calcCost`; timeouts / 429 / truncation /
   unparseable go to `errors.jsonl`, never scored as zero; `response.model` asserted.
4. **Graders (atomic):** parsed · enter_recall (the tail) · false_enter (the expensive mistake) ·
   guards_sane (reuse `clampGuards`) · conditions_checked · sonnet_agree (drift only) ·
   read_quality (pairwise blind judge from a different family than the candidate, A/B randomised).
   Report: a confusion matrix per candidate with absolute cost / rounds / latency beside it.
5. **Before paying:** an oracle run (Sonnet on its own trajectory ≈ reproduces its verdict; the
   spread is the noise floor), null candidates (constant `wait` must fail recall, constant `enter`
   must fail false_enter), then a 5-case pilot × every candidate → `report.html` for sign-off.
   ~50 cases × 2 reps ≈ ±10 points; stratify by reason (candle / guard / first_look / expiry) and
   by rung.

Layout: `scripts/eval/talos-replay/` (`pull-reads.mjs` today; label · run · grade · report to
come); data in `data/eval/talos-reads/`.

## The live comparison (2026-09-20)

Before building the offline replayer, Roy asked what the price list and the read's shape already
say. They say: a Talos read is INPUT-heavy (~41k input tokens across its rounds vs ~1.4k out — every
round re-sends the prefix and the chart), and Anthropic's cache turns three quarters of that into
$0.30/M, so Sonnet's effective input price is ~$0.9/M and any vendor above ~$0.75/M list with a
weaker cache is not cheaper. Only the sub-$0.5/M models are a different cost class — 5–10× — which
is the difference between a 15-min setup costing ~$28/month and ~$5. Cost is arithmetic; chart-
reading fitness is not, and no public board measures it.

So the runner's adapter (step 3 — `providers/openaiCompat.provider.js`) shipped as a **live admin
menu**: `TALOS_MODELS` in `assess.shared.js`, the *Monitors* card on the admin's profile, and the
admin's own setups read on the chosen candidate from their next wake, every journal row naming the
model. Same prompt, same tools, real setups, side by side in the pop-out — the fit question answered
on the desk rather than in a harness. The recorder captures every one of those reads, so the
offline replay (steps 2, 4, 5) stays available for the statistical proof once a candidate looks
credible by eye. Chosen candidates: Sonnet 5 (in-family, ~10–15% cheaper), GPT-5.6 Luna (the price
floor; vision confirmed on OpenRouter), Qwen3.7-Plus (best open tool-caller, vision), and Mistral
Medium 3.5 — the planned Mistral Large 3 turned out unreachable (Mistral's own API lists no Large;
OpenRouter has it batch-only), and Medium 3.5 took the slot as a fit data point rather than a cost
case (~half of Sonnet at best with their cache). Out: Gemini Flash (barely cheaper than Sonnet
cached, price doubles 2027-01), DeepSeek (vision experimental), GLM/Kimi (no saving on this shape),
gpt-oss (no vision).

First reads, 2026-09-20, the same NVDA first-look: Sonnet 5 wait/met in 25 s (~$0.045); Luna
wait/NOT met in 40 s, five tools in one parallel round, OpenAI's cache active (~$0.004); Qwen
wait/met in 165 s over four rounds, the most precise read of the three but past the monitor's
90-second check timeout (~$0.025). Three models, two answers on the same condition — the question
the menu exists to ask.

### The desks, same day

Roy asked whether the desks' base could move too. Two steps: (1) **Sonnet 5 is the desks'
default** (`llmModels.DEFAULT_MODEL`, 2026-09-20) — in-family, $2/$10, ~10–15% net after its
tokenizer, more on output-heavy desks; (2) **GPT-5.6 Luna as an admin-only chat candidate** through
the streaming twin `streamOpenAICompatWithTools` (same suppressor, tools and hooks as the Anthropic
loop; OpenRouter's web plugin stands in for `web_search`). Qwen3.7-Plus and Mistral Medium 3.5
joined the chat menu the same day as fit data points (Roy: "why not put the others"). First Mentor turn on Luna (2026-09-20, NVDA framing): six tools in one
parallel round, 14 s, a coherent entry/stop/target with R shown, emit tags captured, ~$0.015 against
Sonnet 5's ~$0.02 warm / ~$0.10 with a cold prefix write. The desks are input-heavy through the
cache, so the saving there is an OUTPUT story ($1.20 vs $10 per M) — the ledger's `byModel` row
over a week of real use is the measurement, then it is a tier decision, not a global switch.

## Decisions

- **The monitor does not change.** Roy, 2026-09-20.
- **Label is mechanical** (above). Roy, 2026-09-20.
- **No consent gate per user** on whose reads go to non-Anthropic vendors — "the simplest".
  userId is hashed in every bundle. Roy, 2026-09-20.
- **Candidates** — decided 2026-09-20 (see *The live comparison*): Sonnet 5 · GPT-5.6 Luna ·
  Mistral Medium 3.5 · Qwen3.7-Plus, against Sonnet 4.6. Haiku stays out of the menu (rejected for
  a real read).

## Open

- `N` (the label horizon) per rung.
- Recording is a capture-window setting, not a permanent one: the pack is ~10 candle fetches, 5
  renders and a quote per read in the background. `day`-rung reads need ~4 weeks for their labels
  to settle, so the capture window has to start early — the recorder shipped before the
  2026-09-21 open for that reason.
