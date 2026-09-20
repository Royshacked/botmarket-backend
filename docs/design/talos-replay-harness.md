# Talos replay harness — build plan

**STATUS: IN BUILD.** Step 1 (the recorder) shipped 2026-09-20; steps 2–5 are not started. This file
is the plan and the record of what each step settled; the recorder's contract is the paragraph in
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

## Decisions

- **The monitor does not change.** Roy, 2026-09-20.
- **Label is mechanical** (above). Roy, 2026-09-20.
- **No consent gate per user** on whose reads go to non-Anthropic vendors — "the simplest".
  userId is hashed in every bundle. Roy, 2026-09-20.
- **Candidates** — proposed, not yet approved: in-house Sonnet 4.6 (baseline) · Sonnet 5 · Haiku
  4.5 (comparator only; Haiku for a real read is rejected); external GPT-5.6 Luna · Gemini 3.8
  Flash · Mistral Medium 3.5 · Mistral Large 3 · DeepSeek V4 Pro (US host only) · Qwen3.7-Plus ·
  gpt-oss-120B. Out: Nemotron 3 Ultra, Llama, Gemma.

## Open

- `N` (the label horizon) per rung.
- Recording is a capture-window setting, not a permanent one: the pack is ~10 candle fetches, 5
  renders and a quote per read in the background. `day`-rung reads need ~4 weeks for their labels
  to settle, so the capture window has to start early — the recorder shipped before the
  2026-09-21 open for that reason.
