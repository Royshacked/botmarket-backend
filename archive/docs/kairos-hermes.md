# Kairos + Hermes — the discretionary trade desk

**Kairos** builds a `call`; **Hermes** watches it. One kind, one collection (`kairos_calls`), one
monitor, from the first map of a zone to the closed position.

Replaces `KAIROS_PLAN.md`, `KAIROS_MODES.md` and `KAIROS_HERMES_ROADMAP.md` (2026-08-08), which
split one subject across three files and disagreed about what was built.

> ⚠️ **SILENT since 2026-08-09 — this is no longer the path a new trade takes.** New work goes
> Argus → Mentor → Talos; see [trade-pipeline.md](./trade-pipeline.md) for why, and for where the
> autonomous build returns as a premium Mentor mode.
>
> **Silent, not archived.** Hermes keeps running: calls already in flight run to their natural close
> under it, the same strangler used for legacy tree-`idea`s. Nothing in flight migrates, and nothing
> below is wrong — it describes a path that is frozen, not one that was removed. Read it when
> touching a live call.

---

## The split

**Kairos authors, and stops.** With the user it locates a name, classifies the horizon, maps price
**zones** and **reference levels**, and hypothesizes the **patterns** that work on that asset. It
emits a draft `<call>`; the user clicks Generate to persist it. Nothing auto-saves.

**Hermes decides when to look, and what it sees.** It is self-scheduling: it picks its own next wake
inside the call's cadence, and when price is in a zone it runs the assessment and proposes an entry.
Every action is a card the user confirms — Hermes never executes.

The two never share mutable state. Hermes owns its own tick and its own collection.

---

## The call document

Three sections, and the split between them is the design:

| Section | Written | Meaning |
|---|---|---|
| **identity** | at Generate | who/what — asset, class, broker binding |
| **plan** | at build, ~immutable | the thesis as authored. Re-authoring it is an `edit`, not a mutation |
| **monitor_state** | every wake | what Hermes has seen so far |
| **position_state** | from confirm on | the factual spine — fill, actions, outcome |

`plan` carries `trade_type` (intraday│day│swing), `bias`, `thesis`, `timeframe_ladder`
(context→trigger), `cadence.{min_gap_min,max_gap_min}`, `entry_zones[]`, `reference_levels[]`,
`patterns[]`, `sizing`, and `valid_until`.

**Zones gate; levels do not.** An `entry_zone` is a band with absolute `lower`/`upper` — volatility
already baked in by the author, so Hermes compares numbers rather than re-deriving tolerance.
`reference_levels` are snap targets for stop/TP, and are deliberately NOT gates: a level Hermes
could wake on would make every S/R line a trigger.

**Construction gate.** Kairos cannot emit a call without `trade_type`, at least one numeric zone
(`lower < upper`), `sizing.max_size`, and a broker/account binding. A call that can't be monitored
is not a call.

**Cadence bounds the blind window.** `min_gap`/`max_gap` default by horizon — intraday 1/5, day
1/15, swing 5/30 minutes. The idle poll reschedules at `max_gap`, so these are the worst case
Hermes can go without looking. (Tightened 2026-07-11 from 2/30 · 5/60 · 60/720, which was too long
to catch a fast break.)

---

## The three modes

**ONE agent, THREE lenses.** The method differs — analytical lens, tool subset, pattern vocabulary.
The output schema is **identical and lens-agnostic**, so Hermes reads a call verbatim without
knowing which lens built it. `mode` is a build-time label: it selects the prompt profile and tool
subset and shows a UI badge. **It never reaches the gate or Hermes.**

| Mode | Lens | Prompt |
|---|---|---|
| `discretionary` | classical price action — swing points, S/R, prior-day levels, VWAP, trend, momentum, chart patterns, false breaks. Indicators **confirm**, never lead | `prompts/kairos_mode_discretionary.md` |
| `smc` | strict smart-money — order blocks, FVG, BOS/CHoCH, liquidity (equal highs/lows, sweeps), premium/discount. Numeric engine **and** vision. No confirming indicators, no macro | `prompts/kairos_mode_smc.md` |
| `institutional` | **inverted phase order** — macro/regime, relative strength and positioning LEAD; candle triggers are demoted. Positioning folds into `market_sensitivity`/`thesis` | `prompts/kairos_mode_institutional.md` |

Two boundary decisions worth not re-litigating:

- **Order blocks / FVG / BOS-CHoCH / premium-discount belong to `smc` only.** Discretionary was
  reaching for order blocks first, which made it a weak SMC rather than a strong classical lens.
- **False breaks and sweeps are SHARED** — the same event, two vocabularies ("failed breakout" /
  "liquidity sweep"). Splitting them would have been a naming decision pretending to be a method one.

**Kairos does not choose the mode; it commits to one.** A feasibility gate warns (never blocks) when
an asset can't support a lens — SMC reads poorly on a thin small-cap, institutional needs positioning
data to exist. Argus's hand-off can pre-fill a recommendation. The user confirms every time, and
there is **no stored per-user default**: the discipline of a fixed lens is the value, and an agent
that re-decides mid-build collapses all three back into one adaptive blend.

---

## What Hermes actually does on a wake

A three-tier cascade, cheapest first — the point is to not pay for a vision read on a tick where
nothing happened.

1. **Arithmetic zone gate.** Is price in a mapped zone? Pure comparison.
2. **Proximity polling** (`_proximityGapMin`) — poll faster the nearer price is to a zone, so a fast
   break isn't sampled over. Plus a **momentum pulse** (`_shouldPulse`): a material, throttled move
   *away* from every zone also earns a look, tracked by `pulse_anchor_px` / `last_pulse_at`. The
   anchor is reset after every pulse and every in-zone assessment, so a slow grind accumulates
   instead of resetting each wake.
3. **The full visual read**, which may RE-MAP the call via `edit`/`edit_proposal`. This closes the
   "blind outside mapped zones" gap: a call whose zones the market has left behind can be redrawn
   rather than expiring silently.

In-zone or at expiry, the LLM assessment runs and returns a verdict:
`enter │ wait │ stand_aside │ let_expire │ edit`.

**Every axis is fact-sourced** (`hermes.assess.js`) — live chart and candles, company news, the
frozen `event_risk`, a LIVE broad-market read gated by the call's `market_sensitivity`, and the
session-of-day phase as a weighted lens. A tentative `enter` on a market-sensitive call gets a
second `web_search` pass to confirm before it fires (fail-open).

**Frozen vs live is a deliberate line.** `event_risk` (earnings + Fed/macro within ~10d) is frozen
onto the call at build so Hermes holds off entering into an unresolved binary. `market_sensitivity`
is frozen, but what it gates — the actual tape read — is fetched live. Scheduled facts freeze;
volatile facts don't.

---

## Lifecycle

```
waiting → watching → ready → confirmed → in_position → closed{outcome}
                       │                                    │
                       └── expiring → expired               └── stop-out + thesis intact
                                                                 → call_reentry card
```

**Confirm is not entry.** It places the order (live/paper) or posts the fill card (manual); the real
fill arrives later, when the reconciler flips the linked idea to `long`/`short`. Hermes watches that
idea: it promotes on fill (detected by `position_state.entry.fill_at`, not a status name) and closes
the call when the idea closes **from any cause** — stop, TP, a Hermes exit, or a close the user made
in the broker's own UI.

**Cards** (`tradeNotify`): `entry_confirm` on ready, `call_expiry` on expiring/expired — the last of
which previously expired in silence. Once a card fires the call leaves the monitor's active
statuses, so it cannot re-fire. At a stop-out (`_isStopOut` — not TP, not manual) a one-shot thesis
check can offer `call_reentry`: **Re-enter** revives the call to `waiting`, **Close** declines.

### The no-conflict boundary

A confirmed call materializes a real `idea` holding the position at the broker, so two brains could
fight over the same orders. One ownership flag settles it: the linked idea is stamped
`ownedBy: 'hermes'`, and the `idea` condition-tree loop skips it.

The **execution reconciler is deliberately untouched.** It is event-driven off `executionBus`,
independent of any poll, and it is the shared *hands* for every kind: it flips status on fill, places
the native stop/TP, re-sizes exits after a partial, finalizes closes and captures the trade. Hermes
drives management through the same broker primitives and the reconciler does the accounting off the
resulting events.

> One brain per position, one pair of hands for all of them.

---

## Open

Two clusters are **deferred pending a design decision the user owns** — do not build them until the
shape is specified:

- **Exits and scaling.** `size_pct` is null on every target; Kairos authors no ladder and Hermes
  improvises the whole exit. The open question is how much intent Kairos hands over versus how much
  Hermes decides.
- **Risk and sizing.** An `enter` proposal has no `size`, so everything fills to the `max_size` cap
  and `conviction` is decorative. The intent (`risk_basis: 'stop_distance'`) is already in the
  schema, unexecuted. Wants a risk budget, a conviction multiplier, and a decision about whether
  book heat lives here or with Atlas — which also gates cross-call correlation and total-open-risk.

Smaller, unblocked:

- Thin thesis/edge — no "why the inefficiency, who is on the other side".
- No liquidity/tradability gate (spread / ADV).
- Company news at decision time is cached headlines, not a live read.
- Breakeven-after-+1R is mechanical where a structure-based stop move would be better.
- Intrabar/wick trigger blindness — proximity polling helps, doesn't close it.
