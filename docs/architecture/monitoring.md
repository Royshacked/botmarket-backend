# Monitoring System Architecture

## Overview

The monitoring system watches active trade ideas and automatically evaluates their conditions
against live market data. It runs as a background service inside the Express process.

**Reversibility:** The entire system lives in `monitoring/`. Only two lines in `server.js` reference it:
```js
import { minosService } from './monitoring/minos.monitor.service.js'
minosService.start()
```
Delete those two lines + the `monitoring/` folder = complete removal.

---

## High-level flow

```
server startup
    │
    ▼
minosService.start()
    │
    └── setInterval(_tick, 60s)  +  immediate first tick
              │
              ▼
         getDb().find({ status: { $in: ['looking', 'long', 'short'] } })
              │
              ▼
         for each idea (sequential, not parallel):
              │
              ├── check gap?   (time since last check < timeframe gap)
              │       └── yes → skip
              │
              ├── market closed + intraday equity?  →  skip
              │   (crypto USDT/USDC pairs run 24/7 — always evaluated;
              │    a PURE time-only entry is exempt — see §6 Time)
              │
              ├── getCandles(asset, timeframe, 300)   ← ohlcv.provider → priceService
              │   (separate timeframes for entry / stop / TP)
              │
              ├── status === 'looking' (entry phase):
              │       └── evaluateTree / evaluateConditions(entry, activatedAt)
              │               └── triggered?  →  patch: status='hit', entryTriggeredAt=now
              │
              └── status === 'long' | 'short' (position phase):
                      ├── evaluateTree / evaluateConditions(stop, activatedAt)
                      │       └── triggered?  →  patch: status='closed', closedReason='stop'
                      │
                      └── evaluateTree / evaluateConditions(tp, activatedAt)
                              └── triggered?  →  patch: status='closed', closedReason='tp'
```

---

## Check gap (rate limiting per idea)

To avoid excessive API calls, each idea is only re-evaluated after a minimum time has passed
since its last check. The gap is determined by the idea's `timeframe` field.

| Timeframe | Check gap |
|---|---|
| `5min` | 5 min |
| `15min` | 15 min |
| `30min` | 30 min |
| `1hr` | 1 hr |
| `4hr` | 4 hrs |
| `day` | 4 hrs |
| `week` | 24 hrs |
| `month` | 24 hrs |

Gaps are tracked in-memory (`Map<ideaId, lastCheckedTimestamp>`). They reset on server restart —
acceptable for MVP; a restart just means slightly more eager checks on the next tick.

---

## Idea phases & activation

The idea `status` field drives which phase is active:

```
status: 'waiting'                            ← Created, not yet active

    │  user flips to 'looking'
    │  → activatedAt = Date.now()  (saved to DB)
    ▼

status: 'looking'   activatedAt: <ms>        ← Entry phase — monitoring active
    │
    │  entry_conditions AND/OR chain passes
    ▼
status: 'hit'       entryTriggeredAt: <ms>   ← Alert sent; user confirms order
    │
    │  user patches status after order fills
    ▼
status: 'long' | 'short'                     ← Active position
    │
    │  stop_conditions OR  →  status: 'closed', closedReason: 'stop', closedAt: <ms>
    │  tp_conditions   OR  →  status: 'closed', closedReason: 'tp',   closedAt: <ms>
```

Fields added to idea documents (all optional, non-destructive):

| Field | Type | Set when |
|---|---|---|
| `activatedAt` | ms timestamp | Status transitions to `looking` |
| `entryFloorAt` | ms timestamp | User chooses "reset window" / pre-flight "Reset" (`resetWindow` / `resetPreEntry` flags); else absent → floor falls back to `savedAt` |
| `entryTriggeredAt` | ms timestamp | Entry conditions trigger |
| `triggeredWhileWaiting` | boolean | Entry fired on an event that predates `activatedAt` |
| `triggerEventAt` | ms timestamp | The triggering event's candle time (when `triggeredWhileWaiting`) |
| `closedReason` | `'stop' \| 'tp'` | Position closes |
| `closedAt` | ms timestamp | Position closes |

### Entry detection floor

Entry conditions are evaluated against a **floor** = `entryFloorAt ?? savedAt`. Only
events that occur **at or after** the idea's creation count — a condition already met
before the idea existed never triggers an entry. Because the floor is `savedAt` (not
`activatedAt`), an event that happens while the idea is still `waiting` is caught on
the first tick after the user flips it to `looking`.

When the triggering event predates `activatedAt` (i.e. it happened during the
`waiting` window), the idea is flagged `triggeredWhileWaiting`. The confirm dialog then
offers three choices:

- **Confirm** — place the entry order.
- **Dismiss** — park the idea back to `waiting` with the entry floor **untouched** (and
  `triggeredWhileWaiting` preserved). If the user changes their mind and re-activates,
  the still-true event re-fires to `hit` and shows the dialog again.
- **Reset window** — park back to `waiting` and push `entryFloorAt` to now (sent via the
  `resetWindow` flag on the PATCH), so the dismissed event can't re-fire; only *new*
  events after now count. Clears the while-waiting flags.

The floor only ever moves forward via an explicit **Reset window** — neither a plain
Dismiss nor a re-activation silently resets it.

> Caveat (Dismiss → changed mind → re-fire): this is reliable for current-state evaluators
> (indicator / chart / news). For **structured** conditions, the re-hit only happens while
> the original rising-edge bar is still inside the `CANDLE_COUNT × timeframe` fetch window;
> after it scrolls out there is no false→true transition to re-detect. Left as-is for now.

Structured conditions report a precise trigger candle (rising-edge detection: the bar
where the condition *transitions* into true after the floor). LLM evaluators
(indicator / chart / news) read current state and timestamp a pass as "now", so the
`triggeredWhileWaiting` flag is precise only for structured-driven entries.

### Entry legs must currently hold (`requireHeld`)

A rising edge since the floor is necessary but **not sufficient** on the entry path. A
`structured` entry leg is evaluated with `{ requireHeld: true }` (passed from `_checkEntry`,
tree + flat), so it passes only if the edge fired **and** the level is still held on the last
candle (`evaluate` re-checks a snapshot; returns `{ pass:false, reason:'level_not_held' }`
otherwise). This stops a reverted breakout from staying latched true and firing an AND once a
lagging sibling (e.g. cumulative volume) later turns true — the classic "close above 1150 AND
volume, price back below 1150" false entry. Scoped to entry only (stop/TP unchanged); only
`structured` legs (`touch` legs rest as broker/monitor orders, not this path).

The evaluator's `stateLevel` snapshot mode (`floorAt=null`, `crossAbove`→`gt` / `crossBelow`→`lt`)
answers "is the level held right now?" — reused by both `requireHeld` and the pre-flight below.

### Arm-time pre-flight (already-satisfied entries)

When an idea is armed (→ `looking`, `tradeIdeas.service.updateIdea`), `minos.monitor.service.preflightEntry(idea)`
runs once (structured-only trees): it compares the **edge** eval (real floor) against the **state**
eval (`stateLevel`). If the level is already held but the edge won't fire (breakout already past, so
the idea would sit forever), the update returns `preEntry:{ alreadySatisfied, close }`. The frontend
prompts **Buy now / Edit / Reset** — *Buy now* → `POST /:id/trigger` (`triggerEntryNow`: → `hit` +
built plan → confirm dialog); *Reset* → `resetPreEntry` (re-stamp `entryFloorAt=now`); *Edit* → reopen
in chat. Best-effort; never blocks the status change.

---

## Condition orchestrator

`monitor.orchestrator.js` — takes a condition tree (or legacy flat array) and returns `{ triggered, which? }`.

The two key pieces of context threaded through all evaluations:

- **`floorAt`** — the detection floor (`entryFloorAt ?? savedAt` for entry; `activatedAt` for exits). Structured conditions use it for windowed rising-edge detection and to report a trigger candle timestamp; the chart evaluator uses it to constrain pattern recognition to candles formed at/after the floor.
- **`priorFindings`** — accumulated list of structured condition texts that already passed earlier in the same AND gate. Passed to chart evaluations as causal context.
- **`opts`** — an options object threaded through `evaluateTree`/`evaluateConditions`→`_evalOne`→`evaluate`: `stateLevel` (snapshot "is the level held now", collapses crosses to their threshold) and `requireHeld` (entry legs need edge **and** currently-held). Off by default; the entry path sets `requireHeld`, the arm-time pre-flight uses both.

### AND (entry conditions) — Gate-then-verify with context injection

```
conditions sorted by cost:
  time (-1) → touch (0) → structured (0) → volume (0) → indicator (1) → news (2) → chart (3)
      │
      ▼
  eval cheapest first; bail immediately on first failure
      │
      ▼
  each passing structured condition → appended to priorFindings[]
      │
      ▼
  chart condition receives:
    - activatedAt  (time window constraint)
    - priorFindings  ("look for the pattern that caused these")
      │
      ▼
  all pass? → { triggered: true }
  any fail? → { triggered: false }  (skip remaining)
```

**Example:** condition set `[price > 100 (structured), cup and handle (chart)]`

1. Structured `price > 100` passes → priorFindings = `["price > 100"]`
2. Chart prompt becomes: *"Condition: cup and handle. Context: 'price > 100' just triggered — look for the pattern that SET UP or LED TO this condition."*

### OR (stop / TP conditions) — Sequential short-circuit

```
conditions sorted by cost; evaluated sequentially
    │
    ▼
first pass? → { triggered: true, which: conditionText }
all fail?   → { triggered: false }
```

OR branches are **independent** — no prior findings are passed between them. The chart evaluator
still receives `activatedAt` (time constraint applies), but no causal context hint, since no
structured condition "caused" the chart pattern in an OR group.

### Condition tree format

The orchestrator supports a nested tree format (`entry_condition_tree`, `stop_condition_tree`, etc.)
that allows AND/OR nesting at arbitrary depth. Both formats work:

```js
// Flat array (legacy):
entry_conditions: [
    { condition: "RSI(14) below 30", type: "structured" },
    { condition: "volume spike", type: "indicator" },
]

// Nested tree (new):
entry_condition_tree: {
    operator: "AND",
    children: [
        { condition: "price > 100", type: "structured", timeframe: "day" },
        {
            operator: "OR",
            children: [
                { condition: "volume spike", type: "indicator" },
                { condition: "cup and handle pattern", type: "chart", timeframe: "day" },
            ]
        }
    ]
}
```

### Legacy compatibility

Old ideas stored conditions as plain strings. The orchestrator normalises both:

```js
// New format:
{ condition: "RSI(14) below 30", type: "structured" }

// Legacy format (still works):
"RSI(14) below 30"   →  treated as type: "structured"
```

---

## Condition types

There are **seven** leaf types. `structured` / `touch` / `volume` are deterministic local
math; `indicator` / `news` / `chart` are Claude reads; `time` is a pure clock gate.

| `type:` | evaluator | what it is |
|---|---|---|
| `structured` (default) | `structured.evaluator.js` | candle-**close** comparison (price/indicator vs number) |
| `touch` | `touch.evaluator.js` | intra-candle price **level** (usually offloaded to the broker) |
| `indicator` | `indicator.evaluator.js` | qualitative candle-pattern YES/NO |
| `chart` | `chart.evaluator.js` | visual chart pattern (vision) |
| `news` | `news.evaluator.js` | headline sentiment YES/NO |
| `time` | `time.evaluator.js` | wall-clock `after`/`before` gate |
| `volume` | `volume.evaluator.js` | volume threshold, `bar` \| `cumulative` |

A leaf with no `type` (or a bare string) defaults to `structured`.

### 1. Structured (`type: 'structured'`)

**Parse → Evaluate** pipeline, fully deterministic after parsing.

```
conditionText  (natural language string)
    │
    ▼
condition.parser.js  →  claudeJSON (Claude Haiku)
    │                   In-memory cache: same text → same result, no repeat LLM call
    ▼
ParsedCondition:
  { operator, subject, value, value2, confirmation }
    │
    ▼
structured.evaluator.js  →  pure math, no I/O
    │
    ▼
{ pass: boolean }
```

**Supported operators:** `gt`, `lt`, `gte`, `lte`, `eq`, `crossAbove`, `crossBelow`, `isBetween`

**Supported subjects (indicators):**

| Subject string | Description |
|---|---|
| `close`, `open`, `high`, `low` | Raw OHLCV price fields |
| `volume` | Bar volume |
| `rsi(N)` | RSI with period N (Wilder smoothing) |
| `ema(N)` | EMA with period N |
| `sma(N)` | SMA with period N |
| `macd_line`, `macd_signal`, `macd_hist` | MACD (12/26/9) |
| `atr(N)` | ATR with period N (Wilder smoothing) |
| `vwap` | Session-anchored VWAP (no period) — **intraday only** |

**VWAP** is a first-class subject with no period. It is anchored to the session start
(`ctx.sessionStartMs` — equity RTH 09:30 ET, crypto/futures/forex UTC-midnight; see
`market.service.sessionStartMs`) and computed by `calcVWAPSeries(candles, anchorMs)`
(`structured.evaluator.js`): cumulative `Σ(typicalPrice × vol) / Σvol` where typical price
= `(h+l+c)/3`, skipping pre-session bars. If the anchor is missing it falls back to the
newest bar's UTC-day open. The anchor is plumbed in only when a leaf's text matches
`/vwap/i` (`monitorUtils.hasVwap`) — a VWAP-only idea builds the session context with no
extra fetch. VWAP also works as an `indicator`-type column (the LLM candle table gets a
session-correct VWAP column when the condition mentions it).

**`confirmation`:** number of consecutive candles that must all satisfy the condition (0 = current bar only).

When a structured condition passes in an AND gate, its condition text is added to `priorFindings`
and forwarded to any subsequent chart condition in the same gate.

### 2. Indicator (`type: 'indicator'`)

Formerly `type: 'visual'` — `visual.evaluator.js` is now a legacy alias for `indicator.evaluator.js`.

```
conditionText  (e.g. "bullish engulfing on last two candles")
    │
    ▼
Last 20 candles → formatted as OHLCV text table
Pre-computed indicators included: RSI(14), EMA(20,50), SMA(20,50,200), MACD, ATR(14)
    │
    ▼
Claude Haiku: "YES or NO — is this condition present in the price action?"
    │
    ▼
pass = response starts with 'Y'
```

### 3. Chart (`type: 'chart'`)

```
conditionText  (e.g. "cup and handle pattern")
activatedAt    (ms timestamp)
priorFindings  (structured conditions that passed before this in AND gate)
    │
    ▼
Chart image (symbol + timeframe + auto-selected studies) — own KLineCharts headless
render of our FMP candles, chart-img.com fallback (cachedChartImage, OWN_CHART_RENDER)
    │
    ▼
Time constraint injected into prompt:
  "Only consider patterns that completed within the last N candles."
  (N = ceil((now - activatedAt) / timeframe_ms))
    │
    ▼
Causal context injected (AND gate only, when priorFindings non-empty):
  "Context: 'price > 100' just triggered — look for the pattern that SET UP this condition."
    │
    ▼
Claude Sonnet vision: "YES or NO — does this chart show the pattern?"
    │
    ▼
pass = response starts with 'Y'
```

**Time window logic:**
- `activatedAt` is stored when the idea moves to `looking` status.
- Candle count = `ceil((now − activatedAt) / timeframe_in_ms)`, minimum 1.
- If `activatedAt` is null (old ideas), the time constraint is skipped.

**OR vs AND behaviour:**
- **AND gate:** chart receives both `activatedAt` constraint AND `priorFindings` context.
- **OR gate:** chart receives only `activatedAt` constraint (no causal context — OR branches are independent).

Cost: 3 (most expensive — uses a vision-capable model).

### 4. News (`type: 'news'`)

```
conditionText  (e.g. "Fed announces rate cut")
symbol         (e.g. "AAPL")
    │
    ▼
newsService.getOrFetch({ category: 'companies', subject: symbol, query: symbol })
    │   (uses GNews file cache — 1h TTL)
    ▼
Top 20 headlines for the symbol
    │
    ▼
Claude Haiku: "YES or NO — do these headlines reflect the condition?"
    │
    ▼
pass = response starts with 'Y'
```

### 5. Touch (`type: 'touch'`)

A pure price **level** that triggers the instant price *trades at* it — intra-candle, not
on a candle close. `touch.evaluator.js`:

```
level = parsed.value              (non-finite → { pass:false, reason:'no_level' })
    │
    ▼
first candle at/after floorAt whose range includes the level:
    c.l <= level <= c.h           (direction-agnostic — from above OR below)
    │
    ▼
{ pass:true, triggerAt: <that candle's ms> }
```

Unlike `structured`, touch has **no rising-edge / confirmation logic** — it's a discrete
range-inclusion event. Both `structured` and `touch` are treated as *price leaves*
(`isPriceLeaf`), so their findings feed sibling `chart` nodes as causal context.

**Touch leaves are normally offloaded to the broker, not monitored.** The leaf `type` is
the single source of truth for what rests at the broker vs. what the software monitor
watches (`services/protectionPlan.service.js`):

- A **single** clean touch entry leaf → a broker-native **stop-market entry** (idea gets
  `entryOrderType:'stop'`, status `resting`).
- Each touch level in a stop/TP leg → its **own `positionId` closing order** (LIMIT for
  tp, STOP for stop), placed when the position opens. Touches no longer ride an attached
  native SL/TP on hedging accounts — every touch exit is a discrete closing order.
- `_leafBareLevel` gates offload hard: requires `type==='touch'`, no cross-asset `symbol`,
  a numeric `parsed.value`, and a price subject (`close/open/high/low`) — a mistyped
  `volume` leaf can never become a $-level order.

The touch evaluator therefore acts as a **fallback**: when a touch leaf sits in an AND
group with non-touch siblings, the leg can't be offloaded whole, so it stays on the
software monitor and this evaluator handles it. At a real broker the intrabar fill is done
by the venue; in paper mode the **paper fill engine** supplies it (see *Intrabar
evaluation* below).

### 6. Time (`type: 'time'`)

A wall-clock gate on a phase. `time.evaluator.js`:

```
leaf: { type:'time', after?, before? }   (each ISO-8601, or epoch ms, or epoch seconds)
    │
    ▼
pass = (after  == null || now >= after)
    && (before == null || now <= before)
```

- Both bounds empty/unparseable → **`true`** (the condition is ignored, so an author can
  fill dates in later). An unparseable-but-present value logs a warn, is treated as null,
  and never blocks.
- Time is the **cheapest leaf (cost −1)** and gates first. It also powers a candle-fetch
  optimisation: `isTimeBlocked` evaluates the tree optimistically (every non-time leaf
  assumed true, time leaves use the real clock); if the tree is still false, only the clock
  is to blame, so the monitor **skips fetching candles that tick** (`_canPassOnTime`).

#### Scheduled (timestamp) entries

A **timestamp idea** — a regular idea whose entry is a `time` leaf — schedules a market
entry for a wall-clock instant. It is **not** an immediate trade: it starts `waiting`, is
armed to `looking` like any idea, and fires when the clock passes `after`. Key rules:

- **Never immediate.** `saveIdea` treats `immediate:true` as real only when there is *no*
  gating entry condition (`resolveImmediate` / `hasEntryConditions`). A `time` (or any) entry
  leaf makes the idea conditional, so it can't be turned into a save-time market order.
- **Timezone.** The idea agent receives the browser's `clientNow` / `clientTz`
  (`_formatClientTime`) and converts a user's local clock time to an absolute-UTC
  `after` / `before`. Without a timezone it asks rather than guessing.
- **Off-hours determinism.** `_entryTimeGate(idea).allTime` marks a *pure* time entry;
  such an entry is **exempt from the market-closed skip**, so it fires on schedule even
  overnight, flips to `hit`, and the order defers as `awaiting_market`. When the market
  re-opens, `_marketSweep` surfaces it and posts the entry-confirm card (note `off_hours`).
- **Notification note.** The entry-confirm card carries a `note`: `passed_earlier` when the
  scheduled time was already past at arm-time (`after <= activatedAt`), `off_hours` when it
  surfaced at market open, else `null`. See the paper/live entry-confirm flow.

### 7. Volume (`type: 'volume'`)

A volume threshold with two modes (`leaf.mode`, default `'bar'`). `volume.evaluator.js`:

**`bar`** — threshold on the stated-timeframe bar, evaluated at **candle close**.
Delegates straight to the structured engine with subject `volume` (→ `c.v`), so it inherits
full rising-edge / confirmation semantics. No new math.

**`cumulative`** — running total volume **since session start**, evaluated **intrabar**:

```
requires ctx.sessionStartMs   (else reason:'no_session_start')
candles here are 1-MINUTE bars (ctx.minuteCandles[symbol])
    │
    ▼
total = Σ c.v  for every 1-min bar with t >= sessionStartMs
    │
    ▼
snapshot compare (NOT rising edge): total vs threshold, triggerAt = now
    crossAbove/crossBelow on a monotonic intraday total collapse to > N / < N
```

Session anchor comes from `market.service.sessionStartMs` (crypto/futures/forex →
UTC-midnight, equities → RTH open 09:30 ET). Cumulative volume works for **exit** phases
too (`positionMonitor` builds the same `volCtx` for stop/TP).

---

## Intrabar evaluation

Most leaves are evaluated on the 60s poll against **closed** candles. Two mechanisms handle
genuinely intra-bar conditions:

**1. Cumulative-volume 1-min clamp.** When any phase has a cumulative-volume leaf
(`hasCumulativeVolume`), that idea's per-idea check gap is clamped to `min(gap, 60_000)` so
it re-checks at most every 60s, reading a freshly-fetched 1-min series
(`buildVolumeCtx`). The monitor itself has **no sub-minute loop** — touch in the monitor
path evaluates against fetched candles, not a live tick.

**2. Paper fill engine** (`monitoring/paperFill.service.js`) — a separate global loop
(`setInterval`, default **5s**, `PAPER_FILL_INTERVAL_MS`) that sweeps every user's `working`
paper orders and does true intra-bar touch/limit fills off the live quote's high/low:

```
isTriggered(order, quote):
  stop  long  → quote.h >= trigger      limit long  → quote.l <= trigger
  stop  short → quote.l <= trigger      limit short → quote.h >= trigger
```

i.e. a long TP at 432 fills the moment the high reaches 432 even if the bar closes back
below. This is the paper "matching engine" that stands in for the fills an offloaded
(broker-native) order would get at a real venue — for both resting entries and `positionId`
closing exits. (See `docs/architecture/paper-trading-simulation.md`.)

---

## Cost map (leaf ordering)

`monitor.orchestrator.js` sorts each AND/OR gate cheapest-first and, for groups, orders by
the **max** cost of the group's children:

| type | cost | why |
|---|---|---|
| `time` | −1 | pure wall-clock, gates first + can skip candle fetch |
| `touch` | 0 | local range check |
| `structured` | 0 | local math |
| `volume` | 0 | local sum/compare |
| `indicator` | 1 | Claude Haiku read |
| `news` | 2 | Claude Haiku + GNews fetch |
| `chart` | 3 | Claude vision + screenshot |

Unknown types default to cost 0.

---

## Claude usage

All LLM calls in the monitoring system use `claude-haiku-4-5-20251001` (fast, cheap).
Isolated in `monitor.claude.js` — separate from the trade agent's Anthropic client.

| Function | Used by | max_tokens | Purpose |
|---|---|---|---|
| `claudeJSON()` | condition.parser | 512 | Parse NL condition → JSON schema |
| `claudeText()` | indicator.evaluator, news.evaluator | 64 | YES/NO questions |
| `claudeVision()` | chart.evaluator | 64 | YES/NO on chart screenshot (claude-sonnet-4-6) |

**Condition parse cache:** `Map<normalizedText, ParsedCondition>` — in-memory, process lifetime.
Same condition string is only parsed once regardless of how many ideas use it.

---

## Files

```
monitoring/
  minos.monitor.service.js    Minos — idea monitor public API: start() / stop(), poll loop, per-idea dispatch
  hermes.monitor.service.js   Hermes — Kairos-call readiness monitor (own tick, kairos_calls)
  monitor.orchestrator.js     AND/OR logic, condition routing, context injection, legacy normalisation
  monitor.claude.js           Claude Haiku client (claudeJSON, claudeText, claudeVision)

  parsers/
    condition.parser.js       NL → ParsedCondition via Claude; in-memory cache

  evaluators/
    structured.evaluator.js   Pure math evaluation + all indicator calcs + VWAP series
    touch.evaluator.js        Intra-candle price-level range check (offload fallback)
    indicator.evaluator.js    Candle table + pre-computed indicators → Claude Haiku YES/NO
    visual.evaluator.js       Legacy alias for indicator.evaluator.js
    news.evaluator.js         GNews headlines → Claude Haiku YES/NO
    chart.evaluator.js        Chart screenshot + time/causal context → Claude vision YES/NO
    time.evaluator.js         Wall-clock after/before gate
    volume.evaluator.js       Volume threshold — bar (candle close) | cumulative (intrabar)

  ../services/protectionPlan.service.js   Routes touch leaves → broker native / closing orders
  ../monitoring/paperFill.service.js      Global 5s loop: intra-bar touch/limit paper fills

  providers/
    ohlcv.provider.js         Thin wrapper around priceService; normalises to {t,o,h,l,c,v}

  test.monitor.js             8-section smoke test (run: node monitoring/test.monitor.js)
  test.tree.js                Condition tree evaluator smoke test
```

---

## Future improvements (deferred)

- **After-market-close guard:** daily/weekly checks currently happen any time of day.
  Add a check: skip if market is closed and the current candle hasn't closed yet.
- **IBKR OHLCV:** when a user has IBKR connected, use their broker data instead of Massive.
  The `ohlcv.provider.js` is the single place to add this.
- **Persistent parse cache:** move condition parse cache from in-memory to MongoDB so
  it survives server restarts.
- **Per-user monitoring:** currently all active ideas are monitored globally.
  Future: scope monitoring to ideas owned by users with active broker connections.
- **Indicator context injection:** similar to Option A for structured→chart, pass indicator
  findings into subsequent chart prompts when they share an AND gate.
