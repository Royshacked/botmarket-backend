# Kairos — Build Plan

Kairos is a new **discretionary day/swing** agent. Its artifact is a **call** (Idea produces
*ideas*; Kairos produces *calls*). User + Kairos locate a ticker, classify the horizon
(intraday / day / swing), map price **zones** and **reference levels**, hypothesize the
**patterns** that work for that asset (price-action weighted over indicators). The agent emits a
**draft call**; the user clicks **Generate** to persist it (nothing auto-saves — mirrors Idea's
build-then-activate flow). Accounts are marked at the **bank icon** (like Idea/Atlas) and bound
at Generate. A dedicated self-scheduling monitor — **Hermes** (`monitoring/hermes.monitor.service.js`),
running under the user's synced Hermes model + reasoning preferences — then watches the mapped zones
and, when price is in a zone, runs a four-axis readiness read (market / news / price-action /
patterns), and — if the read is good — proposes an entry (entry/stop/TP snapped to reference levels,
size ≤ user cap) as a **decision card**. The user confirms; Kairos's job ends there (pre-entry
readiness only).

## Guiding constraints
- **New agent, new collection, new monitor loop.** Reuse *mechanisms* (chart fetch, vision,
  candles, indicators, cTrader symbol gate), never *schemas*.
- **Zero blast radius:** `kairos_calls` collection, own `setInterval`, no writes to `ideas` or
  `minos.monitor.service.js` (Minos, the idea monitor). Throwaway if the trial doesn't pan out.
- **Trial scope = pre-entry readiness only.** Kairos gets you into a well-timed entry with a
  static stop/TP attached, then hands off. No in-position management (trailing, adverse-exit,
  scale-out) — that's Phase 5, deferred.
- Per CLAUDE.md: each phase ends with tests + the inner QA / bug-hunt / conflict-check loop.

## Reuse map (mechanisms, confirmed)
- **Chart image:** `providers/chartImg.provider.js` `fetchChartImage()` + `buildStudies`
  (re-exported from `monitoring/evaluators/chart.evaluator.js`). Idea's `get_chart` hands the
  image to the **main agent model** (no small model) — Kairos does the same at build time.
- **Cheap per-wake chart read:** `claudeVision` (Sonnet, `monitoring/monitor.claude.js:65`).
- **Near-level gate:** arithmetic `lower <= price <= upper` (Kairos zones), cf. `touch.evaluator`.
- **Persistence:** mirror `api/trade-ideas/tradeIdeas.service.js` (`saveIdea`, `ensureIdeaIndexes`).
- **cTrader symbol gate:** copy Idea's gate → resolve `broker_symbol` via alias map, compute
  `basis_offset` for indexes. Conversion is **boundary-only, applied once** (order edge).
- **Notify:** decision card fires via the shared notify/eventBus path (invalidation-card mechanism).

## Call JSON contract (frozen)
One document per call in `kairos_calls`. Three sections: **identity**, **plan** (authored at
build, ~immutable), **monitor_state** (written each wake, mutable). The agent emits the `plan`
fields inside a `<call>` block (a draft); `broker`/`accounts`/`broker_symbol`/`basis_offset` are
bound server-side at Generate from the marked accounts.

- **plan:** `asset`, `asset_class`, `trade_type` (intraday|day|swing), `bias`, `thesis`,
  `timeframe_ladder` (context→trigger), `cadence.{min_gap_min,max_gap_min}`
  (defaults by horizon when the call omits them — intraday `1/5`, day `1/15`, swing `5/30` min;
  the idle poll reschedules at `max_gap`, so these bound Hermes's worst-case blind window between
  price checks — tightened 2026-07-11 from the original 2/30 · 5/60 · 60/720),
  `entry_zones[]` `{id, side, anchor, lower, upper, kind, note}` (gate; agent authors
  lower/upper as absolute numbers, volatility baked in),
  `reference_levels[]` `{id, kind, price, note}` (NOT gates; stop/TP snap targets),
  `patterns[]` `{id, name, type, weight, evidence(observed|inferred), confidence, timeframe,
  relates_to[], look_for}`, `sizing.{max_size, unit, risk_basis}` (user-given),
  `broker` (ctrader|paper|manual), `accounts[]`, `main_account_id`, `broker_symbol`,
  `basis_offset`, `valid_until`.
- **monitor_state:** `status` (waiting|watching|ready|confirmed|expiring|expired|dismissed),
  `next_check_at` (agent-chosen, clamped to cadence), `armed_zone_id` (single zone being
  assessed; first to trip; others stay latent), `chosen_timeframe`, `check_count`, `memo`
  (running scratchpad across wakes), `last_assessment`.
- **assessment write-back:** `at`, `reason` (zone_trip|scheduled|expiry_review), `zone_id`,
  `timeframe_used`, `market{read,score}`, `news{read,score(+blocking)}`,
  `price_action{read,strength}`, `patterns_seen[]`, `verdict`
  (enter|wait|stand_aside|let_expire|edit), `proposal{entry, stop, stop_ref, take_profit[],
  size, rr, rationale}` (present when verdict=enter; stop/TP snapped to reference_levels,
  size ≤ max_size), `edit_proposal{why, changes}` (present when verdict=edit),
  `next_check_at`, `memo_update`.

**Mode is DERIVED** from `broker`/account prefix (`isPaperIdea`-style), never a stored field.

**Construction gate:** cannot emit a playbook without `trade_type` + ≥1 `entry_zone`
(numeric `lower < upper`) + `sizing.max_size` + `broker`/`accounts`.

---

## Phase 0 — Persistence & contract (foundation) ✅ DONE
**Goal:** the call can be stored, read, and validated — no agent yet.
- `api/kairos/kairos.service.js` (mirrors `tradeIdeas.service.js`): `saveKairosCall`,
  `getKairosCall`, `listKairosCalls`, `deleteKairosCall`, `ensureKairosIndexes` (unique `id`,
  `user_id`, `status`) on `kairos_calls`.
- Construction-gate **validator** (`validateCall`): rejects unless `trade_type` + ≥1 `entry_zone`
  (`lower < upper`) + `sizing.max_size` + `broker`/`accounts`. `normalizeCall` builds the doc.
- **DONE:** 22 tests; wired `ensureKairosIndexes` in server.js.

## Phase 1 — Build agent (construction) ✅ DONE (backend, not live-verified)
**Goal:** a conversation produces a valid DRAFT call; the user Generates to persist.
- `services/kairos.agent.service.js`, forked from `idea.agent.service.js` scaffold: SSE stream,
  provider wiring, reasoning knob, tool-status chips. Emits a `<call>` draft (parsed by pure
  `_parseKairosResponse`); the stream returns it UNSAVED for preview.
- `kairos_system_prompt.md` = discretionary build spine: locate → classify → map zones
  (volatility-aware ranges) → reference levels → pattern hypotheses (price-action > indicators,
  evidence honesty) → confirm `max_size` + nudge to mark an account at the bank icon → emit `<call>`.
- `services/kairos.tools.js` = own tool schemas (`get_chart`/`get_candles`/`get_quote`/
  `get_earnings`/`web_search` + sentiment) reusing pure providers; candle machinery duplicated.
- **Generate → save:** `POST /api/kairos` → `_finalizeCall` binds marked accounts (bank icon) →
  **copied cTrader symbol gate** `_resolveVenue` (resolve `broker_symbol` + `basis_offset` for
  indexes) → `validateCall` → `saveKairosCall`. Multi-broker forking deferred (binds MAIN account).
- Routes: `POST /stream` (build), `POST /` (Generate), `GET /` (list). Mounted `/api/kairos`.
- **DONE:** 11 agent tests (parser, symbol gate, finalize gate). Full suite 191/191.

## Phase 2 — Monitor loop (the core invention) ✅ DONE (backend, not live-verified)
**Goal:** a stored call gets watched, assessed, and produces a verdict — LLM mocked in tests.
- `monitoring/hermes.monitor.service.js`: own 60s tick; loads `kairos_calls` where
  `status ∈ {waiting, watching}` AND `next_check_at` null-or-passed. (`expiring` is an
  awaiting-user state after an edit card, OUT of the loop — expiry review is triggered TIME-based
  via `_isExpiring` on waiting/watching calls, so no card spam.)
- Arithmetic gate `_zoneGate`: scan **all** `entry_zones` bands; FIRST trip arms (others latent).
- Assessment orchestrator (`_checkCall`): cheap gate → only if tripped/expiring runs the four-axis
  LLM+vision read (`_defaultAssess`, Sonnet + chart image; injectable). Pure post-processing:
  `_finalizeProposal` (snap stop/TP to `reference_levels`, clamp `size ≤ max_size`, R:R),
  `_computeNextCheckAt` (**clamp to cadence**), `_applyAssessment` (status + monitor_state $set +
  running memo carry), `_scheduledPatch` (cheap reschedule: idle→max gap, fail→min gap).
- Expiry review near `valid_until`: `enter | edit | let_expire` (→ ready | expiring | expired).
- `verdict === "enter"|"edit"` → fire card via injectable `deps.onCard` (Phase 3 wires real notify;
  currently logs).
- **DONE:** 26 tests (gate first-wins, snap both directions, size clamp, next-check clamp both
  ends, memo carry, all expiry transitions, + `_checkCall` orchestration with injected IO). Full
  suite 217/217.

## Phase 3 — Decision card & handoff ✅ DONE (backend, not live-verified)
**Goal:** user confirms → the right thing happens per mode.
- **Card = call STATE**, not a message: the monitor already persists `status: ready|expiring` +
  `last_assessment` (proposal / edit_proposal). Phase 4 FE renders a card from that. Social-chat
  delivery deferred (there's no eventBus — cards are `sendBotMessage`; that's the future add-on).
- `services/kairos.handoff.service.js` — `POST /api/kairos/:id/action` (confirm | edit | dismiss):
  - **confirm:** gate `status==='ready'` → `buildIdeaFromCall` (immediate market idea, direction =
    ARMED zone side, stop/TP as price levels) → `ideaService.saveIdea` (re-resolves broker symbol +
    basisOffset, builds exit trees) → **materializes a REAL idea and hands off to the existing
    system.** Then: manual → `notifyManualEntry` (FillCard, user reports fill); paper/live →
    `placeOrdersForIdea` (market entry + native stop/TP; basisOffset applied once inside the idea
    engine). Marks the call `confirmed` + `linked_idea_id`. Placement throw → `placement_failed`,
    call NOT marked.
  - **edit:** gate `status==='expiring'` → `applyEditPatch` (re-map zones/levels normalized,
    `valid_until`) → back to `waiting`, re-queued (`next_check_at: null`).
  - **dismiss:** `status: dismissed`.
- `deriveMode(broker)`: ctrader→live, paper→paper, manual→manual.
- **DONE:** 16 handoff tests (mode routing, idea mapping incl. armed-side direction, edit re-map,
  dismiss, placement-failure, ownership). Full suite 232/232. Multi-account broker fork on confirm
  deferred (binds first child).

## Phase 4 — Frontend surface ✅ DONE (build green, not live-verified)
**Goal:** it's usable. (frontend repo: `botmarket-frontend`)
- `src/services/kairos/kairos.service.remote.js` — mirrors scanner remote: `sendStream` (postSSE
  /api/kairos/stream), `generateCall` (POST /api/kairos with {call, accounts, mainAccountId}),
  `listCalls` (GET), `actOnCall` (POST /:id/action).
- `src/cmps/KairosPanel/KairosPanel.jsx` (+ .scss) — forked from ScannerPanel: `useChatStream` +
  `postSSE`, tool-status chips, reasoning; captures the DRAFT call from `done` (`data.call`),
  `CallDraft` preview (zones/refs/patterns), **Generate** button gated on `callReady &&
  ideaAccounts.length>0` → `generateCall`. Fetches `listCalls`, scopes by `brokerMode(broker) ===
  workspace`, renders `ReadinessCard` for ready/expiring calls (Confirm/Edit/Dismiss →
  `actOnCall`), and an active (waiting/watching) mini-list in the intro.
- `src/cmps/AxlHub/agentMeta.jsx` — added `AGENTS.kairos` (hue cyan) + to `AGENT_LIST` (hub card +
  tab). **NOT** in `BOT_IDS` (no social-chat feed — deferred with social delivery).
- `src/pages/MainPage.jsx` — import + mount `<KairosPanel>` tab (display-gated), `kairosLoading`
  state + live-dot branch, crumb 'Kairos', account selector (bank icon) shown for the kairos tab;
  passes availableAccounts/selectedAccounts/mainAccountId/workspace.
- Accounts marked at the bank icon (same `useBrokerAccounts` as Idea/Atlas); mode scoping reuses
  the `workspace` from `useWorkspaceMode`.
- **DONE:** `npm run build` green (438 modules), eslint clean on new files.

## Phase 5 — Deferred (out of trial scope)
- In-position monitoring after entry (manage / trim / exit / trailing / adverse-exit).

## Known softness (eyes-open, not blockers)
- **News via browse** is the weakest axis (recency is what web search is worst at).
- **`evidence: inferred`** dominates until Kairos measures history — the field keeps it honest.
- **Cross-space** only safe where existing math covers it (cTrader indexes); else keep
  chart-space == broker-space.
