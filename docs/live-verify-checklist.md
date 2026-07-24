# Live-Verify Checklist — Themis / Portfolio order layer / Prometheus (2026-07-24)

Verification queue for this session's work (branch `institution-proj`, BE + FE committed,
**served bundle NOT yet rebuilt**). Nothing here is auto-verified — the unit tests lock the
logic, but broker execution and the end-to-end loop need a running app.

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
  **reduces** the position to the remaining size (not a full close) and banks partial P&L. The item's
  `pendingTrimQty` makes this work even before the Fill card forwards a `quantity`. (Manual **add**
  is not built yet — see below.)

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
