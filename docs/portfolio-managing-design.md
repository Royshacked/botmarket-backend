# Portfolio Managing — Design Note

> **Status: DESIGN ONLY — nothing built yet.** Captured 2026-06-25 from a design discussion. This is a proposal/plan to resume from, not current architecture.

## Vision

### Social chat (future surface)
A community chat where users share ideas, portfolios, and scans with each other. This is the long-term home for portfolio management notifications — the bot participates in this chat alongside users.

### Phase 1 — Monthly review, user-initiated (build now)
Once a month the user gets a notification that it's time to review a portfolio. Notification surface: a **badge on the profile nav in the app header** → click opens a small dropdown listing pending portfolio reviews → each entry links directly to the portfolio chat in update mode with `computePortfolioState` pre-loaded. The agent walks the user through performance and proposes changes. User-initiated, bot-assisted.

### Phase 2 — Weekly monitor, proactive proposals (future)
The monitor runs weekly, analyzes every active portfolio, and decides if anything is *actionable* (drift beyond threshold, position down X% from entry, thesis age, upcoming earnings risk, etc.). If yes, it pushes a **specific proposal** into the social chat — not just "go review" but e.g. "I suggest trimming NVDA from 20% → 12% — it drifted +8 points and is up 34% since entry, which skews the book." User sees it in social chat and has two paths:
- **Quick confirm** — approves the proposed action directly from the notification (hits the existing `OrderConfirmDialog` gate)
- **Go to update mode** — opens the portfolio chat to discuss, modify, or reject interactively

**Key implication:** Phase 2 requires `computePortfolioState` to also produce an *opinion* — a scoring/triggering layer that detects actionable conditions and generates a proposal. Phase 1 doesn't need this (the agent reasons interactively). Building Phase 1's state computation cleanly means Phase 2 only adds the scoring layer on top.

---

## Goal

Define **portfolio managing**: what happens *after* a portfolio is generated and entered, over a long horizon (e.g. 2 years), when the thesis or holdings need adjustment along the way. Today the flow stops at `build in chat → generate → await entry`. "Managing" is everything on the right side of entry.

## Current state (grounding)

- A portfolio is **not a collection** — it's a group of `ideas` sharing a `portfolioId`. Each idea carries the target weight (`allocationRatio`), thesis (`notes`), `conviction`, and `status`.
- An **edit flow already exists**: re-open a portfolio in chat → the agent emits `portfolio_update` blocks (`add_idea` / `remove_idea` / `update_idea`). In-position editing of stop/TP exit conditions already works.
- **Missing today:** drift monitoring, portfolio-level P&L aggregation, any action on **live** positions (no trim/add), and scheduled reviews.

Key files:
- `services/portfolio.agent.service.js`, `portfolio_system_prompt.md`
- `api/trade-ideas/tradeIdeas.service.js` — `saveBatchIdeas` (~623), `updateIdea` (~276), `placeOrdersForIdea` (~434)
- Frontend: `MainPage.jsx` (`handleEditPortfolio` / `handleUpdatePlan` ~579-651), `TradeIdeasList.jsx` (portfolio grouping ~85-116)
- `portfolio_chats` MongoDB collection (1:1 by `portfolioId`)

## Decisions made

- **Trigger model = scheduled cadence.** A monthly/quarterly auto-review generates a check-in, summarizes performance, and proposes adjustments → user approves → orders placed.
- **Live-position actions = all of:** rebalance (trim/add to target), exit a holding, swap a holding, add a new holding.

## Design reframe (agreed direction)

Keep it **unified** with existing machinery — **agent proposes / user approves** via the existing `portfolio_update` + `OrderConfirmDialog`, **not** a separate auto-rebalancing engine.

- **Prerequisite — give the agent eyes:** `computePortfolioState(portfolioId)` produces, per holding, target vs actual weight (drift), unrealized P&L, % since entry, thesis age, and upcoming earnings. Reuses the existing `get_quotes` tool + actual filled quantities from the broker/reconciler. Nothing else is meaningful without this; it's also the easiest piece to verify.
- **Key reuse — trim = a partial `positionId` closing order.** This rides on the HEDGING `positionId`-closing-order infrastructure already proven live (reconciler + multi-level exits). Add = an entry-direction order on the existing idea. Exit = reconciler close. Swap = exit + add. All four actions collapse to: **compute target deltas → emit trim/add/close orders → confirm via `OrderConfirmDialog`** (respecting the confirm-dialog ownership gate).

## Build order (scheduler is LAST)

Even though the trigger is scheduled cadence, the cron is the final piece — the review flow must work on-demand first.

1. **Foundation — state + lifecycle home.** Add `computePortfolioState`, plus a portfolio lifecycle record holding `reviewCadence`, `nextReviewAt`, `lastReviewAt`, and a `reviewHistory[]` change log (date, action, deltas, rationale, performance snapshot). The change log feeds the agent on the next review.
2. **Review conversation (manual trigger).** Inject the live state into the portfolio agent; extend the `portfolio_update` vocabulary with live-position actions (`rebalance`/`trim`/`add`, `exit_idea`, `swap`). Propose → approve → place. Live-verify by opening a portfolio manually before any automation.
3. **Order layer for live positions.** Trim/add/close order-set builder + re-normalize weights to 1.0 (reuse the existing `_sizePlan` normalize). This is where the real risk lives (multi-account).
4. **Scheduler + surfacing.** A cron finds portfolios where `nextReviewAt <= now`, runs step 2 automatically, and surfaces the proposed review in NewsFeed (mirror the Scanner "Scans" tab pattern) with a notification. Frontend: cadence picker + target-vs-actual review view.

## Locked decisions

1. **Portfolio lifecycle state lives in `portfolio_chats`.** Extend the existing doc (already 1:1 by `portfolioId`, no migration). Note: if the portfolio grows into a richer entity (Phase 2 monitoring, social sharing, analytics), extracting to a dedicated `portfolios` collection becomes the natural inflection point.
2. **Freed cash re-normalizes to 1.0 by default — stay fully invested.** When exiting or trimming, remaining positions scale up to fill the gap. User can override this explicitly (e.g. "hold the cash") and the agent respects it, but the default is fully deployed.

## Traps flagged

- **Multi-account.** Portfolio ideas execute across `accounts[]` / `mainAccountId`. Every trim/add must be computed and placed **per account**, not on aggregate — the biggest source of complexity in step 3.
- **Long/short weight base.** Drift and "actual weight" need a defined base (gross exposure? net? notional vs. the `positionSize` budget?) the moment a portfolio holds both directions.
- **Long-term holds.** `type: 'long term'` ideas must not be intrabar-monitored between reviews — they're not swing trades.

## Phase 1 — Concrete implementation plan

### 1-A. Lifecycle fields in `portfolio_chats`

Extend the existing doc schema — no migration, just `$set` the new fields on first write.

```js
// New fields added to the portfolio_chats document
{
  reviewCadence:  'monthly',     // 'monthly' | 'quarterly' — default 'monthly'
  nextReviewAt:   <epoch ms>,    // set to now + cadence when chat is first saved
  lastReviewAt:   null,          // stamped when user completes a review
  reviewHistory:  [],            // { reviewedAt, summary, deltas[], performanceSnapshot }
}
```

**Where:** `api/portfolio/portfolioChat.service.js`

Add three functions alongside the existing ones:
- `getPortfolioLifecycle(portfolioId, userId)` → returns `{ reviewCadence, nextReviewAt, lastReviewAt, reviewHistory }`
- `setPortfolioLifecycle(portfolioId, userId, patch)` → `$set` patch on the doc (upsert)
- `addReviewHistoryEntry(portfolioId, userId, entry)` → `$push` to `reviewHistory`

Also update `saveChatState`: if the doc is being upserted for the first time (`upsert: true`), include `$setOnInsert: { reviewCadence: 'monthly', nextReviewAt: Date.now() + 30 * 86400000, lastReviewAt: null, reviewHistory: [] }`.

---

### 1-B. `computePortfolioState`

New file: **`services/portfolioState.service.js`**

**Input:** `{ portfolioId, userId }`

**Steps:**
1. Fetch all ideas with `portfolioId` from `ideas` collection. Split into:
   - **Live** — `status: 'long' | 'short'`
   - **Pending** — `status: 'looking' | 'waiting' | 'resting' | 'hit'`
2. For each **live** idea: iterate `idea.brokerOrders[]`, call `brokerService.getPositions(accountId)` per unique account, match by `positionId`. Sum `volume` and `pnl` across accounts (multi-account reality). Use `entryPrice` + `currentPrice` from the matched position.
3. Compute portfolio-level totals:
   - `totalNotional` = Σ (volume × currentPrice) across live ideas
   - `totalPnl` = Σ pnl across live ideas
4. Per live idea compute:
   - `actualWeight` = (volume × currentPrice) / totalNotional
   - `drift` = actualWeight − allocationRatio  (positive = overweight)
   - `pnlPct` = (currentPrice − entryPrice) / entryPrice × 100  (sign-adjusted for shorts)
   - `thesisAgeDays` = Math.floor((now − idea.activatedAt) / 86400000)
5. Fetch upcoming earnings for all tickers (next 30 days) via existing `getEarningsCalendar`.
6. Return:

```js
{
  portfolioId,
  computedAt: <epoch ms>,
  totalNotional,
  totalPnl,
  totalPnlPct,                      // totalPnl / (totalNotional - totalPnl) * 100
  ideas: [
    {
      ideaId, asset, direction,
      allocationRatio,               // target weight
      actualWeight,                  // null if not live
      drift,                         // null if not live
      pnl, pnlPct,                   // null if not live
      thesisAgeDays,
      upcomingEarnings,              // { date, epsEstimate } | null
      status, notes, conviction,
    }
  ]
}
```

---

### 1-C. Inject portfolio state into the agent (review mode)

**Where:** `services/portfolio.agent.service.js` → `chatStream()`

Add optional param `portfolioState` (the output of `computePortfolioState`). When present, append a `_buildPortfolioStateSection(state)` block to `dynamicSections` — formatted as a readable performance table the agent can reference without calling any tool.

The section renders as:

```
PORTFOLIO STATE (computed at <date>):
Total: $X notional, P&L: $Y (Z%)

  NVDA  — target 25% | actual 31% | OVERWEIGHT +6pt | P&L +$1,240 (+18.4%) | in position 47 days
  AAPL  — target 20% | actual 17% | underweight −3pt | P&L −$210 (−3.1%)   | in position 12 days
  GLD   — target 15% | actual 15% | on target        | P&L +$88 (+1.2%)    | in position 47 days
  TSLA  — target 40% | waiting entry — current price vs target noted in thesis
  ...
  ⚠ NVDA earnings in 8 days (2026-07-04)
```

---

### 1-D. Pending-review endpoint + in-app notification

**New endpoint:** `GET /api/portfolio/pending-reviews`
- Queries `portfolio_chats` for docs where `userId = req.user._id` AND `nextReviewAt <= Date.now()`
- Returns `[{ portfolioId, portfolioName, nextReviewAt, lastReviewAt }]`
- `portfolioName` resolved by looking up the first idea with that `portfolioId`

**Wire it:** `api/portfolio/portfolio.routes.js` + `portfolio.controller.js`

**Frontend (Phase 1 scope — badge + dropdown only):**
- Profile nav calls `GET /api/portfolio/pending-reviews` on mount; badge shows count
- Dropdown lists each due portfolio: "Time to review [Name] — last reviewed [date / never]"
- Clicking opens the portfolio chat in update mode with `computePortfolioState` fetched and passed in as `portfolioState`
- After a successful review session, `POST /api/portfolio/:portfolioId/lifecycle` stamps `lastReviewAt = now` and `nextReviewAt = now + cadence`

---

### Build sequence

| Step | What | File(s) |
|------|------|---------|
| 1 | Add lifecycle fields to `saveChatState` + the three lifecycle helpers | `portfolioChat.service.js` |
| 2 | Write `computePortfolioState` | `services/portfolioState.service.js` (new) |
| 3 | Add `portfolioState` param + `_buildPortfolioStateSection` to agent | `services/portfolio.agent.service.js` |
| 4 | Wire `computePortfolioState` into the portfolio stream endpoint | `portfolio.controller.js` |
| 5 | Add `GET /pending-reviews` + `POST /:id/lifecycle` endpoints | `portfolio.routes.js`, `portfolio.controller.js` |
| 6 | Frontend: badge + dropdown + review-mode trigger | frontend |

Start with step 2 and verify `computePortfolioState` output manually (console/test route) before touching the agent or frontend.
