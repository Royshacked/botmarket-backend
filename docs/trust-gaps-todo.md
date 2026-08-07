# Trust gaps — TODO

The backend's architecture is sound; what's missing is the ability to **trust it under failure**
and to **reconstruct why it acted**. Both gaps sit on the money path. Everything below is one of
those two, ordered by urgency.

Ordering rationale, in one line each:
- **Capture is urgent** — every day it's missing, that day's data is gone. Frozen + append-only
  means the misses are unrecoverable.
- **The harness is the highest value per hour** — but it loses nothing by waiting a week.
- **Live verification is last** — it only covers what a fake venue genuinely cannot show.

---

## 1. Capture the chain: thesis → execution → management → result

The system records each hop's VERDICT but not the EVIDENCE behind it, and the hops aren't joined.
Census (2026-08-06): `thesis` on **0/67** trades, **51/67 idealess**, journal on 3 calls.

- [ ] **Join the chain first.** Every execution must carry its authoring entity id (`callId` /
      `setupId` / `ideaId` / `portfolioId`) end to end. 51/67 trades having no idea attached makes
      every downstream question unanswerable regardless of what else is captured.
- [ ] **Freeze the thesis at fill.** `tradeCapture.captureOpen` already freezes price/qty — add the
      authoring rationale, the entry premise, and the invalidation criteria as they stood at entry.
      Not a pointer: coverage/setup prose gets rewritten, so a reference resolves to the wrong text.
- [ ] **Capture the DECISION INPUTS, not just the verdict.** Hermes/Talos write `verdict` + `note`;
      persist the snapshot they judged from (price, the axes, the fetched facts, the model + effort).
      This is the difference between a journal and a dataset.
- [ ] **Record management events as first-class rows** — stop moves, partials, re-entries, expiries.
      Today the outcome absorbs them and the intermediate decisions vanish.
- [ ] **Close the known ledger gap:** a scaled-out trade records only the FINAL close's
      `realizedPnl`, so partials undercount (noted in `execution.reconciler`). Any P&L or R-multiple
      analytics built on this is wrong for scaled exits.
- [ ] **Decide retention shape before writing volume.** Frozen + append-only is right for the
      record; make sure the snapshot lands somewhere queryable rather than as opaque blobs.

## 2. Make the money path testable WITHOUT a broker

1987 tests, all pure and offline. Order placement, amendment and reconciliation are covered only by
`tests/test.*.js` — manual harnesses excluded from `npm test`. The `_leafBareLevel` defect (a stop
resting at level **0**) lived here and was found by accident, via an unrelated import change.

- [ ] **Fake venue** implementing `BrokerAdapter` — deterministic, scriptable fills, emitting onto
      `executionBus` like a real adapter. The `paper` adapter is close but simulates a market; this
      one simulates a BROKER, including its failure modes.
- [ ] **Scenario harness** over the reconciler. Minimum set:
      - [ ] partial fill → reduce → close
      - [ ] untracked panel exit (an order placed outside `exitOrders`)
      - [ ] transport failure mid-window (`findOpenPosition` throws → must DEFER, never false-close)
      - [ ] duplicate/replayed execution event (idempotency)
      - [ ] restart mid-flight → `_resumeFeeds` re-derives rather than double-acts
- [ ] **Promote to `npm test`** once green, so the money path is covered by CI like everything else.
- [ ] **Schema validation at the write boundary.** `normalizeCall` / `normalizeCoverage` /
      `setup.schema` do schema work in application code — which is how `horizon` came to be
      "documented-validated, actually free text, unread by anything."

## 3. Live verification — only what a fake venue cannot show

Existing checklist: `docs/live-verify-checklist.md` (pending for Themis, the order layer, Prometheus).

- [ ] **The reconciler decision window.** `execution.reconciler._locks` is process-local and guards
      more than a write — read idea → ask broker → place/cancel/re-size. Lifting it needs a Mongo
      lease sized against REAL broker latency; a lease that expires mid-window re-admits the race,
      one that fails to release wedges every future exit for that position.
      See `docs/architecture/single-instance.md`.
- [ ] **cTrader amend-by-cancel-then-place** — amendment returns a NEW order id; verify the client
      re-tracks and no orphan is left resting.
- [ ] **Multi-account fan-out** — one idea across several accounts of one broker.
- [ ] **Broker-vs-app reconciliation sweep** (long-standing: `project_broker_reality_reconciliation`)
      — broker is truth, heal entities stuck in `long` / `in_position`.

---

## Explicitly NOT on this list

- Rewrites. The core choices are right for this domain: broker-authoritative reconciliation, the
  cheap-gate→expensive-LLM cascade, deterministic engines beside the model, capability-flag broker
  abstraction, kind-blind entities. Express + Mongo + poll loops is correct at this scale, not a
  compromise to be migrated off.
- Multi-instance. Single-process is a fine deployment for this app; the risk was that the
  constraint was undocumented, and it now isn't.
