# Portfolio Managing — Design Note

> **Status: DESIGN ONLY — nothing built yet.** Captured 2026-06-25 from a design discussion. This is a proposal/plan to resume from, not current architecture.

## Goal

Define **portfolio managing**: what happens *after* a portfolio is generated and entered, over a long horizon (e.g. 2 years), when the thesis or holdings need adjustment along the way. Today the flow stops at `build in chat → generate → await entry`. "Managing" is everything on the right side of entry.

## Current state (grounding)

- A portfolio is **not a collection** — it's a group of `ideas` sharing a `portfolioId`. Each idea carries the target weight (`allocationRatio`), thesis (`notes`), `conviction`, and `status`.
- An **edit flow already exists**: re-open a portfolio in chat → the agent emits `portfolio_update` blocks (`add_idea` / `remove_idea` / `update_idea`). In-position editing of stop/TP exit conditions already works.
- **Missing today:** drift monitoring, portfolio-level P&L aggregation, any action on **live** positions (no trim/add), and scheduled reviews.

Key files:
- `services/portfolio.agent.service.js`, `trade_portfolio_system_prompt.md`
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

## Two open decisions (settle before building)

1. **Where does portfolio lifecycle state live?** Recommendation: extend the existing `portfolio_chats` doc (already 1:1 by `portfolioId`, no migration) rather than spin up a new `portfolios` collection.
2. **Does freed cash redeploy?** When exiting/trimming, re-normalizing weights to 1.0 implies "stay fully invested." Alternative: exited capital sits as **cash** until the agent finds a use. This changes the weight math — decide before step 3.

## Traps flagged

- **Multi-account.** Portfolio ideas execute across `accounts[]` / `mainAccountId`. Every trim/add must be computed and placed **per account**, not on aggregate — the biggest source of complexity in step 3.
- **Long/short weight base.** Drift and "actual weight" need a defined base (gross exposure? net? notional vs. the `positionSize` budget?) the moment a portfolio holds both directions.
- **Long-term holds.** `type: 'long term'` ideas must not be intrabar-monitored between reviews — they're not swing trades.

## Next step

Lock the two open decisions, then write Phase 1 (state + eyes) as a concrete implementation plan.
