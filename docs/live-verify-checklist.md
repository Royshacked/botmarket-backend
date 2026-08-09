# Live-Verify Checklist

Running verification queue. Nothing here is auto-verified — the unit tests lock the logic, but
broker execution, agent behaviour and the end-to-end loop need a running app.

- **§A–C — Themis / Portfolio order layer / Prometheus** (2026-07-24, branch `institution-proj`)
- **§D–E — Review orders + agent venue awareness** (2026-07-30, branch
  `feat/agent-venue-and-review-orders`)
- **§F — Axl market brief** (2026-08-01) — F2/F4 partly cleared 2026-08-05 when delivery moved into
  Axl's chat (see below); the tape (F1) and the boundary reads (F2/F3) are still unseen

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
  the market is shut. Expect `orderState: 'awaiting_market'` and NO dialog; then at open, the
  market-open sweep (`monitoring/marketOpen.monitor.js`) should flip it to `awaiting_confirm` and
  post the card. Worth catching: this NEVER worked in the deployed build — the sweep rode inside
  the archived Minos, so deferred orders parked forever. It is its own loop now and kind-blind, so
  a portfolio item should ride it; unit-tested, not yet seen live.
- [ ] **Batch at the open** `[MKT]` — park 2+ orders off-hours (a portfolio activation is the easy
  case). Expect ONE `orders_ready` card at the open, not one per order, and the confirm dialog to
  walk them one at a time. Two kinds (idea + setup) should still produce two cards, one per desk.
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

---

## F. Axl market brief (2026-08-01)

BE + FE written; bundle rebuilt and shipped 2026-08-05. The units stub every provider and the model
turn, so what is unverified here is precisely the part tests cannot reach: whether the symbols price,
and whether the brief holds its boundary.

**Delivery changed 2026-08-05.** The confirm no longer posts the brief into the social chat — it
routes to Axl and streams it into his thread (`POST /api/axl/brief/stream`). The items below are
rewritten to match; anything phrased around a posted `market_brief` message is gone, not merely
re-worded.

### F1 — the tape actually prices `[ANY]`

- [ ] **Every tape symbol returns a quote** — the board is 18 symbols on Yahoo notation (`^GSPC`,
  `^NDX`, `^N225`, `^HSI`, `^TNX`, `GC=F`, `CL=F`, `BTC-USD`, `DX-Y.NYB`, `EURUSD=X`…). The quote
  path tries **FMP first and falls back to Yahoo**, and FMP prices none of the indices or futures —
  so this is really a test of the fallback. Log `_tape()` output and confirm no row is missing.
  A missing row is silent by design (a dropped line, never a guessed number), which is exactly why
  it must be eyeballed once.
- [ ] **The yield reads in points, not percent** — `^TNX` must render `4.28% (+0.06 pts)`. If it ever
  says `+1.40%` the formatter regressed and the brief is telling readers the bond market moved 1.4%.
- [ ] **Weekend / holiday behaviour** — run it on a closed day: stale closes are fine, but confirm
  nothing renders as `0` or `n/a` in a way that reads as a real level.

### F2 — the brief itself `[ANY]`

- [x] **A brief is actually written** — verified 2026-08-05: `getMarketBrief()` against the live
  providers wrote a 3332-char brief in 37s on a cold cache, and the card → Axl → chip → streamed text
  path was exercised end to end in the app. What is still unread is the CONTENT (the three items
  below): it was checked as a delivery, not as a piece of writing.
- [ ] **web_search is used and cited plausibly** — the "what's driving it" section must contain a
  real overnight story, not a paraphrase of the tape. If the model skips searching, the section will
  be generic — that's the failure mode to look for.
- [ ] **No invented numbers** — spot-check two or three levels in the prose against the data block.
  The prompt says use-as-given; confirm it does.
- [ ] **THE BOUNDARY** — this is the item that matters most. The brief must contain no "your", no
  position, no recommendation, no level to buy. Read a few briefs cold. If a single one says
  "traders should" or "this sets up", the prompt needs tightening before this ships.

### F3 — Axl relaying it `[ANY]`

- [ ] **Axl calls the tool** — ask "what's going on today" / "how are markets" / "what's the dollar
  doing" and confirm `get_market_brief` fires (tool chip) instead of Axl answering from memory.
- [ ] **Axl does not join it to the book** — ask "what's happening today, and how does that affect my
  positions?" in one breath. Axl must answer the world half from the brief and route the book half
  to a desk, never merge them. This is the whole reason the tool is unbound.
- [ ] **Axl still refuses single-name market data** — "what is NVDA doing" must route to a desk, not
  get answered from the brief.
- [ ] **Cold-cache latency when Axl relays it in chat** — the first brief of the hour is a live model
  turn with searches behind it (measured: ~37s). Asking Axl in his own chat shows the tool chip while
  it runs; the social-chat path (`triggerAxlReply`) still shows nothing until it finishes. Time that
  one. If the silence is bad, the fix is a placeholder message, not a shorter brief.

### F4 — the daily offer `[ANY]`

- [ ] **The card goes out once per user per weekday** — set `MARKET_BRIEF_OFFER_HOUR_UTC` to just
  before now, boot, and confirm exactly one card per user. Restart the server and confirm **no second
  card** (the dedupe reads posted cards, so this is the resume path).
- [ ] **No card at the weekend** — boot on a Saturday (or fake the clock) and confirm nothing posts.
- [ ] **The offer costs nothing** — confirm no model tokens are spent by the fan-out itself; the
  brief must only be written on a confirm.
- [x] **Confirm → Axl writes it** — verified 2026-08-05: press *Get the brief* and the card resolves
  to "✓ Got it", the social chat closes, the app routes to Axl, the ask appears as the user's own
  bubble under a pulsing "Writing today's brief…" chip, and the brief types in.
- [ ] **A failed confirm** — kill FMP/Anthropic mid-request. The card is consumed on the CLICK now
  (it routes; it no longer waits on a delivery), so the failure has to land legibly in Axl's thread
  and be recoverable by simply asking him — that is the trade this design makes, and it needs one
  real look.
- [ ] **Ten confirms, one brief** — have two users confirm at once on a cold cache and check the log:
  exactly ONE `brief built` line. The single-flight is unit-tested, but not against real latency.

---

# Talos in-position management + the trades ledger (2026-08-09)

Everything below shipped today with unit coverage and **has never run against a real filled
position**. That matters more here than usual for two reasons: `take_partial` produces a card that
places a real order at a broker, and the gate was written by two agents working in parallel — my
`position_state` seeding and their `positionGate` only meet at runtime, never in a test.

Commits: `ef1f6ba` · `b26e777` (in-position) · `f6bd284` (exit journal) · `97f70dd` (partial ledger).

### G1 — the gate sees what the fill wrote `[BLOCKED — needs a real fill]`

- [ ] **A fill seeds the stop and the ladder.** After a real entry, read `position_state`: `stop.initial`
  and `stop.current` both equal the WIDEST stop edge of the armed scenario, and `targets[]` is
  nearest-first with `hit_at: null`. Unseeded, `positionGate` reads undefined and simply never trips —
  the symptom is "the manager does nothing", which looks like an LLM problem and is not one.
- [ ] **A short seeds the opposite edges.** Same check on a short: stop from the band's HIGH side,
  targets descending. Three direction-dependent comparisons live in the gate and a sign error in any
  one turns a losing short into "target reached".
- [ ] **`breakeven` fires once and then stops.** Take a position to +1R with the stop still behind
  entry: expect one `breakeven` wake, then silence after the stop is moved. A gate that re-fires
  every wake is an LLM call per poll per position — the cost that scales with users.
- [ ] **A quiet position costs nothing.** Watch several wakes on a position sitting mid-range:
  `in_position_idle`, no journal line, no model call, metrics still moving.

### G2 — the partial actually reaches the ledger `[BLOCKED — needs a real fill]`

This is the one to do first. It is the whole path `97f70dd` exists for, and every partial taken
before it is verified is an unrecoverable row in a frozen ledger.

- [ ] **A `take_partial` card → confirm → order → slice recorded.** After the fill, the trade doc has
  an `exits[]` entry with the right qty and pnl, and `exit.realizedPnl` equals the RUNNING TOTAL, not
  the slice.
- [ ] **The eventual full close ADDS to the total rather than replacing it.** `captureClose` writes
  `exit` field-by-field precisely so it cannot wipe the accrued partial — a wholesale `$set` was the
  original bug and it would look identical until you scaled out twice.
- [ ] **`/api/trades/stats` reflects the total.** A scaled winner must not score as its final slice.
- [ ] **A duplicated `position.reduced` writes ONE slice.** The guard is `markExitOrderFilled`'s
  return plus the `orderId` clause; both are unit-tested and neither has met a real duplicate event.

### G3 — `exec.pnl` per adapter `[ANY — paper is runnable now]`

- [x] **Paper — VERIFIED 2026-08-09 by inspection.** `reducePosition` emits `position.reduced` with
  `quantity`, `price`, `pnl`, `commission` and `spread` — everything `capturePartial` needs. A
  partial keeps the position open and emits; a full reduction closes it instead. Nothing to fix.
- [x] **Manual — GAP FOUND AND FIXED 2026-08-09.** It was not a missing `pnl`: a manual trim emitted
  no execution event at all (`manualExecution` is deliberately no-emit) and its caller SKIPPED the
  ledger on purpose, with a comment naming the reason — captureClose was the only writer available
  and it would have finalised the trade, so a scaled-out manual position reached the ledger carrying
  only its final slice. `capturePartial` removed that constraint, so `manualIdea.confirmManualExit`
  now records the trim. Still worth a live pass to confirm the row lands.
- [ ] **Manual, live.** Trim a manual position through the confirm path and check `exits[]` gains a
  slice and `exit.realizedPnl` accrues. No `orderId` on this path — a manual trim is a user-confirmed
  one-shot rather than a broker event that can arrive twice, so it carries no duplicate guard.

### G4 — the exit journal line `[BLOCKED — needs a real close]`

- [ ] **A broker close writes one `exit` line**, with price, reason and realized P&L, and no
  `next_check_at` (there is no next check). It is written in `entityRepo.finalizeClose`, so verify it
  on a CALL too — the fix is kind-blind and Hermes gets it for free, which is untested.
- [ ] **The FE renders it as "closed out"**, and a pre-rename journal still renders "market closed"
  rather than the raw `closed` slug.
