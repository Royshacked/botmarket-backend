# Prometheus + the coverage monitor — the `coverage` artifact

The house's research: **Prometheus** forms a differentiated view on a name and writes it down as a
`coverage` document; **the coverage monitor** keeps that document alive against the world, daily, and
decides when the view is worth re-modelling. Written 2026-09-19 from the code and its comments; the
contract has been stable since the monitor shipped (P5, 2026-07-22) with two later corrections that
are called out where they land.

The one line: **the edge is the GAP — our number against the Street's — and a thesis is monitored by
watching that gap move, never by watching price.**

## What coverage IS, and is not

`coverage` is one document per symbol in its own collection (`api/analyst/coverage.service.js`):
identity + the variant-perception `thesis` + `rating` + OUR `price_target` (value, horizon, basis) +
`estimates` (ours vs consensus) + the `gap` (our PT against the Street's whole distribution) +
dated `catalysts` + checkable `kill_criteria` + a bear/base/bull `risk_reward` band + `conviction` +
`schools` tags + `status` + an append-only `revisions[]` trail. The trail is what makes it *living*:
every material change is a prepended revision, so a reader can see how the view got here.

Three things it deliberately is not:

- **Not an execution-tier entity.** It does not live in `entities`, no execution monitor watches it,
  and nothing about it places an order. It is research — a claim about what a name is worth — and it
  is watched by its own monitor. A trade taken on the back of it is Mentor's or Atlas's, and the trade
  carries a frozen pointer back (`research_basis`, below), never a live link.
- **Not per-user.** Coverage is HOUSE-OWNED: no `userId`, one thesis per symbol, authored through the
  admin pipeline and read by every desk. It mirrors the tilt's ownership model — one active view per
  name, superseded on revision, owner-blind — and shares the tilt's write pipe
  (`services/houseArtifact.repo.js`). Traders read it; only an admin writes it
  ([roles-and-sourcing.md](roles-and-sourcing.md)).
- **Not Mentor's "coverage".** Mentor's chat state has a field of the same name — the dimensions the
  trade conversation has read so far (`mergeCoverage`). Same word, unrelated thing.

`status` ∈ `active · thesis_broken · target_hit · retired · watchlist`. Only `retired` stops the
monitor: a thesis keeps living, including one that hit its target, until the user churns it out of the
book. `thesis_broken` stays in the vocabulary for the LLM tier and for the user; nothing deterministic
can reach it any more (see *Never price*).

## Prometheus — how a view is formed

`prompts/analyst_system_prompt.md`. A buy-side analyst, not a PM: forms a view, computes a target,
pitches a rating, does **not** allocate. Six phases, each announced with `<phase>N</phase>` so the
desk UI can follow:

1. **Profile** — what the business is (`get_fundamentals`, `get_sec_filings`).
2. **The Street** — `get_consensus`: forward estimates, the consensus PT, the rating distribution and
   the revision trend. This is the anchor; there is no variant view without knowing the consensus view.
3. **The variant perception** — where we differ and why. An edge lives in exactly two places: a
   different **estimate** or a different **multiple**. The prompt makes the model name which.
4. **Valuation** — `compute_valuation` (`services/valuation.engine.js`), deterministic:
   `price = multiple × forward metric` (or EV-based per sector), plus the band and the gap. The model
   supplies the *judgment* (which multiple, whose estimate); the tool does the arithmetic. Two rules the
   prompt enforces hard: pass **scenarios** so the bear leg moves both inputs (in a downturn the
   multiple and the earnings fall together — a ±15% re-rate on unchanged earnings is a sensitivity,
   not a downside case, and the doc says which it is via `band_basis`); and check every leg against
   the name's **own multiple history** — a multiple inside its historical range has a precedent, one
   outside it is a claim that must be argued in the thesis.
5. **The call** — is the gap material and defensible? Inside the Street's own low–high range is not a
   variant view. Thin → **PASS**, and emit nothing: "no edge" is a research outcome, and coverage is
   scarce on purpose. Two questions are kept apart because the model conflates them: **the rating is
   vs the PRICE; the gap is vs the STREET.** Being below consensus is a view on the consensus, not on
   the stock.
6. **Coverage** — emit the `<coverage>` block. Nothing is initiated until it appears.

The block is captured from the *finished* text (`_parseAnalystResponse`), returned as a DRAFT for the
admin to read, and only persisted when they press Initiate — `initiateCoverage` normalises it then.
Same shape as every artifact desk: the agent drafts, the service normalises at commit.

**Quick read is a mode, not a desk.** When Aether names a company as exposed to an event, Prometheus
is asked one narrow question — is that exposure credible, already priced, or contradicted by the
company's own record — and answers with a `<quickread>` verdict, no target, no thesis
(`prompts/analyst_mode_quickread.md`, injected as its own cached block so the coverage prefix stays
byte-identical). The mode's key insight is written into it: a company does not file about a week-old
event before its next 10-Q, so "nothing filed since" is not evidence; what counts is whether the
dependency was ever put on paper.

## The gates — what the write refuses, and what it merely flags

`coverage.service.js` holds two kinds of check, and the distinction is the point:

- **Coherence REJECTS.** `ratingCoherence`: a bullish rating needs upside, so a `buy` whose target sits
  at or below the price is refused with the reason written for the model to read ("a gap vs the Street
  is not a rating"). Re-checked on any update that touches `rating` or `price_target`. The document is
  never allowed to contradict itself on the one axis a reader acts on.
- **Plausibility FLAGS, and stores anyway.** `bandConviction` (a `high` conviction call cannot carry a
  >4× bear-to-bull spread — a band that wide says the outcome is unknown), `multipleStretch` (a leg's
  multiple against the name's own history, percentile). These land as `flags[]` on the doc. They are
  judgment calls the house wants to see, not rules it wants enforced — and since 2026-09 they are
  surfaced to Prometheus in update mode as **named standing objections** rather than buried in the
  JSON dump, because the re-model that read a flagged 30× bear leg as raw JSON moved it *further* out
  (`coverageObjections.test.js`).

One more write rule, learned the hard way: **an update sets only the fields its patch named**
(`_updateSet`). The merged document is built from a read, and writing all of it back is how the
monitor's verdict, landing a minute after a re-model, wrote the old target back over the new one.
The revision trail is `$push`-ed at position 0 in the same update (`houseArtifact.repo.revise`), so it
is append-only in the database, not by convention.

## The monitor — keeping a thesis alive

`monitoring/coverage.monitor.service.js`, on the shared `dueLoop` (poll · claim against a lease ·
check under a timeout). Ticks hourly; each coverage gates itself to ~daily via
`monitor.next_check_at`. Everything except a `retired` name is due — the rule is negative, so it rides
the filter rather than an allow-list. Not eager on start: a research loop has no reason to fire on
every deploy.

**Two tiers, and the split is cost.**

### Tier 1 — the daily check, deterministic and free

`_checkCoverage`: fetch fresh price (the shared `fetchLastPrice`, the same read Talos gates on) and the
Street's whole PT distribution (`{consensus, high, low, median}`), then classify — pure, no I/O —
in `monitoring/coverage.assess.js`:

| state | meaning | status change |
|---|---|---|
| `target_hit` | price reached our PT on schedule; `edge_gone` if the Street has also arrived | → `target_hit` |
| `target_hit_early` | reached inside the first quarter of its own horizon (`EARLY_HIT_FRACTION`): the number was **too low**. Reads as a MISS and re-opens the thesis | none — stays `active` |
| `validating` | the Street's PT is moving TOWARD ours (they are catching up) | none |
| `diverging` | the Street's PT is moving AWAY (we are increasingly contrarian) | none |
| `stable` | nothing material (a consensus move under `CONSENSUS_MOVE_PCT` = 2% is noise) | none |

Direction comes from OUR rating. Only a scheduled hit changes status — reaching our own number is a
fact about our own thesis; the rest are signals. A material state appends a revision and posts a
`coverage_event` card to **every admin** (the card asks for a revision only an admin can make;
traders never see it). A quiet day refreshes the recorded gap and bookkeeping with no revision — the
quiet path is what keeps the trail auditable instead of buried under daily noise.

The card is a WORK card: opening it leaves it pending ("Opened — still waiting on you"); saving the
revision closes it. The coverage PUT route calls `resolveCardsFor` with the revision's own account of
what moved (`revisionSummary` — "Re-modelled — rating sell → hold, PT 85 → 92", or "thesis held,
rating and target unchanged"), and the chip in the social chat shows that line under "✓ Revised".
Retire and delete close it the same way ("✓ Retired" / "✓ Deleted"). Pushed live over the socket
(`message_resolved`), so a panel open beside the desk flips without a reopen. (2026-09-19)

The `coverage_refreshed` card is different: with a review behind it ("Resume review") the ask is the
review — work, subject = the portfolio; WITHOUT one ("Open coverage") the ask is to READ what the
refresh wrote, so it closes on open (`resolvesOn: 'open'`). Stamped 'work' it had no write to wait for
and sat "still waiting on you" forever. Every refresh card also names its doc (`coverageId`) on the
failure paths too — "produced nothing to store" used to carry `null`, i.e. no subject, unreachable by
any write. And a re-model that LANDS (`coverageRefresh`) resolves every pending card on that doc —
the verdict that triggered it, an earlier "nothing to store" — with the revision's note, before its own
"re-model is in" card goes out: a company already revised has nothing left to click.
`scripts/backfill-coverage-refresh-cards.mjs` repairs the cards already posted: re-stamps, names the
doc, resolves cards answered by a later revision, supersedes older duplicates. (2026-09-19)

`gap.pctile` — where our PT sits inside the Street's own low→high range — is the measure that says
whether we hold a variant view at all. A percentage off the mean does not: against targets spanning
500–700, 12% under the mean is still inside everyone else's range.

**Ratchets, because nothing terminal stops the loop.** Consensus states self-limit (each write moves
the stored `gap.consensus_pt`, so `diverging` re-fires only on a *further* move). A price comparison has
no such property: a `target_hit` name parked above our PT would re-fire the same card daily, so a
verdict the doc already records is not news. An early hit gets its own stamp (`monitor.early_hit_at`),
scoped to the target it silenced — a re-model writes a fresh, higher target with a fresh `set_at`, and
a stamp older than the current target has outlived its subject.

**Never price.** There is deliberately no price-based `thesis_broken`. Research is not a position:
price falling does not invalidate a buy thesis, it makes the name cheaper. The rule this replaced read
`risk_reward.bear` as a stop level — but for a bullish name that band routinely sits *above* spot, so
the invalidation edge was above the market on day one and every thesis broke on its first check. The
same class of bug fired once more when a missing quote read as `0` ("price 0 ≤ bear case 597"); a
price is now only a positive finite number, and absence is absence. Invalidation belongs where the risk
is: **a held name's revised PT against its entry basis is Themis's gate** (`computeReviewTriggers`),
and the text `kill_criteria` are the research-side judgment, for the LLM tier.

### Tier 2 — the re-model, rare and gated

A re-model wakes Prometheus headless for a full multi-phase research run — minutes, tool-heavy — so it
needs a **reason, not a schedule**. `monitoring/coverage.remodel.js`, pure, decides from the same daily
fetch (no extra call to ask). The framing that makes the triggers obvious: our target is
`multiple × forward metric`, and it is stale when one of those inputs has been contradicted:

0. **An early target hit** — the one apparent exception to "never price", and not really one: reaching
   our own number in a fraction of the horizon contradicts the model as squarely as a catalyst does.
1. **A dated catalyst landed** since we last modelled — earnings printed, the facts changed. Known
   months ahead, so it *schedules* (`monitor.next_remodel_at` + `next_remodel_reason` — the catalyst's note beside the date so
   the UI never re-derives why) rather than polls. Only strict `YYYY-MM-DD` catalysts count;
   "2027-Q1" is prose for the analyst.
2. **The edge changed category** — `classifyEdge`: our band against the Street's range moved between
   `contained` / `variant` / `contrarian`. That is the edge changing shape, not the tape wobbling.
   `edge_category` is persisted on every tick precisely so the next one can detect the change.
3. **The quarterly floor** — nothing in 90 days (`FLOOR_DAYS`).

All under a 14-day per-name cooldown (`COOLDOWN_DAYS`; a name in the news trips several triggers in a
week, and three runs in three days buy nothing the first did not) and a per-tick cap of 3
(`MAX_REMODELS_PER_TICK`; an earnings week must not fire a dozen research runs at once). The budget is
spent *across* the due set — **held names first**, since they are the ones carrying risk — then
capped; overflow stays due and is logged, never silently dropped.

**Not triggers, and why** (asked and declined 2026-07-30): raw consensus drift — that is the daily
card's job, and for a contrarian thesis the Street moving away is the view working; and sector
rotation — it moves neither our PT nor the Street's, has no ratchet (every name in the sector would
ring daily), and already has a home at the right tier (rotation is an allocation question, Themis's).
The candidate that *would* clear the bar is unbuilt and named in the file: **peer-multiple
compression** — a comp set de-rating and staying de-rated contradicts the `multiple` half of the model.

**The run is claimed, then launched, not awaited.** `claimRemodel` compare-and-swaps the cooldown
stamp *before* the run (a second tick — or a second process — stands down instead of paying twice),
and the run goes out route-and-return through the same headless hop Atlas uses. Two corrections here
are worth knowing: between 2026-08-26 and 09-16 the hop refused a house run (`userId: null`) and
nothing read its answer, so every scheduled re-model logged, stamped its cooldown and did nothing; and
until 2026-09-19 the tick awaited the run under a 3-minute guard that was abandoning *healthy* runs
(a good one takes ~3 min — INTU/CRCL/SCHW, three research runs paid for and nothing stored). The
daily checks never needed the result: the claim is stamped, the hop posts its own card.

## The hops — who asks Prometheus for what

| Caller | Mechanism | What comes back |
|---|---|---|
| **Admin at the desk** | `/api/analyst/stream`, then Initiate | a `<coverage>` draft, persisted on Initiate |
| **Argus → the research queue** | `researchQueue.service`: Argus enqueues names from overweight sectors WITH the mandate context that surfaced them ("research AAPL because the house is +300bp Technology on a disinflation regime" is a different instruction from "research AAPL"; a duplicate keeps the context it was first queued with) | queued → in_research → done / rejected |
| **The research run** | `researchRun.service`: the whole queue, headless, one name at a time — the same agent, prompt and context, only the audience changes. Skips a name the house already covers (whether the standing thesis needs a look is the pencil's judgment, not the machine's); a PASS is recorded as `rejected: no_edge`; a failed save stays `in_research` with the error. One run at a time, in memory — the day the backend outlives the laptop is the day it needs a collection | house coverage, then `sleeve_sourced` to the Atlas that asked |
| **Atlas mid-review** | `<coverage_refresh>` → `coverageRefresh.service`, route-and-return: Prometheus rewrites ONE name's coverage (initiate or append a revision), then a `coverage_refreshed` card tells the user to resume. Artifact-mediated: Prometheus writes the doc, Atlas re-reads it — no live judgment injection between agents | the doc, re-read on resume |
| **The monitor** | the same hop, `userId: null` — a house run; the card fans out to every admin | a fresh target and band |
| **Aether** | quick-read mode (above) | a `<quickread>` verdict, no doc |
| **Every desk, reading** | `getCoverage` / `listSymbols` (the one-field projection — Prometheus's own context, the run's skip list and the sleeve orchestrator used to pull whole documents to learn a ticker) | the house view |

**What a trade keeps of it.** At execution (`ideaExecution`, `manualIdea`), `captureResearchBasis`
freezes `{ coverageId, coveragePt, at }` onto the position as `research_basis` — the number the trade
was taken on. Coverage prose gets rewritten; a pointer would resolve to the wrong text, so the fact is
copied. That frozen PT is what Themis compares the *revised* one against.

## Why it is shaped this way

- **A gap, not a price, because research has no position.** Every price-based rule this desk ever had
  fired on every name at once. The only thing that can move a thesis is the world updating — the
  Street's numbers, a catalyst, our own model being contradicted.
- **Two tiers, because a research run costs minutes.** The free tier runs daily on every name; the
  expensive tier needs a reason. Folding them ("re-model whenever something moves") would spend an
  hour of Prometheus on tape noise.
- **House-owned, because a name has one fair value.** Two users covering NVDA would be two theses on
  one fact. What differs per user is the *position*, and that is where the per-user objects live.
- **The pencil stays with the admin.** Every automatic path — the run, the refresh, the re-model —
  writes a revision the admin reads after; none of them overwrites a standing thesis without leaving
  the trail. The run's skip rule and the quiet path exist for the same reason.
- **PASS is a first-class outcome.** A queue row that ends `no_edge` is research that was done. A
  book of me-too theses would be worse than an empty one.

## Open

- **The LLM tier over `kill_criteria`.** The free-text criteria are the only place invalidation lives,
  and nothing judges them yet; `thesis_broken` is reachable only by hand. The monitor's header says so.
- **Peer-multiple compression** as trigger #4 — designed in `coverage.remodel.js`, needs a baseline
  multiple persisted at model time and a noise threshold.
- **The model + effort a re-model was read with** are not on the revision.
- **Prometheus, Pythia and Aether are one research layer** in the architecture vision
  ([design/architecture-vision.md](../design/architecture-vision.md)); how the tilt should steer
  which names get researched, beyond Argus's sector overweight, is not written down. *(Inferred gap —
  not stated anywhere in code.)*
