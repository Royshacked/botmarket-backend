# FE Contract — Portfolio / Themis / Prometheus (2026-07-24)

Backend → frontend contract for the portfolio work landed this session (branch `institution-proj`,
uncommitted). Four surfaces cross into the FE; one is BE-only (listed so it's not chased).

Back-compat is built in everywhere below: the BE keeps accepting the **legacy `_idea` spellings**, so
the FE can adopt the new shapes without a lockstep deploy. New emissions from the BE already use the
`_item` shape, so the FE should **read/render** the new shape first and treat legacy as fallback.

---

## 1. Themis review card — `type: 'portfolio_review'` (additive fields)

The portfolio monitor (Themis) posts this to social chat when either gate fires. **The card type
already exists**; two fields were added to `payload`.

```jsonc
{
  "type": "portfolio_review",
  "botId": "portfolio",                // Atlas
  "content": "Time to review your portfolio \"Core\" (Paper · Sim). Flagged: …",
  "payload": {
    "portfolioId":   "pf_…",
    "portfolioName": "Core",
    "mode":          "paper",          // "live" | "paper" | "manual" | null
    "account":       "Sim",            // string | null
    "reviewCadence": "weekly",         // "weekly" | "monthly" | "quarterly"
    "lastReviewAt":  1721800000000,    // epoch ms | null
    "reason":        "event",          // NEW — "scheduled" | "event"
    "triggers": [                      // NEW — may be [] on a quiet scheduled cycle
      { "kind": "earnings", "severity": "medium", "label": "earnings within 7d: NVDA" }
    ]
  },
  "actions": /* "Review portfolio" */
}
```

**`triggers[].kind`** ∈ `conviction` · `coverage` · `drawdown` · `regime` · `drift` · `benchmark` ·
`earnings`. **`severity`** ∈ `high` | `medium`. **`label`** is a ready-to-display human string.

**FE work**
- Render `triggers` as "why look" chips (order is already severity-sorted, high→medium). Empty = a
  routine cadence nudge; the `content` already reflects that.
- `reason: "event"` vs `"scheduled"` may drive framing/icon (heads-up vs routine); optional.
- **Action "Review portfolio"** → open the portfolio (`payload.portfolioId`) in the agent chat with
  **review mode on** (see §4 — send `reviewMode: true`).

---

## 2. Prometheus refresh card — `type: 'coverage_refreshed'` (NEW)

Emitted when an async Atlas→Prometheus research refresh (requested mid-review) finishes rewriting a
held name's coverage. Prometheus (the analyst bot) pings the user to resume the review.

```jsonc
{
  "type": "coverage_refreshed",        // NEW card type
  "botId": "analyst",                  // Prometheus
  "content": "Fresh research on NVDA is ready for \"Core\" — <thesis gist>. Resume the review to fold it in.",
  "payload": {
    "kind":        "coverage",
    "symbol":      "NVDA",
    "coverageId":  "cov_…",            // may be null if persistence hiccupped
    "portfolioId": "pf_…",             // present when the refresh came from a portfolio review
    "ok":          true                // false = refresh failed; existing coverage left in place
  },
  "actions": /* portfolioId present → "Resume review"; else → "Open coverage" */
}
```

**FE work**
- New card renderer for `coverage_refreshed` (analyst bot styling, same shell as `coverage_event`).
- **Routing:**
  - `payload.portfolioId` present → **action reopens that portfolio in review mode** (`reviewMode:
    true`), so Atlas re-reads the freshened coverage. This is the primary path.
  - else → open the coverage artifact by `payload.coverageId`.
- `ok: false` → render the honest failure copy (already in `content`); the "Resume review" action
  still applies (nothing changed, but the user can continue).

**Related (optional):** the portfolio **stream response** now includes `coverage_refresh: { ticker,
question }` when Atlas fired a refresh in that turn. The FE may surface a transient "requested research
on NVDA…" chip. Not required for correctness.

---

## 3. `<portfolio_update>` block — `_item` shape (rename + new action)

What Atlas emits in a review/edit, what the RebalanceConfirmDialog renders, and what the FE sends back
verbatim to the apply endpoint. **Renamed off the legacy `_idea` vocabulary** (a portfolio holding is a
`portfolio_item` entity) and gained **`add_to_item`** (scale-in).

```jsonc
{
  "portfolioId": "pf_…",
  "thesis": { "strategy": "…", "targetExposures": [ { "label": "…", "target": 0.3 } ] },  // optional
  "changes": [
    { "action": "update_item", "itemId": "…", "patch": { /* notes, conviction, allocationRatio, *_conditions */ } },
    { "action": "remove_item", "itemId": "…" },                                          // pending/waiting only
    { "action": "exit_item",   "itemId": "…", "reason": "thesis broken" },               // full close (live)
    { "action": "trim_item",   "itemId": "…", "reduceFraction": 0.33, "targetAllocationRatio": 0.12, "reason": "overweight" },
    { "action": "add_to_item", "itemId": "…", "addFraction": 0.5, "targetAllocationRatio": 0.30, "reason": "add to laggard" },
    { "action": "add_item",    "item": { "asset": "TICKER", "direction": "long", "type": "swing", "allocationRatio": 0.2, "notes": "…" } }
  ]
}
```

| action        | id field | sizing field      | acts on            | effect |
|---------------|----------|-------------------|--------------------|--------|
| `update_item` | `itemId` | —                 | any holding        | patch fields, no broker touch |
| `remove_item` | `itemId` | —                 | pending/waiting    | delete doc (never a live position) |
| `exit_item`   | `itemId` | —                 | LIVE position      | full close, all accounts |
| `trim_item`   | `itemId` | `reduceFraction` (0–1) | LIVE position | partial close |
| `add_to_item` | `itemId` | `addFraction` (>0, may exceed 1) | LIVE position | **scale in (NEW)** |
| `add_item`    | — (`item` spec) | `allocationRatio` | new name       | create a `waiting` holding |

- **swap** = `exit_item`/`trim_item` + `add_item` in the same `changes` array (a convention, not an action).
- `targetAllocationRatio` on trim/add is **advisory** — weights are Atlas's; the platform does **not**
  force them to sum to 1.0 (freed cash may redeploy or sit as cash per the review).

**FE work**
- Emit the `_item` actions + `itemId`/`item` fields (the FE builds the block only when echoing what
  Atlas produced — Atlas now produces `_item`; just round-trip it unchanged).
- **RebalanceConfirmDialog: add a render row for `add_to_item`** (label e.g. "Add to", showing
  `addFraction` / target weight). Every other action already has a row under its old name — repoint the
  switch to the `_item` keys.

**Endpoints**
- **Apply:** `POST /api/portfolio/:portfolioId/rebalance`, body `{ update: <the block above> }`.
  Response: `{ ok, results: [ { action, itemId, ok, … } ], manualExitPosted, nextReviewAt }`.
- **Complete/dismiss (hold, no changes):** the existing completeReview endpoint (`outcome:
  "reviewed" | "dismissed"`) — unchanged.

### Back-compat (FE runway)
The apply endpoint normalizes legacy input, so a not-yet-updated FE won't break:
- action aliases: `update_idea→update_item`, `remove_idea→remove_item`, `exit_idea→exit_item`,
  `trim_idea→trim_item`, `add_idea→add_item`, `add_to_idea→add_to_item`.
- id/spec: reads `itemId ?? ideaId` and `item ?? idea`.

New Atlas output and the response `results[]` use `itemId` — adopt that field name on the FE.

---

## 4. Opening review mode (shared by §1 and §2 actions)

Both the Themis card and the Prometheus card route into **Atlas review mode**. The FE opens the
portfolio agent chat for `portfolioId` and sends the stream request with **`reviewMode: true`** in the
body (this is the flag that flips the server into the review sub-phases). No new endpoint.

---

## Not a FE concern (BE-only, listed to avoid chasing)

- **G2 — thesis in review context.** Atlas is now fed each holding's frozen `notes` + conviction
  `rationale` in review mode so it can judge intact/weakening/broken. Entirely server-side prompt
  context; nothing renders on the FE.
- **G4 — cTrader trim units fix.** Broker adapter internals; no FE surface.

---

## FE checklist

- [ ] `portfolio_review` card: render `payload.triggers` chips; optional event/scheduled framing via `payload.reason`.
- [ ] New `coverage_refreshed` card renderer (analyst bot) + routing (portfolioId → resume review; else open coverage; honor `ok:false`).
- [ ] RebalanceConfirmDialog: repoint action rows to `_item` keys and **add the `add_to_item` row**.
- [ ] Emit `itemId`/`item` (not `ideaId`/`idea`) and read `results[].itemId` from the apply response.
- [ ] (Optional) surface `coverage_refresh` from the stream response as a "research requested" chip.
