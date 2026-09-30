# Pythia + the tilt monitor — the `tilt` artifact

The house's top-down view: **Pythia** names the regime and publishes a table of sector stances as
active weight against a benchmark; **the tilt monitor** grades every stance daily by arithmetic and
decides when the desk owes a review. Written 2026-09-19 from the code and its comments. The desk went
admin-only end to end on 2026-09-14, and that is called out where it lands.

The one line: **a tilt is the one forecast in this app that grades by arithmetic rather than
judgment — `active weight × relative return` — and it is the mandate the rest of the house pipeline
is steered from.**

## The grain — what a stance is held ON

Since 2026-09-30 a row names a **sector or an industry**, whichever grain the bet lives at, and
carries which (`grain`) alongside the name (`bucket`) and the fund it is graded against (`proxy`).
"Overweight Energy" is a direction; "overweight Oil & Gas Exploration & Production" is a place to
look, and Argus can screen it unchanged because the vocabulary is the screener's own
(`INDUSTRY_SECTOR`, 155 industries derived from FMP, each owned by exactly one sector).

**Two grains, not three.** FMP's `industry` is already sub-industry fine — `Gold`, `Steel`,
`Semiconductors`, `Banks - Regional` are all first-class there — so a third level would have no
vocabulary behind it and nothing to screen with.

`resolveBucket` tries the INDUSTRY first, and that order is the whole function: falling through to
the sector would publish a bet on many times more of the market than the author wrote, against the
wrong fund, with nothing downstream able to tell. ~~`sectorProxy`~~ and the `sector` field are gone
rather than kept beside the new ones; `scripts/migrate-tilt-buckets.mjs` moved the stored rows and
Atlas's stored review fingerprints, which carried the field too.

**Two gates come with it**, both refused at publish where the author can fix them:

- **A table may not hold a sector and its own industries** (`overlappingRows`). Every weight is
  active against the one benchmark, so "Energy −100" beside "Oil & Gas Midstream +50" counts
  midstream twice — the sums still net and what they mean is mud.
- **A bucket with no fund CASCADES to its parent's** (`tradableProxy`) rather than being refused.
  The design's own rule: the finest bucket that can be PRICED, not the finest that exists. A view
  on Publishing is graded against XLC and the row records `stands_for`.

  This replaced a REFUSAL, and the refusal did real damage. It made the desk responsible for
  knowing which of 155 industries have funds — nothing tells it — so the only safe table was one
  of sectors, and eight live runs produced exactly that. `unpriceableRows` survives as an assertion
  about the vocabulary rather than a gate on the author: every sector has a fund, so the cascade
  terminates, and a row reaching it means `BUCKET_PROXY` is missing an entry.

The proxy is FROZEN onto the row at publish, for the same reason the baseline is. Swapping a fund
in `BUCKET_PROXY` must not silently re-score a standing call against an instrument it was never
measured on. `weighting` and `exact` ride along because both distort a grade — an equal-weighted
fund against a cap-weighted benchmark books part of a size factor as an industry call, and a fund
that spans several industries is not the bucket it stands in for.

## What a tilt IS, and is not

ONE document for the whole market (`api/strategy/tilt.service.js`, collection `tilt`): a `benchmark`
(`SPX`), a `regime` (`name`, `thesis`, `kill_criteria`) and `tilts[]` — one row per BUCKET with
`stance` (`over · neutral · under`), `active_bp`, `horizon`, `basis`, `rationale`, and the grading
fields the service adds: `set_at` / `review_date` (the row's own clock), `base_px` / `base_bench_px`
(the frozen baseline), `contribution_bp`, `state` (`open · matured`). Plus `net_bp` / `balanced` on
the table and an append-only `revisions[]` trail. `status` ∈ `active · superseded · retired` — one
active view per benchmark; publishing SUPERSEDES the previous one, never overwrites it.

**A stance is an active weight, not a return forecast.** "Overweight Healthcare +150bp" claims
healthcare beats the index; it can be right in a falling market (down 8% while the index falls 12%
worked). That relativity is what makes it gradeable: `active_bp × relative return = contribution`, which
is standard attribution, not an opinion. It is the one forecast here that both scores cleanly and
drives a decision.

Three things it deliberately is not:

- **Not coverage.** Coverage is one doc per SYMBOL, bottom-up; a tilt has no symbol at all. Both are
  house-owned BROADCASTS (no `userId`, never joined to a user's book), and they share the write pipe
  (`services/houseArtifact.repo.js`) and the forecast clock. They differ in grain, not ownership.
- **Not an allocator, not a stock picker.** Prometheus works names, Atlas allocates. The desk exists
  precisely so the allocator reads a top-down view it did not write itself.
- **Not a generic entity.** `makeEntityCrud`'s owner scope is the guarantee that a list is only ever
  the caller's own; bolting a skip-ownership branch onto it is how leaks get built. What this
  collection needs is a PUBLICATION LOG — one active view, superseded ones kept for grading — which
  is a different mechanism, not a variation.

## Pythia — how a view is formed

`prompts/strategy_system_prompt.md`. Five phases, each announced with `<phase>N</phase>`:

1. **Backdrop** — observables before opinion: `get_priced_in` (what the market has discounted),
   `get_macro_snapshot` (curve, growth, inflation, policy), `get_sector_snapshot` (where money went).
2. **The regime** — named in a few words, argued in a paragraph, and then its **kill-criteria**: the
   checkable things that would say the read is wrong. "A regime without falsifiers is a mood, and the
   monitor cannot act on a mood." The regime is the BASIS of the table, deliberately not its own
   artifact with its own clock — same call as `price_target.basis` on coverage.
3. **Sector mapping** — the regime onto factor exposures: rate sensitivity, cyclicality, duration,
   dollar and oil. Where a regime becomes a stance.
4. **Bottom-up cross-check** — `get_coverage_by_sector`: our own analysts' theses aggregated by
   sector, how far our targets sit from the Street. Agreement is the strongest basis a stance can
   have; **disagreement is information, and a stance taken against our own research must admit it.**
5. **Publish** — emit the `<tilt>` block. A DRAFT, returned for preview; publishing is a separate act
   (`publishTilt`), same as a coverage draft vs Initiate.

**Every stance records WHY**, and the four bases are ranked by evidential weight in the vocabulary
itself (`TILT_BASES`): `bottom_up` (our covered names say so — most defensible) · `revisions` (sector
estimate-revision momentum — empirically the best-supported signal) · `valuation` (multiple vs own
history — weak mean reversion) · `rate_sensitivity` (the regime mapped onto exposure — top-down, the
easiest to tell a story with, so it needs the most discipline). The sector-rotation clock is named in
the prompt as a narrative device: usable to explain a stance reached another way, never as the reason.

Two rules the prompt makes the model hold: **the table nets to zero** (a book is fully invested;
funding an overweight means an underweight somewhere) and **it gets graded** — there is no rhetorical
escape from a stance, so pick the horizon you mean. Horizons are the shared vocabulary
`3m · 6m · 12m · 18m · 24m` (`forecastClock.js`), default `6m` — the DESK's (`DESK_HORIZON`), not the
clock module's `12m`, which is a price target's convention and would leave a monthly-reviewed stance
ungraded for a year — set per row because a rate call and a
cyclical call do not mature on one clock.

## The clock and the baseline — what makes a stance falsifiable

Two things are frozen onto every row at publish, and the rule governing both is the same:
**reaffirming keeps them; re-authoring restarts them.**

- **The row owns its own clock** (`set_at` → `review_date`, via `forecastClock.openWindow`). A monthly
  review typically changes two sectors and reaffirms nine; if the clock lived on the document, every
  review would reset all eleven and a 12-month call would never come due — the same unfalsifiability
  a price target without a deadline had. So `set_at` is preserved when the row carries one and
  re-stamped when it does not.
- **The baseline is frozen** (`base_px` — the sector proxy — and `base_bench_px`, stamped by
  `stampBaselines` BEFORE the doc is stored). Attribution then needs only today's prices. Not an
  optimisation: deep daily history is not reliably available here (a range fetch 403s, ~a month of
  bars is cached), so a stance authored six months ago could not be re-based from data at all. And an
  immutable baseline means a provider revising history cannot silently re-score a closed call. A
  price that cannot be read leaves the baseline `null` rather than a guess; the monitor backfills it
  on the first tick that can price it — a day of imprecision instead of a permanently unscoreable call.

The consequence the prompt states plainly: stretching a horizon to flatter a stance does not work,
because the deadline first chosen is the one it is judged against.

**Which row is a reaffirm is decided SERVER-side** (`carryReaffirmed`, called from `publishTilt`),
and it has to be, because the author cannot decide it: Pythia emits a table rather than a diff and
the `<tilt>` block has no `set_at` field, so a row off the wire never carries a window for
`openWindow` to preserve. Publish reads the standing view first and merges its `set_at`, baseline
and running contribution onto every row unchanged in **stance, `active_bp` and horizon** — the same
equality `diffStances` uses to decide a sector moved, plus the horizon, so the card and the clock
cannot disagree about what changed. A **closed** window is never carried: a matured row, or one
whose deadline has simply passed, was already owed a verdict, so restating it is a new call rather
than the old one continuing (carrying it would store a row overdue the instant it is written, and
the review it triggers would re-offer the same stance on every tick).

*Fixed 2026-09-30, and this section previously described the rule as if the data held it.* It did
not: the helper preserved a `set_at` it was handed and nothing ever handed it one, so **every**
publish re-stamped **every** deadline and `stampBaselines` re-priced every baseline. Four of the
five republishes on the book had restarted all six rows — no stance could ever mature (the one
trigger the clock exists to pull), and the score re-based at each review's own prices, so Energy
read **+0.99bp** against **−3.36bp** measured from the baseline it was actually set at. The unit
test that claimed to cover the rule fed `set_at` straight into the normalizer, which is the one
thing a real publish never does, so it stayed green throughout. The view standing at the time is
repaired by `scripts/repair-tilt-clocks.mjs`, which REPLAYS the publication chain through
`carryReaffirmed` — the fix applied retroactively rather than a second opinion about what counts as
a reaffirm — and leaves alone any stance whose baseline the chain cannot honestly reconstruct.

## The line — the contribution, drawn

`contribution_bp` says where a stance ended up and nothing about how it got there, and those are
different facts about a call: a stance that bled for five months and snapped back last week reads
identically to one that worked from the day it was set, and only one of them is a thesis behaving
as written. `api/strategy/tiltSeries.service.js` serves the path — the bucket's performance against
the benchmark since its own `set_at`, rebased to 100 — at `GET /api/strategy/tilt/series`.

**The line and the number must agree**, and two things enforce it:

- **Arithmetic, not geometric.** `v = (px/base_px − bench/base_bench_px + 1) × 100` is exactly what
  `relativeReturnPct` computes. The intuitive ratio-of-growth-factors form reads −10.48% where the
  grader reads −11% — half a point of daily disagreement between a chart and the figure printed
  beside it, invisible unless someone checks. The attribution this desk runs on is arithmetic, so
  the line follows the grader.
- **Signed by the stance, in the panel.** The service sends the BUCKET's relative return, which is
  the objective quantity and the one the grader scores; what a row REPORTS is what the stance
  earned, which is that return times the sign of the weight. Plotted unsigned, every underweight
  reads backwards — Real Estate rendered +7.9bp beside a falling red line, live, until the drive
  caught it.

A SEPARATE read from the view. The board paints on the numbers it already has; the bars behind a
dozen rows are a dozen range fetches, and folding them into `/tilt/current` would put all of them
in front of every read of the house view. A stance set today has no line and costs no fetch to
discover it — asking a provider for a zero-width range 403s and logs what reads like an outage.

## The gates — refused vs recorded

Same distinction as coverage, and the same reason:

- **A contradictory row is REFUSED** (`stanceCoherence`): `over` needs a positive `active_bp`, `under`
  a negative one, `neutral` exactly 0. This is the twin of coverage's `ratingCoherence`, and here the
  failure is worse than a bogus card — `active_bp` is what Atlas would actually allocate on, so a row
  reading `over` with `-150` would UNDERWEIGHT a sector the desk meant to favour. The words and the
  number agree before either reaches an allocator. Refused at publish, where the author can fix it.
- **An unbalanced table is RECORDED, not rejected** (`balanceOf`, `BALANCE_TOLERANCE_BP` = 50):
  `balanced: false` is a construction smell worth seeing, not a contradiction worth destroying the work
  over. Not directly allocatable, and the panel says so. The verdict is computed server-side and
  carried on the draft response — the frontend used to compute it itself with the tolerance copied
  into a component, where nothing would tell you the two had drifted.
- **One row per sector** — two stances on one sector is a contradiction; first wins, so a later
  duplicate cannot quietly override an earlier one. A row whose sector will not canonicalise is
  dropped, and the drop is recorded on the publish (the stored doc cannot distinguish "held no view
  on Utilities" from "the Utilities row was discarded at the boundary").

Updates set only the fields the patch named (`_updateSet`) and prepend the revision in one atomic
write — the same lesson coverage learned by losing a target to a stale merged copy.

## The monitor — grading, and asking

`monitoring/tilt.monitor.service.js`, on the shared `dueLoop`. Hourly tick, ~daily per view via
`monitor.next_check_at`; there is one broadcast view, so "due" is at most one document a day. Not
eager on start. One price read a day per bucket carrying an open stance, plus the benchmark, and only
for sectors carrying an open stance.

**Two tiers, mirroring coverage — and the expensive tier is not run by the monitor at all.**

### Tier 1 — the daily grade, pure arithmetic

`monitoring/tilt.assess.js`, no I/O:

- `relativeReturnPct` — the stance's relative return over its own window. Relative is the whole
  point: only this subtraction can say that an overweight that fell 8% while the index fell 12% worked.
- `contributionBp` — `active_bp × relative return`, in basis points of portfolio return. **Null, never
  0, when an input is unknown**: "we don't know" and "it earned nothing" are different facts, and only
  one of them should be shown to someone judging the desk. A missing quote and a zero are both the
  absence of information — the same rule that stopped `thesis_broken` firing across every covered name.
- `gradeRow` — re-grades from the row's frozen baseline, never a re-fetch. A row whose window closed
  **matures**; that is what closes the call and makes it scoreable. A sector unpriceable today keeps
  yesterday's figure rather than being overwritten with null.

The daily grade is bookkeeping (`recordMonitorState`, under `monitor.*`, no revision) — a
contribution ticking with the tape is not the desk changing its mind, and a revision a day would bury
the ones that matter. **Maturity IS a state change**, so that one goes through the service and leaves
a trail entry.

### Tier 2 — the review, gated, and an OFFER

`reviewDecision` decides whether the desk owes a re-author, from the clock and the macro calendar:

1. **A stance came due** — a matured row left in place is a call nobody ever graded, which is the
   failure the whole clock exists to prevent.
2. **A dated macro catalyst landed** since the last publish — the same FRED feed behind the Radar Fed
   tab, narrowed to FOMC decisions and high-impact prints (a low-impact release is not a reason to
   re-author a 3–12 month view). Actionable the day after, so the print is in the data.
3. **The monthly floor** — `REVIEW_FLOOR_DAYS` = 30.

Under a 7-day cooldown (`COOLDOWN_DAYS`) that outranks every trigger. **Both are measured from the
last publish or re-author on the revision trail** (`reviewAnchorMs`, `REVIEW_KINDS`) — deliberately
not `updated_at`, which the monitor's own maturity write moves; anchoring there pushed the floor out
30 days and restarted the cooldown at the exact moment maturity should have pulled the review in.

**Deliberately not a trigger: today's sector move.** A tilt is a 3–12 month call; the tape moving
against it for a week is the position being early, not wrong — the same reason price is not a
re-model trigger on the coverage side. And not the regime's free-text `kill_criteria` either: judging
prose is the LLM tier's job, and a pure module must not fake a verdict.

**The wake is a card, not a run.** A re-author supersedes the view every user reads, so the monitor
never runs Pythia headless — it posts `tilt_review` to every admin (`tiltNotify`), and the confirm
takes the user to Pythia and runs the review in their thread. Same call the daily market brief
makes: an offer, no tokens spent until someone says yes. The card is built from the *graded* rows so a
stance that matured on this tick leads it, rather than reading as a generic "review due". No separate
maturity card — maturity is itself a review trigger, and one event should be told once.

## The hops — who reads the tilt, and what it steers

The tilt is a READ, not a hop: a standing view is published on a cadence, not requested per run.
`getCurrentTilt` returns null on failure, never throws — an unreachable view degrades to "Atlas
allocates without a tilt", never to a broken build.

| Reader | What it does with it |
|---|---|
| **Atlas** (`portfolioChat`, `portfolioReview.util`) | Reads the current view into the mandate build and the review fingerprint. `diffStances` between the fingerprinted view and the current one is a review trigger ("the house view moved"); the tilt is one of the inputs `computeReviewTriggers` weighs |
| **Argus — the house scan** (`houseScan.service`) | **The tilt is the mandate.** Fired after a publish: for each `over` sector, screens the universe and enqueues names for Prometheus, with `active_bp` setting breadth and queue order. The regime and the `basis` are NOT compiled into filters — FMP's screener has no valuation or revision predicate, and faking one with a proxy would substitute a guess for Pythia's stated reason — so they travel on the queue row and Prometheus applies them ([prometheus-coverage.md](prometheus-coverage.md)) |
| **Axl** (`sectorView.tools`) | Shows the published view — reading is Axl's side of the line; authoring or changing one is Pythia's and gets a `<route>` |
| **Every admin** | `tilt_event` when a publish MOVED a sector (`diffStances` against the view in force; a reaffirming republish tells nobody) and `tilt_review` when the desk owes a look |

**Admin-only, end to end (2026-09-14).** Pythia's chat, its draft and the tilt log are the house
layer — the input the pipeline is steered from, not a view a trader consumes. The reads used to be
open while only the writes were gated, so the client hid the desk and the server still answered;
`router.use(requireAdmin)` makes the served set equal to the visible set, the same rule the cards
apply. The monitors and the other desks read the tilt in-process, so they are unaffected.

## Why it is shaped this way

- **Active weight, because it is the one thing that both grades and allocates.** An absolute sector
  forecast scores ambiguously and Atlas could not act on it; a stance in basis points is both a claim
  the arithmetic can settle and a number an allocator can apply against a mandate.
- **Per-row clocks and frozen baselines, because a living view is otherwise unfalsifiable.** Every
  mechanism here exists to stop a standing view from quietly pushing its own deadline out.
- **Grading in a pure module, because nothing in it is an opinion.** The monitor fetches twelve prices;
  everything else is attribution any reader can recompute.
- **Ask, don't run, because a publish is read by everyone.** The re-author is the only automatic path
  in the house pipeline that ends in superseding a broadcast; it takes a human confirm.
- **Broadcast, because the house has one view.** Two users with two regimes would be two strategy
  desks. What differs per user is the mandate the view is applied against — Atlas's business.

## Open

- **The LLM tier over the regime's `kill_criteria`** — the falsifiers are written and nothing judges
  them; same gap as coverage's.
- **The bottom-up basis is a cross-check, not a feed.** Phase 4 reads coverage by sector at authoring
  time; nothing re-runs that comparison as coverage changes between reviews. *(Inferred gap.)*
- **The policy path is invisible** — fed funds futures / OIS are not available, and the prompt says
  so; breakevens carry a risk premium. A desk that cannot see what is priced in is arguing against a
  benchmark it has to estimate.
