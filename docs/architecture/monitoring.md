# Monitoring System Architecture

## Overview

The monitoring system watches active trade ideas and automatically evaluates their conditions
against live market data. It runs as a background service inside the Express process.

**Reversibility:** The entire system lives in `monitoring/`. Only two lines in `server.js` reference it:
```js
import { monitorService } from './monitoring/monitor.service.js'
monitorService.start()
```
Delete those two lines + the `monitoring/` folder = complete removal.

---

## High-level flow

```
server startup
    │
    ▼
monitorService.start()
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
              │   (crypto USDT/USDC pairs run 24/7 — always evaluated)
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
| `entryFloorAt` | ms timestamp | User chooses "reset window" (else absent → floor falls back to `savedAt`) |
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

---

## Condition orchestrator

`monitor.orchestrator.js` — takes a condition tree (or legacy flat array) and returns `{ triggered, which? }`.

The two key pieces of context threaded through all evaluations:

- **`floorAt`** — the detection floor (`entryFloorAt ?? savedAt` for entry; `activatedAt` for exits). Structured conditions use it for windowed rising-edge detection and to report a trigger candle timestamp; the chart evaluator uses it to constrain pattern recognition to candles formed at/after the floor.
- **`priorFindings`** — accumulated list of structured condition texts that already passed earlier in the same AND gate. Passed to chart evaluations as causal context.

### AND (entry conditions) — Gate-then-verify with context injection

```
conditions sorted by cost:
  structured (cost 0) → indicator (cost 1) → news (cost 2) → chart (cost 3)
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
Chart screenshot via chart-img.com (symbol + timeframe + auto-selected studies)
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
  monitor.service.js          public API: start() / stop(), poll loop, per-idea dispatch
  monitor.orchestrator.js     AND/OR logic, condition routing, context injection, legacy normalisation
  monitor.claude.js           Claude Haiku client (claudeJSON, claudeText, claudeVision)

  parsers/
    condition.parser.js       NL → ParsedCondition via Claude; in-memory cache

  evaluators/
    structured.evaluator.js   Pure math evaluation + all indicator calculations
    indicator.evaluator.js    Candle table + pre-computed indicators → Claude Haiku YES/NO
    visual.evaluator.js       Legacy alias for indicator.evaluator.js
    news.evaluator.js         GNews headlines → Claude Haiku YES/NO
    chart.evaluator.js        Chart screenshot + time/causal context → Claude vision YES/NO

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
