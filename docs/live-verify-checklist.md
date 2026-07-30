# Live-Verify Checklist

Running verification queue. Nothing here is auto-verified — the unit tests lock the logic, but
broker execution, agent behaviour and the end-to-end loop need a running app.

- **§A–C — Themis / Portfolio order layer / Prometheus** (2026-07-24, branch `institution-proj`)
- **§D–E — Review orders + agent venue awareness** (2026-07-30, branch
  `feat/agent-venue-and-review-orders`)

---

## Themis / Portfolio order layer / Prometheus (2026-07-24)

Branch `institution-proj`, BE + FE committed, **served bundle NOT yet rebuilt**.

**Preconditions legend**
`[MKT]` needs an open market · `[CTR]` needs a real cTrader account · `[PAPER]` paper venue is
enough (use a **crypto** holding — fills 24/7 even when equities are closed) · `[DEPLOY]` needs the
FE bundle rebuilt + deployed (`public/assets` currently serves the pre-change FE) · `[ANY]` runnable
now.

---

## A. Blocked — needs an open market + real cTrader (the live-money paths)

- [ ] **G4 — trim closes the right size** `[MKT][CTR]` — place a portfolio on real cTrader, trim a
  holding ~50%, confirm the broker closes **≈ half**, not a sliver. This is THE regression the units
  fix targets (it was closing ~1%). Check the position volume before/after.
- [ ] **G4 — full exit still works** `[MKT][CTR]` — `exit_item` closes the whole position across all
  its accounts; resting exits cancelled; idea flips `closed`.
- [ ] **G4 — trim that rounds ≥ whole size → full close** `[MKT][CTR]` — a large `reduceFraction`
  should close the position entirely, not error.
- [ ] **G3 — scale-in increases the position** `[MKT][CTR][DEPLOY]` — in a review propose
  `add_to_item` (addFraction 0.5), confirm; verify a **same-direction** order goes in and exposure
  grows. On cTrader (hedging) expect a **sibling position leg** under the same item; a new
  `brokerOrders` leg appears and its `positionId` backfills on fill.
- [ ] **G3 — multi-account fan-out** `[MKT][CTR]` — a book across ≥2 accounts adds per-account
  (each leg sized `floor(qty × addFraction)`); one account failing must not orphan the other
  (the placed leg is still linked).
- [ ] **G3 — reconciler linkage on a 2nd open** `[MKT][CTR]` — confirm the reconciler backfills the
  added leg's `positionId` and does NOT re-flip status or misbehave on an already-live idea.

## B. Runnable now — no open market needed (do these first)

- [ ] **Themis loop starts + ticks** `[ANY]` — boot the server; confirm `[themis.monitor]` logs the
  loop start and a tick, no errors, and it's independent of Minos.
- [ ] **Themis selects only in-position books** `[ANY]` — a constructed-but-not-entered book gets no
  card; an in-position book is picked up. (Force a due check by setting its `portfolio_chats.themis.next_check_at`
  to null / past.)
- [ ] **Themis gates fire** `[ANY]` — seed a trigger (e.g. bump a holding's drift or drop conviction,
  or set a held name's coverage `status:'thesis_broken'`) and confirm a `portfolio_review` card posts
  with the expected `reason` + `triggers`. Confirm the event dedup (same triggers don't re-ring).
- [ ] **G2 — review is grounded in the thesis** `[ANY]` — open an in-position portfolio in review
  mode; confirm Atlas's read references each holding's frozen thesis/rationale (not just P&L/drift)
  and judges intact/weakening/broken against it.
- [ ] **G1 — refresh hop runs end-to-end (server side)** `[ANY]` — in a review, prompt Atlas so it
  emits `<coverage_refresh>`; confirm `[coverageRefresh]` logs a run, Prometheus rewrites the coverage
  doc (check the `coverage` collection revision), and a `coverage_refreshed` card is posted. (Card
  rendering + resume routing is `[DEPLOY]` — see C.)
- [ ] **Rename — construction/edit edits still apply** `[ANY]` — edit a portfolio in chat so Atlas
  emits `update_item`/`add_item`/`remove_item`; confirm the client-side apply path executes them
  (this would have silently no-op'd before the FE update — verify it doesn't).
- [ ] **Back-compat — legacy `_idea` still works** `[ANY]` — a rebalance block using the old
  `trim_idea`/`ideaId` spelling still applies via the BE aliases (covers the not-yet-redeployed FE).
- [ ] **Paper trim + scale-in** `[PAPER]` — on a **paper** portfolio holding a **crypto** name, run
  `trim_item` then `add_to_item`; confirm the paper venue reduces / increases the virtual position
  correctly (paper handles partials natively — this exercises G3/G4 logic without a real broker).
- [ ] **G7 — manual partial trim** `[ANY]` (manual mode, no broker) — on a **manual** portfolio
  holding, run `trim_item` (e.g. 50%); confirm a Fill card posts, and submitting the exit price
  **reduces** the position to the remaining size (not a full close) and banks partial P&L.
- [ ] **G7 — manual scale-in (add)** `[ANY][DEPLOY]` (manual mode, no broker) — run `add_to_item` on a
  **manual** holding; confirm an ENTRY Fill card posts (leg flagged `add`), and submitting price + qty
  **grows** the live position (blended avg entry), not a new holding. Needs the FE bundle redeployed
  (the Fill card routes `add` legs to the new `/:id/manual-add` endpoint — unlike trim this does not
  fall back to the old endpoint).

## C. Needs the FE bundle rebuilt + deployed `[DEPLOY]`

- [ ] **Themis card renders triggers** — the `portfolio_review` card shows the trigger chips
  (severity-colored) and the scheduled-vs-event framing.
- [ ] **`coverage_refreshed` card + resume** — the new Prometheus card renders (with the bot icon —
  confirm `prometheus-bot.svg` survives the rebuild), and its primary reopens the review in review
  mode so Atlas re-reads the fresh coverage.
- [ ] **`add_to_item` row in the confirm dialog** — RebalanceConfirmDialog shows an "Add to X: +N%"
  row for a scale-in (not a raw action string).
- [ ] **Prometheus bot icon present after build** — verify `/img/prometheus-bot.svg` still served
  (the emptyOutDir drop is fixed in FE source, but confirm on the real deploy).

---

## Notes
- Redeploy the FE bundle before the `[DEPLOY]` items (and before G3's live check, since the confirm
  dialog needs the `add_to_item` row).
- G4/G3 are the only genuinely market-blocked items; everything in B can proceed now, and the
  `[PAPER]` crypto path can exercise the trim/scale-in logic end-to-end without waiting for equities.

---

# Review orders + agent venue awareness (2026-07-30)

Branch `feat/agent-venue-and-review-orders` (BE `5a20a51` + `c06842c`, FE `d83c821`). Same
preconditions legend as above. **No FE change was needed for either feature** — the confirm dialog's
`confirmIdea` derivation is kind-blind, so nothing here is `[DEPLOY]`-blocked except where noted.

## D. An accepted review actually buys the name (`add_item`)

The headline case first — this is the bug the change exists to fix.

- [ ] **The swap works end to end** `[PAPER]` (use a **crypto** holding so it fills 24/7) — in a
  review, get Atlas to propose a trim on one name and an `add_item` on another, then Accept.
  The trim should execute AND the new name should surface the **OrderConfirmDialog**. Before the
  fix the add silently became a `waiting` doc. Confirm the dialog appears within a poll cycle
  without touching the portfolio list.
- [ ] **The size is right** `[PAPER]` — the proposed quantity should be
  `floor(bookValue × allocationRatio / livePrice)`, where `bookValue` is the book's live notional.
  Sanity-check it against the account: a 20% weight on a $50k book at $200 ≈ 50 shares. A wildly
  wrong number here is the most expensive failure mode in the change.
- [ ] **Sizing is measured BEFORE the block applies** `[PAPER]` — propose an `exit_item` **and** an
  `add_item` in the same review. The add must be sized off the PRE-exit book value; if it shrinks
  because the exit ran first, the "measure once up front" guard is not holding.
- [ ] **Confirming actually places** `[MKT][CTR]` — confirm the dialog on a real cTrader book and
  verify the order goes in, `brokerOrders` is written, and the reconciler links the fill. This is
  the ordinary `placeOrdersForIdea` path, but it has never run for a `portfolio_item` from a review.
- [ ] **Market closed → parks, then surfaces at open** `[MKT]` — accept a review with an add while
  the market is shut. Expect `orderState: 'awaiting_market'` and NO dialog; then at open, Minos's
  `_marketSweep` should flip it to `awaiting_confirm` and post the `entry_confirm` card. Worth
  catching: the sweep is kind-blind, so a portfolio item should ride it, but that is untested live.
- [ ] **Manual book** `[ANY]` — same flow on a **manual** portfolio: no order plan, an ENTRY Fill
  card instead; submitting price + qty opens the holding. Check the leg is NOT flagged `add` (that
  flag routes to `/manual-add`, which is for scale-ins — a new holding must go to `/manual-entry`).
- [ ] **A conditional add is armed, not parked** `[ANY]` — get Atlas to emit an `add_item` carrying
  `entry_conditions`. It must land as `looking` (monitored), not `waiting`, and later confirm via
  the normal `entry_confirm` card. `waiting` here means the fix regressed.
- [ ] **Duplicate guard** `[ANY]` — propose `add_item` for a name the book already holds in the same
  direction. Expect a refusal (`already_held_use_add_to_item`) and **nothing written** — now that
  add opens a real order, a duplicate add would be a duplicate position. An opposite-direction add,
  and a re-entry into a `closed` name, must still be allowed.
- [ ] **Honest degradation** `[ANY]` — with the price feed failing (or a book of zero live notional),
  the holding should still be recorded, `unsized: true`, and no invented quantity. Same for a book
  with no resolvable accounts: recorded, `planned: false`, nothing pretending to await confirmation.

## E. Every desk reads the venue

The behavioural half. The injected live-book block is **gone**, so the risk is no longer a wrong
number — it is an agent that never looks and reasons as if the book were empty.

- [ ] **Desks actually call `get_trading_context`** `[ANY]` — **the most important item here.** Drive
  a sizing turn on each desk (Kairos Phase 7, Idea's risk-budget step, Atlas Phase 5, Mentor's
  sizing) and confirm the tool is called before the size is stated. Prompts are the only thing
  carrying this now and prompts are what tests cannot verify. If a desk skips it, the fix is the
  lever already used for tradability: enforce it in code rather than ask.
- [ ] **Balances cover EVERY account** `[ANY]` — with ≥2 accounts on a broker, all of them report a
  balance. The retired `loadContext` used `getAccount`, which only ever returned the selected one;
  this is the gap that closed, so it is worth actually looking at.
- [ ] **Positions land on the right account** `[ANY]` — open positions across paper + manual (and
  live if available) appear under their own account, with `pnlPct` signed correctly for shorts.
- [ ] **`check_broker_symbol` — listed** `[CTR]` — a name the broker carries returns
  `tradable: true` with the broker's real name. Include an aliased one: `NQ` should come back as
  `US100.cash` with `mappedFrom: 'NQ'`.
- [ ] **`check_broker_symbol` — not listed** `[CTR]` — a name the account genuinely does not carry
  returns `tradable: false`. (A US small-cap is a good probe on a CFD account.)
- [ ] **`check_broker_symbol` — UNREACHABLE is not "no"** `[CTR]` — kill the cTrader session / pull
  the network mid-call and confirm `tradable: null` with the "availability unknown" note, and that
  the agent SAYS unknown rather than telling the user the instrument is unavailable. This is the
  state the whole three-way split exists for and the one most likely to be got wrong.
- [ ] **Availability rides on the quote** `[MKT][CTR]` — on a live book, ask any desk about a ticker
  and confirm the `get_quote` result carries `broker_availability` **without the agent asking for
  it**, and that a `tradable: false` actually stops the desk building the setup. Then check the
  5-minute cache: a second quote on the same ticker must not re-hit the broker, and a different
  user must not be served the first user's answer.
- [ ] **Axl answers account questions** `[ANY]` — ask Axl "which account am I on / what am I holding
  / what's my balance". It has tools for the first time; confirm it reads them instead of deflecting
  or inventing, and still routes to a desk the moment the question turns into "should I buy it".
- [ ] **No desk still expects the removed block** `[ANY]` — skim each desk's first reply for
  references to a positions block that no longer exists, and confirm none of them assert an empty
  book without having called the tool. Analyst especially: it was reading `brokerContext` from the
  request body (always empty in practice), so this is the first time Prometheus can see the book at
  all.
