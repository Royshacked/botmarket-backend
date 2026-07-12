# Building — from chat to an armed, monitored trade idea

## Overview

"Building" is the pipeline that turns a natural-language conversation into a structured,
monitored trade idea. Three conversational agents share the same shape:

```
client POST → SSE chat stream → Claude with tools → agent writes XML "emit" blocks inline
    → a tag suppressor pulls the blocks out of the token stream (UI never sees them)
    → structured object flows back on the terminal `done` event
    → user clicks Generate → POST persists the idea document
    → user arms it (status → 'looking') → the 60s monitor loop watches it
```

| Agent | Persona | Produces | Emit tag |
|---|---|---|---|
| **Trade** | "Idea" | one trade idea (stateful `<state>` accumulation) | `<trade_idea>` |
| **Portfolio** | — | a multi-idea allocation plan (sized server-side) | `<portfolio_plan>` / `<portfolio_update>` |
| **Scanner** | "Argus" | candidate list for one period × thesis | `<scan_list>` |

> `api/chat/*` is **user-to-user social DM**, not an agent — don't confuse the two.

Once persisted and armed, the idea is handed off to the monitoring system
([monitoring.md](./monitoring.md)) and, on trigger, to the broker layer
([broker.md](./broker.md)).

---

## 1. SSE chat routes

All three agents stream over Server-Sent Events; every router applies `requireAuth` + `log`.

| Agent | Route file | Endpoint | Controller |
|---|---|---|---|
| Trade | `api/idea/idea.routes.js` | `POST /api/idea/stream` | `streamIdea` |
| Portfolio | `api/portfolio/portfolio.routes.js` | `POST /api/portfolio/stream` | `streamPortfolio` |
| Scanner | `api/scanner/scanner.routes.js` | `POST /api/scanner/stream` | `streamScanner` |

**SSE mechanism** — `api/_shared/sse.util.js` `startSseStream(req, res)` sets
`text/event-stream` headers + `X-Accel-Buffering: no`, sends a 30s `: ping` heartbeat, and
wires an `AbortController` to `res.on('close')` so a client Stop/navigate aborts the LLM
work server-side. It returns `{ sendEvent, signal, finish }`; `sendEvent(event, data)`
writes `event: <name>\ndata: <json>\n\n`.

**Events streamed** (named SSE events, terminal event is `done`):

- **Trade:** `token`, `asset`, `interval`, `chart`, `phase`, `status` (tool-status chip),
  `reasoning`, then `done` → `{ reply, analysisState, phase, tradeIdea? }`
- **Portfolio:** `done` → `{ reply, plan, update, mandate, thesis, phase }`
- **Scanner:** `done` → `{ reply, scan, phase }`

Client SSE plumbing: `src/services/userPrompt/userPrompt.service.remote.js` posts JSON and
consumes events via `postSSE` + `buildStreamHandlers`.

---

## 2. Agent services & models

Every agent resolves its model through `services/llmModels.js` `resolveStreamFn()` — **all
models are Anthropic Claude**: `claude-opus-4-8`, `claude-sonnet-4-6` (default),
`claude-haiku-4-5-20251001`. Streaming runs through `providers/anthropic.provider.js`
`streamAnthropicWithTools`. The per-turn model + reasoning effort is chosen by
`services/modelRouter.service.js` `resolveModel()` (manual / auto phase-table / classifier
modes — e.g. Haiku for phase-1 extraction, Sonnet elsewhere). Usage is recorded via
`tokenUsage.service.js`.

System prompts are hot-reloaded (mtime-gated) by `agentUtils.js` `makePromptLoader(path)`
and sent as two cached content blocks — a stable base (`cache_control: ephemeral`) + a
volatile context tail.

### Trade agent — `services/idea.agent.service.js`
Prompt `idea_system_prompt.md`. Entry `chatStream` (non-stream `chat`). Tools:

| Tool | Purpose |
|---|---|
| `web_search` | live web lookup |
| `get_quote` | live price |
| `get_price_action` | 1d/5d/1m/3m moves + range position + rel volume |
| `get_candles` | OHLCV (2hr/4hr aggregated server-side) |
| `get_indicators` | exact EMA/SMA/RSI/MACD/ATR/VWAP values — same math the monitor uses (shared `makeIndicatorsHandler`) |
| `get_chart` | render a TradingView **image** for vision TA (Anthropic-only; shown to UI via `onChart` when `show_to_user`) |
| `get_cycle_analysis` | price-cycle / seasonal-window modes |
| `get_earnings` | single-ticker earnings + beat/miss history |
| `get_earnings_calendar` | forward earnings calendar (who reports when) |
| `get_fundamentals` | sector / valuation / margins / ROE / growth |
| `get_sec_filings` | SEC filings |
| `get_short_interest` | short-interest |
| `get_options_context` | options positioning |
| `get_derivatives_context` | crypto perps |

### Portfolio agent — `services/portfolio.agent.service.js`
Prompt `portfolio_system_prompt.md`. Tools add `get_quotes` (batch),
`get_risk_metrics` (annualized vol + ATR → sizing), `get_correlations` (pairwise matrix →
diversification), `get_fundamentals`, `get_earnings` (single-ticker + history),
`get_earnings_calendar` (plus the shared sentiment tools).

### Scanner agent — `services/scanner.agent.service.js`
Prompt `scanner_system_prompt.md`. Tools add `get_price_action` (1d/5d/1m/3m moves + range
position + rel volume), `get_cycle_analysis` (price-cycle / seasonal modes), `get_quotes`,
`get_risk_metrics`, `get_fundamentals`, `get_earnings` (single-ticker + history),
`get_earnings_calendar` (plus shared sentiment tools).

### Kairos agent — `services/kairos.agent.service.js` (tools in `services/kairos.tools.js`)
Prompt `kairos_system_prompt.md`. Discretionary day/swing **call** builder (single asset), a
self-contained sibling of the Trade agent — it shares the **same 14-tool analysis kit** as Idea
(reusing the pure providers + shared `marketData.tools.js` factories incl. `makeIndicatorsHandler`).
Five phases: classify → **analyse & map entry zones** → frame risk → patterns → **validate, size &
emit**. Emits a `<call>` (entry zones as bands + reference levels + patterns + sizing + `timeframe_ladder`
+ **`rr`/`conviction`**), parsed wholesale then persisted via `normalizeCall` to `kairos_calls`
(watched by Hermes — see `monitoring.md`). Fundamentals are weighted by horizon (light intraday/day,
heavy swing); the `timeframe_ladder` is authored deliberately for Hermes to pick a rung from.

---

## 3. The emit mechanism

Agents write structured output **inline as XML-tagged blocks**. A provider-agnostic tag
suppressor (`services/llmStream.util.js` `createTagSuppressor({ onToken, captures })`)
buffers the streamed text, **swallows the tag blocks so they never reach the UI**, and
forwards each block's inner text to an `onCapture` callback. (`keepText:true` lets a block
still stream to the user, e.g. `<ticker>`.) Each agent registers its own captures:

- **Trade:** `<state>`, `<trade_idea>`, `<asset>`, `<interval>`, `<phase>`
- **Portfolio:** `<portfolio_plan>` → `onPlan`, `<portfolio_update>` → `onUpdate`,
  `<portfolio_mandate>` → `onMandate`, `<portfolio_thesis>` (post-hoc from raw)
- **Scanner:** `<scan_list>` → `onScan`

**Trade parse** — after streaming, `services/idea.stateParser.js` `_parseResponse` regex-
extracts `<trade_idea>…</trade_idea>`, JSON-parses it, normalizes timeframes across the
condition trees, and extracts the rolling `<state>` block. The visible `<state>` block (not
the JSON) is what drives the frontend **Generate** button.

**Minimum to emit** (`idea_system_prompt.md`): Asset, Direction (long/short),
≥1 entry condition with a timeframe **or** `immediate:true`, Stop loss (not required for
immediate), Quantity. When all are present the Generate button activates on its own
(`ChatPanel.jsx` `generateReady`), tracking the live `<state>` block.

---

## 4. Idea data model

The idea document is constructed in `api/trade-ideas/tradeIdeas.service.js` `saveIdea`
(collection `ideas`). Key fields:

- **Identity / lifecycle:** `id` (uuid), `savedAt`, `status` (`hit` if immediate else
  `waiting`), `userId`.
- **Instrument:** `asset` (falls back to `ticker`), `asset_class`, `direction`, `type`,
  `quantity`.
- **Timeframes:** `entry_timeframe`, `stop_timeframe`, `tp_timeframe`.
- **Condition trees:** `entry_condition_tree`, `stop_condition_tree`, `tp_condition_tree`
  (built by `resolveConditionTree`), plus flattened `*_conditions` (`extractLeaves`) and
  `*_logic` (`topOperator`) kept in sync for legacy consumers.
- **Extras:** `additional_entries` (each with its own `condition_tree` + `quantity` +
  `triggeredAt`/`filledAt`), `notes`, `conviction`, `invalidation` (the actionable entry
  price range — see [invalidation-design.md](../invalidation-design.md)), broker
  `accounts` / `mainAccountId`, `chat_state`.
- **Entry-order routing:** `entryOrderType` (`'stop'` for a resting broker stop-market on a
  pure touch entry) + `entryTriggerPrice`, set by `detectNativeEntryLevel`
  (`protectionPlan.service.js`).
- **Forking:** multi-broker ideas are split into single-broker children via
  `_partitionByBroker` / `_groupByBroker`; global paper mode routes all to the paper broker.

**Status lifecycle** (`VALID_STATUSES`):

```
waiting → looking → hit → long | short → closed
                  ↘ resting (broker-native working stop-market entry)
```

- `waiting` — created, idle. `looking` — armed / monitored. `hit` — entry triggered, order
  plan built (→ confirm dialog). `long`/`short` — in position (broker-authoritative, and
  **delete-locked**). `closed` — done. `resting` — a broker-native stop-market entry is
  working at the venue. The frontend also has a pre-save `building` pseudo-status.

**Leaf condition shape:** `{ condition, type, timeframe }` (+ optional `symbol`, `quantity`,
`after`/`before` for `time`, `mode` for `volume`).

---

## 5. Condition tree structure

Single source of truth: `services/conditionTree.service.js`.

```js
// Group node
{ operator: 'AND' | 'OR', children: [ node, … ] }

// Leaf node
{ condition: string, type, timeframe, symbol?, quantity? }
```

Nesting is arbitrary depth. Legacy shapes (old `{ logic, conditions:[…] }` groups and flat
leaf arrays) are accepted and migrated on read (`normalizeTreeNode`). Helpers:
`extractLeaves`, `topOperator`, `firstLeaf`/`firstLeafTimeframe`, `collectSymbols`
(cross-asset leaves).

The **seven leaf types** (`touch` / `structured` / `indicator` / `chart` / `news` / `time`
/ `volume`) are defined for the agent in `idea_system_prompt.md` and evaluated in
`monitoring/evaluators/` — see [monitoring.md](./monitoring.md) for the evaluation
semantics of each. A leaf with no `type` defaults to `structured`.

---

## 6. Arming (waiting → looking) & pre-flight

Arming is a **status PATCH**, not a new document:
`PATCH /api/trade-ideas/:id` → `updateTradeIdea` → `ideaService.updateIdea`.

On `status: 'looking'` the service sets `monitorPhase='entry'`, clears `entryTriggeredAt`,
**stamps `activatedAt = Date.now()`**, and calls `minosService.resetIdea(id)`.
`activatedAt` gates the monitor's "triggered while waiting" logic.

**Pre-flight entry check** — after a successful arm, `minosService.preflightEntry(idea)`
runs on structured-only trees. It evaluates the entry tree two ways — will the monitor's
rising edge fire (`requireHeld:true`) vs. is the level already held right now
(`stateLevel:true`) — and returns `{ alreadySatisfied, close }` when the level is already
held but won't produce a fresh edge (so the idea would otherwise sit forever). That
`preEntry` rides back on the response; the frontend opens **PreEntryDialog** (Buy now /
Edit / Reset):

- **Buy now** → `POST /api/trade-ideas/:id/trigger` (`triggerEntryNow` → `hit` + built plan)
- **Reset** → `resetPreEntry:true` pushes `entryFloorAt` forward so only new events count
- **Edit** → reopen in chat

The 60s monitor loop then watches `looking` ideas and flips them to `hit` when the entry
tree triggers. See [monitoring.md](./monitoring.md) for the entry-floor / `requireHeld` /
pre-flight details.

---

## 7. Portfolio & Scanner specifics

**Portfolio** emits `<portfolio_plan>` (or `<portfolio_update>` in edit mode). The prompt
computes inverse-vol weights adjusted by conviction and emits an `allocationRatio` per idea
plus an optional total `positionSize`. **Sizing is finalized server-side** in `_sizePlan`:
ratios are normalized to sum to 1.0, and with a `positionSize` each
`quantity = floor(positionSize × ratio / livePrice)` using live quotes; it also computes
portfolio vol √(wᵀΣw) from vols + correlations. On Generate the plan becomes a **batch** of
ideas: `POST /api/trade-ideas/batch` → `saveBatchIdeas`, one `saveIdea` per idea sharing a
`portfolioId`. Review mode adds a live `portfolioState` snapshot + a rebalance-apply path.
(See [portfolio-managing-design.md](../portfolio-managing-design.md).)

**Scanner** emits `<scan_list>` — **candidates for one period × thesis**, not a trade:
`{ period:{label,start,end}, thesis, direction, candidates:[{ ticker, name, direction,
thesis, analysis, signals, conviction, sources }] }`. Edit mode can pass untouched
candidates as bare `{ ticker, keep:true }` references, rehydrated from the prior list. Scans
are saved via their own CRUD (`POST /api/scanner/scans`) and later **hand off** to the Trade
flow when a user selects a candidate to build a full idea. Both Portfolio and Scanner are
single-shot generators with server-side finalization, versus Trade's stateful single-idea
`<state>` accumulation.

---

## 8. Frontend touchpoints

Orchestrated by `pages/MainPage.jsx`.

| Agent | Panel | Generate handler |
|---|---|---|
| Trade | `cmps/ChatPanel/ChatPanel.jsx` (button gated by `generateReady`) | `MainPage.handleGenerate` → `createIdea` → `POST /api/trade-ideas` |
| Portfolio | `cmps/PortfolioPanel/PortfolioPanel.jsx` | `handleGeneratePlan` → `POST /api/trade-ideas/batch` |
| Scanner | `cmps/ScannerPanel/ScannerPanel.jsx` → `cmps/Radar/*` | `handleGenerateList` → scan CRUD |

The live Trade `<state>` block drives the Generate button and a `__building__` preview idea
(`deriveBuildingIdea`). Emitted/saved ideas surface in `cmps/TradeIdeas/*`
(`TradeIdeasList`, `TradeIdeaCard` status dropdown, `IdeaDetail`, `ConditionTree` renders the
AND/OR tree). Dialogs: **OrderConfirmDialog** (idea hit → order plan), **PreEntryDialog**
(arm-time already-satisfied), plus Delete/ClosePosition/EditOrders dialogs.

---

## Key files

```
SSE            api/_shared/sse.util.js
routes         api/{idea,portfolio,scanner}/*.routes.js + *.controller.js
agents         services/{idea,portfolio,scanner}.agent.service.js
prompts        idea_system_prompt.md / portfolio_system_prompt.md / scanner_system_prompt.md
emit/parse     services/llmStream.util.js  +  services/idea.stateParser.js
trees          services/conditionTree.service.js
persistence    api/trade-ideas/tradeIdeas.{routes,controller,service}.js
arming         tradeIdeas.service.updateIdea  +  monitoring/monitor.service.preflightEntry
models         services/llmModels.js  +  services/modelRouter.service.js
frontend       src/pages/MainPage.jsx  +  src/cmps/{ChatPanel,PortfolioPanel,ScannerPanel,TradeIdeas}/*
```
