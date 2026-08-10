# The adopted book — a portfolio that wasn't built here

**Status: DESIGN, nothing built.** Design settled 2026-08-10. Covers a user who arrives with a
real portfolio already running somewhere we can't wire to (a bank brokerage), and wants Atlas to
take it over from today: monitor it, review it, notify, propose.

Relates to: [pipeline-service.md](./pipeline-service.md), `docs/architecture/manual-mode.md`,
`docs/architecture/paper-trading-simulation.md`.

---

## The one line

**Generate derives holdings from intent. Adoption derives intent from holdings.**

Same two objects, opposite direction. That is why the pipeline, the artifacts and the book-commit
writer are all reusable — and why it is *not* the same act (see §2).

Adopting a book = manufacturing the state Atlas would have produced **after** construction and
**after** the fills, and skipping both. Nothing downstream learns a new concept: Themis, Atlas
review, coverage, Pythia's tilt audience and the manual rebalance cards all read `portfolioId` on
the entity rows plus one lifecycle doc, and they are kind-blind.

---

## 1. It is the existing portfolio pipeline, entered one step in

The portfolio pipeline is already declarative: `Mandate → Screen → Research → Allocate → Themis`,
artifacts keyed by kind, phases 0–4 done (not live-verified) including `planEntry`/`startAt`.

| Step | Book built here | Book from the bank |
|---|---|---|
| Mandate (Atlas) | objective, risk, horizon, benchmark | **same, plus the holdings arrive here** |
| Screen (Argus) | finds candidates | **skipped by default; an OFFER when the book is under its cap** (§3.1) |
| Research (Prometheus) | `candidate_list` → coverage | identical; names are names |
| Allocate (Atlas) | awaits `coverage_set` → weights + conviction | identical, ending in keep-or-change |
| Themis | rings | identical |

So adoption is **`startAt(portfolio, 'Research', candidate_list)`** — always, because a book under its
cap is a legal book and needs no sourcing. Room under the cap is an **offer, not a trigger**: if the
user takes it, that is the ordinary **`startAt(portfolio, 'Screen', mandate)`**, and the sourced
candidates arrive at Research alongside the held ones. Either way: no new arrow, no new desk, and the
artifact vocabulary stays closed — `mandate → scanner` is already the declared Atlas→Argus hop. A holding is a candidate you already own: the item carries
`quantity` + `avgCost` + `openedAt`, riding on the item the way Argus's per-candidate read already
does.

**The artifact hops by `ref`, never inline.** Research on every named ticker outlives its session;
an inline artifact does not survive a reload. Which forces the ordering in §3: the book is
persisted as entities at the END of Mandate, before research starts.

---

## 2. Where adoption differs from generate

Identical terminal state — one `portfolioId` over N legs, target weights, conviction, thesis,
mandate, cadence, fingerprint. Everything below is what makes it a different *act*:

- **Generate ends in a proposal; adoption ends in a fact.** A generated book is born unowned (legs
  `waiting`, deletable, gated by the pre-activation review and `ActivatePortfolioDialog`). An
  adopted leg is born `long`, with `ordersPlacedAt`/`activatedAt` in the **past**, its position
  already in the store, delete-locked immediately.
  **The activation step is structurally absent, not optional.** Run adoption through the generate
  path and the app's next move is to offer to *activate* the book — asking the user to buy what they
  already own. (`activateManualPortfolio`'s `ACTIVATABLE` set is `waiting|looking|hit`, so the
  backend would refuse a `long` leg; the offer sitting there is the bug.)
- **Allocation is mandatory to RUN, optional to ACT.** In generate, allocation *is* the act. Here
  the weights are already a fact, so Allocate produces the thing that doesn't exist yet: **target**
  weights, conviction, and the fingerprint. It may absolutely end in "leave it as it is" — but that
  outcome is authored and recorded, never skipped (§6).
- **Truth flows the other way.** Generate: the app proposes, the user disposes. Adoption: the user
  asserts facts we cannot verify — hence the confirm grid (§3) and the re-confirm ritual (§8).
- **The cost basis is historical**, so the ledger must mark these opens as not-ours (§4).
- **A weak coverage read means the opposite.** In generate it drops a name before you own it; in
  adoption it is an **exit proposal**. The first review can legitimately open with "sell this".

**Build consequence:** ONE book-commit service (the pipe), taking the terminal state as a parameter
— born-proposed or born-live. And Atlas's `adopt` mode must **skip phases, not soften them** — the
same lesson as the scan fix, where a named ticker had to skip the angle question *and the phase that
asks it*.

---

## 3. Intake — the Mandate step, extended

Axl's reception offers the door ("I already have a portfolio at my bank") and hands Atlas `<open>` —
the user's own sentence. Atlas gains a fourth mode beside construct / review / pre-activation:
**`adopt`**. Mandate is where the user ENTERS, which is exactly where this belongs.

| Phase | Asked | Lands as |
|---|---|---|
| A1 | the holdings: **ticker · quantity · avg cost** (+ open date if known) | one manual position each |
| A2 | what the bank says the account is worth | the account arithmetic below |
| A3 | mandate: objective, risk, horizon, **cadence**, benchmark, **how many names** (§3.1) | `setMandate` + lifecycle |
| A4 | per name: why held, what would make you sell | the leg's `thesis` |
| A5 | the confirm grid — every line, editable, with weights + market value | commit |

**Quantity is mandatory.** Ticker + entry price cannot produce an allocation: no qty ⇒ no weights ⇒
no targets, no drift, no money P&L, no rebalance sizing, and weights are Atlas's entire job. If the
user genuinely doesn't know share counts, take *% of book* and derive qty — but the third number is
not optional.

**The account arithmetic (the double-count trap).** `equity = cashBalance + unrealized` and cash is
never debited when a position opens, so:

```
freeCash        = statedTotal − Σ(quantity × mark)
startingBalance = Σ(quantity × avgCost) + freeCash
```

Then equity = market value, `deployable()` = exactly the free cash, and exposure = the cost basis,
with no new math. Setting the balance to the book's *market* value instead double-counts every
unrealized gain. A negative free cash means the numbers don't reconcile → Atlas asks rather than
guesses. This is why account size belongs **here**, with the positions, not at signup: signup
creates a manual account with a name and a currency, nothing more.

**Anchoring rule.** Elicit objective, risk, horizon and benchmark BEFORE commenting on composition,
and never justify a mandate with what is held. Otherwise the mandate becomes a *description* of the
book instead of a yardstick — the costume failure in a new place.

**The beginner path is the main path.** "I have a book and I don't know my risk tolerance" is the
most likely arrival and exactly who owns a bank portfolio. Atlas must be able to *propose* a mandate
from the book plus two or three questions and have the user accept it; A4 likewise proposes a reason
per name from coverage and asks for confirmation, rather than interrogating twenty lines.

### 3.1 How many names — a mandate field, not a UI constant

**The user states a MAXIMUM number of names** — "no more than 15" — and it is a first-class mandate
field (`max_names`), sitting beside `riskTolerance` / `horizon` / `benchmark`, rendered by
`_buildMandateSection` so it is never re-asked, persisted by `setMandate`.

**A ceiling, not a target, and deliberately so** (decided 2026-08-10). A minimum would force the
worst behaviour a book can have: filling slots with names nobody can defend in order to be "fully
allocated". There is no such thing as too few names — holding four against a max of fifteen is a
legal, unremarkable state that needs no comment. **Concentration is policed by the max position
weight, not by a count**: the two constraints divide the work, the count capping sprawl and the
weight capping concentration.

It is also the better *question*. "How many names at most" is answerable by someone with no plan;
"how many do you want" presumes one.

**It binds what Atlas may PROPOSE, never what the app may RECORD.** A user arriving with 22 names
against a max of 12 is a legal state — you cannot refuse reality — it is simply *over the cap*, which
is what keeps the `count` gate lit and makes the exit list the first thing Allocate produces (§6).
Enforcing the cap on recorded state would make adoption impossible for any book above it.

**A breach is recorded with its reason**, same rule as the no-change, or the cap degrades into a
suggestion and the field becomes a costume. **Only the user moves the cap**, via an explicit mandate
edit; Atlas may *ask* ("you're at 18 and defending all of them — raise the cap?"), but rewriting
`max_names` to match what it built would turn the yardstick into a description of the book — the same
anchoring failure as the mandate itself.

It has to be its own field. Today the count lives in two places, neither of them a policy:
`RESEARCH_TOP_N = 4`, a hardcoded constant in `ScannerPanel.jsx` (used in three places, including
the per-sleeve slice in `MainPage`), and whatever Atlas happens to say in prose. Said in
conversation, "I want 15 names" lands in the free-text `constraints` and is read by nothing
deterministic — the same failure the analyst's `horizon` had: documented, validated, and unread.

**One integer; null when unstated.** Unstated normalizes to **null**, never to a default: null means
Atlas asks or proposes, and specifically does not mean 4.

**It replaces the constant.** Research width derives from the mandate: at most `max_names` slots,
distributed across sleeves, times a screen-width multiplier — you research more than you keep,
because coverage kills some, but never more than you could hold. One hardcoded 4 becomes one
derivation.

**Coherence check at mandate time, not at allocation time** — the discipline `setups.service` already
applies ("coherence, not absence"): refuse when the mandate's own fields contradict each other, not
when one is missing.
- `max_names × max_position_weight < 1` → even filled to the cap the book cannot be fully invested.
  That may be deliberate cash, but it must be *said*, not silently produced.
- `max_names` below the sleeve count → some sleeve is guaranteed nothing.
- `account size ÷ max_names` below a sane ticket → filled to the cap, this book holds odd lots and,
  at a bank, carries commission drag that eats the thesis before it starts. (This is the check that
  answers "I want 40 names" on a small account: the *mandate* is refused as incoherent, not the book.)

**Beginner framing.** Atlas may propose the cap from account size + experience level and let the user
accept it — the same pattern as the proposed mandate.

**Surface.** Atlas asks in chat; the FE offers a paste/table affordance in the same turn, and the
same grid serves as A5's confirm. Parsing is deterministic — a shared parse service returning
`{rows, problems}`. The model converses; it does not parse numbers. Post-commit, the grid is also
the edit path (corrected quantities, a line already sold).

---

## 4. The write

Draft first — the A5 payload IS the persisted draft — then one idempotent commit keyed
`draftId+symbol`, so a half-written book is retried rather than reconciled by hand.

**Account.** `createAccount(userId, { mode:'manual', name, currency, startingBalance })` per §3.
Manual accounts already default to zero-cost settings; a real fill carries real costs.

**Per holding.**
- `openManualPosition(…, openedAt)` — the one change to existing code: `openedAt` is hardcoded to
  `Date.now()` (`manualExecution.service.js:38`). An adopted lot has a real open date, and holding
  period plus the ledger both depend on it. Seed `currentPrice = avgPrice` so equity isn't blind for
  one mark tick.
- one `idea`-kind entity: `portfolioId`, `portfolioName`, `broker:'manual'`, `mainAccountId`,
  `status:'long'`, `ordersPlacedAt`/`activatedAt` = the real open date,
  `brokerOrders:[{ broker:'manual', positionId, quantity }]`, `entryPrice` = avg cost, the A4
  thesis, `origin:'adopted'`, `adoptedAt`. **No entry tree** — nothing to trigger. Stop/TP trees stay
  null unless the user actually runs levels; Atlas proposes them at Allocate.

**Per book.** `setMandate` · `setPortfolioLifecycle({ reviewCadence, nextReviewAt, benchmark })` ·
`setThesis(reason:'adoption')` · **`captureFingerprint(reason:'adoption')`**. The fingerprint is not
optional: it is the "then" baseline `computeReviewSignals` diffs against, and without it half the
trigger panel is dead on arrival.

**Ledger.** `tradeCapture.captureOpen` per leg at the historical date, **marked `origin:'adopted'`**.
Without that marker the `trades` collection starts crediting the app for entries it never made,
which poisons the one dataset we are trying to build.

---

## 5. Research — every named ticker

`services/coverageRefresh.service.js` already runs Prometheus **headless** for one name, persists
the result (initiating a new thesis or appending a revision to an existing one), and pings the user
to resume — route-and-return, bounded. Adoption needs that N times.

**The fan-out is server-side, not a conveyor `each`.** Three reasons: the run outlives the session
(a React ref dies on reload); "done" is derivable from persisted state (every symbol in the book has
a coverage doc — `saved ⟺ empty inbox`), so nothing needs accumulating in a browser; and the pacing
plus cost discipline already exist in the coverage monitor. The generic client-side `each` stays
deferred, and the sleeve loop stays where it is.

To build: an **adoption research batch** (N symbols, paced, its own per-tick cap, skips names already
covered, restartable from persisted state), a **progress surface** so an hour of quiet doesn't read
as a hang, and a **completion ping** → card → `startAt(portfolio, 'Allocate', coverage_set)`, reusing
the resume ping that exists.

The mandate's horizon flows into the coverage brief — ONE horizon plus bull/base/bear, never a
3M/6M/12M grid.

Coverage is **the forecast**, and it is the house's own view: no user input needed to produce it. It
is also what puts the book into Pythia's derived tilt audience.

*The long-running-process handling (queueing, resumption, user-facing pacing) is designed separately
and is not specified here.*

**Names nobody can cover** — bank mutual funds, local lines, bonds. Prometheus returns empty, which
the pipeline already models properly (an empty result is a RESULT and carries forward with a note).
Atlas must then say it out loud at Allocate: *"I can't form a view on these three — they stay
unmanaged."* Silent exclusion is the failure mode.

---

## 6. Allocate — the adoption review

Not a normal review. Its job is to build the spine a constructed book gets for free:

1. **the count gap** — the first and bluntest comparison:
   - **over the cap** (22 held, max 12) → keep-or-change becomes a concrete exit list: *here are the
     ten I would drop, and why*, ranked by what coverage just produced (PT vs what you paid,
     conviction, sleeve overlap). This is what makes the adoption review immediately worth having.
   - **under the cap** (4 held, max 12) → room, not a deficiency. Atlas may *offer* to source the
     difference; saying nothing is equally correct.
2. **target weights** — the mandate's intent, and the actual-vs-target gap. This gap is the payoff
   of the whole feature: *here is what your bank book actually is, against what you just told me you
   want.*
3. **conviction per holding** — where `computePortfolioState` reads it (`idea.conviction`).
4. **thesis per holding** — the A4 line, confirmed or rewritten against coverage.
5. **stop discipline**, if the user runs any.
6. **keep or change** → proposals as actions (the manual rebalance cards already exist and work),
   or a recorded **no-change with its reason**. An unrecorded no-change is indistinguishable from
   nobody looking — the same principle as Talos's `let_run`.
7. **`captureFingerprint(reason:'review')`** — re-baseline with conviction, weights and tilt, or
   `conviction fell` (the highest-signal gate) never fires again for want of a "previous".

---

## 7. What monitoring turns on, and when

Seven of ten Themis gates fire on day one (`services/portfolioReview.util.js:69`) — six from pure
data, plus the cap the user stated at intake. Only the two that need Atlas's own numbers must wait:

| Gate | Needs | Live |
|---|---|---|
| `drawdown` — book down 8pt since last look | fingerprint + marks | day 0 |
| `earnings` within 7d | forward calendar in state | day 0 |
| `benchmark` lag | benchmark from the mandate | day 0 |
| `regime` — inversion flip | fingerprint + FRED | day 0 |
| `sector_view` — house tilt moved | fingerprint's tilt snapshot + Pythia | day 0 |
| `coverage` — PT ≤ **what we paid** | coverage row + `entryPrice` | when coverage lands |
| `coverage` — PT cut vs basis | a frozen basis PT | from adoption onward |
| `conviction` fell | Atlas's conviction + a previous | **after Allocate** |
| `drift` from target | target weights | **after Allocate** |
| `count` over the cap — NEW (§3.1) | `max_names` + live leg count | day 0 |

The strongest coverage gate works immediately, because avg cost *is* `entryPrice`: *our own analyst's
target on your bank holding is at or below what you paid.*

Free, with no new work: the 3s `paperMark` sweep marks every adopted position (mode-blind) → live
P&L, equity curve, the Floor's Manual workspace. Themis puts the book in rotation as soon as
`liveCount ≥ 1` and a lifecycle doc exists. Coverage keeps its own theses living on a research
cadence. `portfolioRebalance` already posts manual trim/add cards, so acting on a review works end
to end — the basket path is the part of manual mode that is complete.

**`spine_state` on the lifecycle doc: `adopted` → `covered` → `under_mandate`.** It is the honest
status ("we watch your prices" vs "we manage against a mandate"), it drives the nag if the user never
completes Allocate, and it gives Themis a far better first interaction than waiting out a cadence:
*coverage is ready* beats *a week passed*.

---

## 8. Drift — a ritual, not a reconciler

We cannot read the bank. The user will trade, take dividends and receive splits outside the app, so
divergence is guaranteed and the only source of truth is the user.

- Every review card for an adopted book opens with "is this still your book?" — one tap for
  *unchanged*, otherwise the edit grid.
- A monthly **confirm-holdings** card: the same N-leg card mechanism, quantities pre-filled, used as
  verification.
- Dividends and deposits = a cash adjustment on the account; splits = edit quantity + avg. No
  corporate-actions engine.
- The copy never claims parity with the bank: the app shows the book **as you last confirmed it**.

---

## 9. Traps

1. **Cost basis vs market value** in `startingBalance` — the double-count (§3).
2. **Adopted ≠ ours** in the `trades` ledger — attribution poisoning (§4).
3. **`basisPt` is frozen at adoption, not at entry.** "PT cut since basis" honestly means "since we
   met this position". Label it, or a review claims research was cut against work nobody did.
4. **Unpriceable holdings** must be first-class *tracked, not marked* — excluded from the equity
   roll-up and flagged, never silently worth zero. FMP `/stable/quote` covers equities and ETFs;
   marks only need `/quote` (intraday candles are off-plan).
5. **One account = one currency.** A mixed USD/ILS book gets two manual accounts in v1. No faked FX.
6. **Manual is a venue, not the intake.** *Where the book lives* (bank vs a connectable broker) is
   orthogonal to *how positions got in* (typed vs read from an API). A cTrader user with an existing
   book should adopt too, without typing. Manual is the right v1 target — it is the venue whose
   basket path is fully built — but don't weld the two axes together.
7. **Atlas consuming Pythia's tilt in review is still unbuilt**, and an adopted book is where it
   matters most: the book was assembled with no house view at all. That dependency is in this
   feature's scope, not the tilt desk's.
8. Long-only v1; `direction` already carries shorts if a book has them.
9. **A count is not a diversification measure**, which is exactly why the cap has no minimum. "Names"
   ≠ positions (one name across two accounts is one name), and an ETF is itself a diversification
   instrument — twelve names where one is VTI is a completely different book from twelve single
   stocks. The **max position weight** is what polices concentration; the cap only stops sprawl. Never
   let the count stand in for diversification.
10. **`max_names` must not live in `constraints`.** Free text is invisible to the research-width
    derivation, the coherence checks and the `count` gate — it would read as designed and behave as
    absent.

---

## 10. Build order

1. **Intake + write** — `openedAt` on `openManualPosition`; the book-commit service with its
   born-live terminal state; draft/commit; routes; tests on the arithmetic and the idempotency.
2. **`max_names` as a mandate field** — schema + normalization (integer or null) + the coherence
   checks, `_buildMandateSection`, and `RESEARCH_TOP_N` derived from it instead of hardcoded. **This
   one is not adoption-specific** — it changes the generate path too.
3. **Atlas `adopt` mode** — phase order (holdings → mandate → why → confirm), the anchoring rule, the
   deterministic paste parser, symbol resolution, the proposed-mandate path for beginners.
4. **FE** — the reception door, the paste/confirm/edit grid, an ADOPTED badge, no activation affordance.
5. **Research batch** — paced headless coverage over every named ticker, progress, completion ping →
   `startAt(portfolio, 'Allocate')`. (Long-run handling per its own design.)
6. **Allocate as the adoption review** — the count gap, targets, conviction, thesis confirm,
   keep-or-change recorded, re-fingerprint. Then live-verify the whole path: `spine_state` walks
   `adopted → covered → under_mandate` and Themis rings.
7. **Drift ritual** — the confirm-holdings card and the cash adjustment.
8. **The `count` Themis gate** — cheap and deterministic, once targets exist.

## 11. Defaults taken (override freely)

- Intake surface: chat + paste grid + editable confirm. **Statement upload (PDF/screenshot → parse)
  deferred** — a feature of its own.
- Kind: **reuse `idea`** with `origin:'adopted'`. It is the same "a fill, not a thesis" shape ruled
  for the deferred immediate-ticket kind; if that lands, adopted holdings migrate onto it.
- Asset scope: **equities and ETFs priced; everything else tracked-unpriced** rather than holding the
  feature for a funds/bonds feed.
- Research depth: **every named ticker** (decided 2026-08-10), paced rather than truncated.
- `max_names`: **a user-stated ceiling, no minimum** (decided 2026-08-10). Hard on what Atlas
  *proposes*, never on what the app *records*, moved only by the user, breaches recorded with a
  reason. Unstated → null, never a default.
