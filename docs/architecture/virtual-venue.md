# The virtual venue — paper and manual

Two of the three workspaces run on one venue with no broker behind it. **Paper** simulates the
broker: it fills against the live feed and keeps a virtual account. **Manual** has a real broker the
app cannot reach: it keeps the same virtual account and lets the user report the fills. Everything
that *reads* a position — the monitors, the reconciler, the positions view, mark-to-market, the
ledger — is shared with live; only how a position gets INTO the store differs.

Written 2026-09-19, replacing the two build logs it descends from (`paper-trading-simulation.md`,
2026-06-30 → built 07-01; `manual-mode.md`, 2026-07-07 → built 07-08; multi-account 07-07; the
server-side workspace 08-14; `VirtualAdapter` 09-15). Their reasoning is carried here; their dated
phases are in git.

## The one decision: an adapter, not a parallel engine

Paper trading is a **broker adapter**. Everything funnels through
`brokerService(brokerType, userId, accountId)`, the reconciler is broker-authoritative, and ideas
already fork by broker — so a `paper` adapter that answers from a virtual store drives the monitor,
the order layer and the reconciler **unchanged**. The only fork in the whole system is which broker
is bound to the user. That is what keeps paper results predictive of live: identical evaluation,
identical reconciler, identical exit logic, one hook into the trades ledger.

```
monitors (unchanged)  →  conditions fire  →  order layer (unchanged)
                                                     │
                                   brokerService.placeOrder('paper' | 'manual', …)
                                                     │
   live price feed  ◄──── paper fill engine ────►  PaperAdapter      ManualAdapter: throws;
                          (watches resting orders)      │             the user is the venue
                                                        ▼
                                  executionBus.emit(position.opened / reduced / closed)
                                                        │
                                          execution.reconciler (unchanged)  →  the trades ledger
```

Manual reuses the same insight one layer deeper: **it reuses everything on the watching side and
swaps only the acting side.** "Place order at broker → reconcile off broker events" becomes "post a
card → the user confirms and types the real price." The lifecycle is driven entirely by two user
confirmations — the entry fill and the exit fill — not by a fill engine or a reconciler.

## The store — one, keyed by mode

`api/broker/paperBroker.service.js`, four collections, exported because the paper loops write the
same documents: `paperAccounts` · `paperPositions` · `paperOrders` · `paperEquity`.

**Accounts are N per user per mode**, user-named ("Scalping", "Swing", "My Chase account"), each with
its own balance, realized P&L, cost settings, equity curve and trade history. The key is a generated,
stable `accountId` = `<mode>-<userId>-<short>`; `name` is a mutable label. The `<mode>-` prefix is
load-bearing: the mode is derived from it (`accountMode`, `VIRTUAL_MODES` = `paper | manual`), the
account is the sub-dimension, and every position, order and equity point carries `accountId`, so
per-account and per-mode scoping are filters, never joins. A manual account is a paper account with
**zero-cost settings** — a real fill already carries its real costs.

**Cash moves only by realized P&L and commission.** Equity is `cashBalance + Σ unrealized` with no
notional bookkeeping; exposure is derived from cost basis (`committedByAccount`). Cash-only, no
margin model — the paper adapter alone has a leverage readout, advisory, off the account's settings.

## The adapters — one set of reads, two ways in

`adapters/virtual.adapter.js` is the shared READ half: account summary (via `computeEquity`), the
trading-account list, positions, the single-position lookup, symbol resolution (identity — the venue
trades the app's canonical symbols, no CFD aliasing), `isConnected` = owns ≥1 account of the mode.
One implementation scoped by `brokerType`, so paper and manual positions never leak into each other's
view. The subclasses keep only what differs:

| | `PaperAdapter` | `ManualAdapter` |
|---|---|---|
| market order | fills now through `paperExecution` | **throws** |
| limit / stop | rests in `paperOrders` for the fill engine | throws |
| close / amend | through `paperExecution` | throws |
| execution feed | emits onto `executionBus` | none — the base `false`; saying otherwise made the reconciler count a feed it could never hear |
| capabilities | a broker's | all false except **`selfExecuted: true`** |

`selfExecuted` is the flag every "post a card instead of placing an order" branch asks
(`venue.resolve.isSelfExecuted`). It used to be `broker === 'manual'` in eleven modules — the
venue's defining behaviour as a string literal scattered across the app, where a second broker-less
venue would have had to be added to all eleven and the one missed would have placed a real order.
The other flags say what is missing; this one says who does it instead. It never throws: a legacy
document naming no venue resolves to "the app executes here" and fails visibly at the broker call,
rather than taking down a monitor tick for every other entity in the batch.

A paper "rejection" is tagged as what it is — our own feed had nothing — because this venue has no
book, and a data outage must not be reported as a broker declining the trade.

## Paper — the simulation

**The fill engine** (`monitoring/paperFill.service.js`, every 3s) is the one thing a real broker
provides that the simulation must supply: a loop over every user's resting paper orders that fills a
touched level at the next sweep — the candle **high** for at/above tests, the **low** for at/below,
so a resting order fills on an intrabar touch, not only on a close. Fills book at the trigger price;
no slippage or gap model. Point-sampling means a spike that reverts inside the interval can be
missed — accepted for a forward simulation. On a fill it delegates to the shared primitives.

**The primitives** (`api/broker/paperExecution.service.js`): `openPosition`, `addToPaperPosition`
(scale-in), `reducePosition` (trim or close) — ONE code path, shared by the adapter's market fills
and the engine's triggered ones, that mutates the virtual position, applies the account's cost model,
banks P&L and emits the normalized execution event the reconciler consumes. **Spread is baked into
the fill price** (`applySpread`); **commission is a cash debit** on every fill. A partial keeps the
position open and emits `position.reduced` with `quantity`, `price`, `pnl`, `commission`, `spread` —
everything the ledger's partial slice needs; a full reduction closes and emits `position.closed`.

**Prices are a ladder**, and it is thinner than it looks: the FMP real-time `/quote` on a ~3s cache,
then an intraday candle, then the stored mark. On a plan without intraday candles the middle rung is
empty for equities, so `/quote` is the only real-time price this venue has — which is why a
transient error must never poison the suppression cache. A fill booked off a stale price reports its
`source`, so it never looks identical to one booked off the live quote.

**Mark-to-market** (`paperMark.service`, every 3s): the venue has no push feed, so P&L only moves
when something re-prices the open positions. One fetch per distinct symbol across every user's open
positions, stamped as `currentPrice` / `pnl` / `markedAt`. The mark loop is the **single writer** of
the mark, and `computeEquity` reads it rather than fetching — the client polls `getAccount`, and
fetching there cost ~40–55 of a ~130 req/min budget re-buying what the loop had written down.
Equity is at most one interval stale, the right trade for a readout and the wrong one for pricing an
order, so booking a fill still goes live.

**The equity curve** (`paperEquity.service`, every 5 min): one point per account that holds an open
position (`listActiveAccounts`). A flat account's equity is constant — the last realized point — so
it is not snapshotted and the frontend holds the value across the gap.

**The paper toggle rides the default (oldest) paper account.** Its `enabled` flag is
`connections.paper`, the key `resolveWorkspace` switches on. `GET /api/paper/state` and
`PUT /api/paper/mode` are its surface; everything else under `/api/paper/accounts/*` is per account
(create · rename + settings · delete, 409 if it holds a position · reset · cash — a dividend, deposit
or fee · equity-curve · trades). The per-idea account picker chooses WHICH paper account an idea
binds to; the toggle says whether the user is standing in the paper workspace at all.

## Manual — the user is the venue

**Two confirmations drive the lifecycle**, and both arrive as one unified `FillCard` in social chat
(`manualNotify.service` → `postCard` → `postBotCard`, the same transport as every other card — not a
router): N legs (one for an idea, N for a book), inline price and editable quantity on entry, each
leg opening or closing the moment its price is submitted, the card persisting until every leg is done.

1. **Entry.** `entry.monitor` sees the condition fire; for a self-executed venue it builds no order
   plan and shows no confirm dialog — `orderState: 'awaiting_manual_fill'`, `status: 'hit'`, and a
   `manual_entry` card. Activating a manual book posts the N-leg card at once (a market basket the
   user executes now). Submit → `manualExecution.openManualPosition` at the **reported** price and
   size, no cost model, no `executionBus` emit — `confirmManualEntry` flips the idea `long`/`short`
   directly. `openedAt` may be in the past: an adopted lot is often years old, and holding period
   and the ledger both measure from it ([design/adopted-book.md](../design/adopted-book.md)).
2. **Exit.** A stop or target condition fires; the app posts a `manual_exit` card and parks the leg
   `awaiting_manual_close` so it does not re-alert every poll. Submit → `closeManualPosition` at the
   reported price → `closed`. A book's exit is **user-initiated**: the user says they are out, the same
   card comes back with one row per open leg, and partial baskets are allowed — the rest stay open
   and the card waits.

From there the position marks, shows and reviews like any other: the mark loop sweeps every store
position regardless of mode, Themis reviews the book on its cadence, and a manual trim reaches the
ledger through `capturePartial` (it used to skip the ledger on purpose, because `captureClose` was the
only writer and would have finalised the trade).

**Manual is never hours-gated.** It places no orders; a Fill card is an instruction, not an
execution, so market hours have nothing to gate ([off-hours-queue.md](./off-hours-queue.md)). A
Talos manage verb on a manual position answers `selfExecuted` from the shared executor
(`positionManage.applyManage`) and the desk posts its card with the raw proposal in its own words.

**The numbers are the user's word.** A manual book may have been adopted whole from a bank, and the
app has no way to check a quantity or a fill. The venue block says so to every desk, and a review of
such a book opens by re-confirming it (`_buildUnreadableVenueSection`, keyed on the venue).

## The workspace — what the server knows

`api/workspace/workspace.model.js`. Manual used to be a **client-only** workspace: paper has a
server-readable flag, manual had none, so the choice lived in localStorage and every server-side read
saw a manual user as live. Survivable while it only scoped a UI list; not once every desk was handed
the current workspace each turn — a desk that believes manual is live describes orders the app
cannot place, and "what am I risking" is answered about a broker account the user is not trading
through. So the choice is persisted (`user_workspace`, one row per user — a current state, not a
history; `GET`/`PUT /api/workspace`), and **`resolveWorkspace(paperConnected, stored)` is the whole
rule**: the paper flag wins over anything stored, because it is a real server-side toggle the profile
screen flips on its own; the stored value decides only between the two flag-less cases, manual vs
live. Mirrored verbatim in the frontend's `useWorkspaceMode` — the two must agree or the user sees one
workspace while the desks discuss another. What is scoped by it and what is shared is APP_SPEC §8.

## What the ledger keeps

`services/tradeCapture.service.js` writes both paper and live trades through the one reconciler hook,
and manual through the confirm paths; each row is a point-in-time snapshot of the idea AS AUTHORED at
fill — never a reference to the mutable document — differentiated by `mode` and, for an adopted
holding, `origin.adopted`. The equity-curve series is `paperEquity`;
[trades-data.md](./trades-data.md) is the ledger's own doc.

## Not built, and said so

- **Historical backtest** — replaying archived prices needs a data store and an explicit
  intrabar-fill and cost model. Out of scope from the first design; the ledger is written so a future
  one inherits no lookahead bias.
- **Slippage and gaps** — fills book at the trigger price.
- **Buying-power enforcement and per-asset-class contract sizing** — deferred with the cash-only
  margin model.
- **Partial manual exits from a monitor** — a manual exit card closes a leg in full; a trim reaches
  the store only through the review path.
- **Live verification** — the paper path end to end (toggle → idea → fill → close → ledger) and the
  manual confirm path have unit coverage and were never walked on a running stack
  ([live-verify-checklist.md](../live-verify-checklist.md)).
