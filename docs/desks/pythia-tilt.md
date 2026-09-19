# Pythia + the tilt monitor — the `tilt` artifact

The house's top-down view: **Pythia** names the regime and publishes a table of sector stances as
active weight against a benchmark; **the tilt monitor** grades every stance daily by arithmetic and
decides when the desk owes a review. Written 2026-09-19 from the code and its comments. The desk went
admin-only end to end on 2026-09-14, and that is called out where it lands.

The one line: **a tilt is the one forecast in this app that grades by arithmetic rather than
judgment — `active weight × relative return` — and it is the mandate the rest of the house pipeline
is steered from.**

## What a tilt IS, and is not

ONE document for the whole market (`api/strategy/tilt.service.js`, collection `tilt`): a `benchmark`
(`SPX`), a `regime` (`name`, `thesis`, `kill_criteria`) and `tilts[]` — one row per sector with
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
`3m · 6m · 12m · 18m · 24m` (`forecastClock.js`), default `6m`, set per row because a rate call and a
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
eager on start. At most twelve price reads a day (eleven sector proxies plus the benchmark), and only
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
