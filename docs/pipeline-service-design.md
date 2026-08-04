# The pipeline service — one conveyor, artifacts between desks

**Status: DESIGN, nothing built.** Mostly a frontend service (the conveyor and the artifact
envelope live in `botmarket-frontend`); the backend touchpoints are called out where they exist.

## Why

A pipeline's *shape* is already declarative: `agentMeta.jsx` `DESKS` states each desk's entry tab
and ordered `steps[]`, the hub renders from it, and `pipelineNav.js` derives the crumb and the back
button from it. Adding a desk made of existing agents is a data edit today.

The *hops* are not. Every arrow between two desks is hand-written in `MainPage.jsx` (2685 lines):

| Hop | Code today |
|---|---|
| Kairos → Argus | `handleOpenArgus` + `buildScanSeedMessage` |
| Argus → Kairos | `handleBackToKairos` |
| Atlas → Argus | `handleSourceInArgus` + `_screenSleeve` + `_advanceSleeveRun` + `handleSkipSleeve` |
| Argus → Prometheus | `handleResearchList` (+ `handleResearchCandidate`) |
| Prometheus → Atlas | `handleSleeveResearched` |

Each hand-rolls the same four moves — build a seed sentence, decide which panel remounts, clear the
*other* hops' state so a stale one can't re-fire, switch the tab — and each owns its own state:
`scanHandoff`, `scannerSeed`, `kairosScanResult`, `analystScanResult`, `portfolioSeed`,
`mentorSeed`, `analystSeed`, plus `sleeveRunRef` and `sleeveOutcomeRef`.

So the real cost of a new pipeline is not the steps. It is the arrows, and they grow N².

## The two decisions that make reordering possible

**1. Key the artifact by `kind`, never by `to`.** An envelope carrying its destination just moves
the pairwise coupling into data — reordering would still mean editing every sender. An agent
declares *what it emits* and *what it accepts*; the **pipeline** is the only thing that knows the
order. `from` is kept as provenance (Prometheus says "researching for the Technology sleeve Atlas
asked for") and is never read to dispatch.

**2. The RECEIVER writes the opening brief, not the sender.** Agents don't accept objects, they
accept a sentence (`useSeedTurn` sends it as the user's turn). Today the sender writes it —
`_screenSleeve` composes Argus's brief in Atlas's handler — which is precisely what makes the sender
know the receiver. Inverted, each agent owns one `brief(artifact)`: *given a mandate, here is how I
open*. N builders instead of N², untouched by reordering.

This is the existing rule applied one level up: share the pipe, not the judgment. The sender's
judgment goes **into the artifact** (`lens: 'quality'`, `industry: 'Semiconductors'`, `constraints`);
the receiver's judgment is how to open on it.

> Validation that the keying is right: Argus behaves differently in its two inbound hops —
> single-pick mode vs the `investing` profile. That difference is derived from *what it accepted*
> (`scan_request` → single pick, `mandate` → investing), not from who comes next. An agent's mode
> falls out of its inbox, which is exactly what kind-keying predicts.

---

## 1. The artifact envelope

One shape, keyed by `kind`. Mirrors `services/entity/toEnvelope.js` one level up: consumers stay
kind-blind, and the payload is a **reference to a persisted entity where one exists**.

```js
{
  kind:    'mandate' | 'scan_request' | 'candidate_list' | 'coverage_set' | …,
  status:  'filled' | 'empty' | 'partial',   // see §5 — empty is a RESULT
  ref:     { entityKind, id } | null,        // preferred: the saved artifact
  items:   [ … ] | null,                     // inline: unsaved, session-scoped
  context: { … },                            // kind-specific extras (lens, horizon, sleeve label)
  from:    { agent, step, label },           // provenance / display ONLY — never dispatch
  note:    string | null,                    // why it is empty/partial, in words
}
```

**`ref` or `items`, both allowed, `ref` preferred.** Some outputs are already saved when they hop
(a scan, a coverage doc); some are handed across in memory and never persisted (Argus's
`<kairos_pick>`). Requiring save-before-hop would add a user step to the trade desk for no gain.

Consequence, accepted: an inline artifact does not survive a reload. A run is session-scoped either
way (all hop state is in `MainPage` today); `ref`-carried artifacts survive as entities even when
the run does not. Consumers never branch on which they got — one `resolveArtifact(a)` returns
`{ items, ref }` for both.

### Kinds, derived from the hops that exist

| kind | emitted by | accepted by | today |
|---|---|---|---|
| `scan_request` | kairos | scanner | `<scan_request>` → `handleOpenArgus` |
| `mandate` | portfolio | scanner | `<screen_request>` → `handleSourceInArgus`, `items` = sleeves |
| `candidate_list` | scanner | kairos, analyst | `<scan_list>` (ref) and `<kairos_pick>` (inline, 1 item) |
| `coverage_set` | analyst | portfolio | `handleSleeveResearched` + `sleeveOutcomeRef` |

`<kairos_pick>` collapses into `candidate_list` with one inline item — the receiver decides it wants
`items[0]`. Two hops, one kind: the first evidence the scheme actually removes code.

### Argus has three modes, and they ARE its inbox

Argus scans for the portfolio desk, for Kairos, and for the user. That is not three behaviours to
branch on — it is one behaviour reading what it was handed, which is the strongest evidence the
kind-keying holds up against the real agents.

| inbox | mode | saves a scan? | emits |
|---|---|---|---|
| `mandate` | investing / portfolio | **no** | inline `candidate_list` |
| `scan_request` | single-pick for Kairos | **no** | inline `candidate_list` (1 item) |
| *(nothing)* | user watchlist | **yes** | `ref`'d `candidate_list` |

**RULE (decided): only a user-initiated scan produces a list in the Scans tab.** Which gives the
invariant that settles `ref`-vs-`items` — no special case, one checkable rule:

> `ref` is non-null exactly when the step had an empty inbox.

**This is a behaviour change.** `handleGenerateList` (`MainPage.jsx:2101`) calls `createScan`
unconditionally, *before* the sleeve-run branch at 2117 — so a three-sleeve portfolio run currently
drops three sector lists into the Scans tab. The fix is to gate the save on "no inbound artifact".
Nothing else needs moving: the sleeve run already reads `scan.candidates` off the emitted object
(2118), not off the saved doc.

Two knock-ons, both **accepted and deferred** (see §8):

- A sleeve list is no longer reviewable after the run — it exists only in the Argus transcript.
- `handleUpdateList` needs a `scanId`, so mid-run "Update list" has nothing to update. It must be
  **suppressed during a run**, not left to fail. Editing a list stays available where the list is:
  the Scans tab, i.e. user scans only.

---

## 2. The agent contract

One file per agent, **beside its panel** (`cmps/AnalystPanel/analyst.contract.js`) so the judgment
stays with the agent. A registry assembles them; `agentMeta.jsx` stays data-only.

```js
export const analystContract = {
  agent:   'analyst',
  accepts: ['candidate_list'],
  emits:   ['coverage_set'],
  brief(artifact) { … },        // artifact → the opening turn, in Prometheus's own words
  mount:   'continues',          // default; a step may override
}
```

`emits` is a list — Atlas emits `mandate` **or** `portfolio_plan` depending on where it stands. The
step says which one it is waiting for (`awaits`), which also resolves the ambiguity `resolveStepIndex`
currently fights by proximity: Atlas at step 0 awaits `mandate`, at step 3 awaits `portfolio_plan`.

---

## 3. The pipeline declaration

`DESKS` gains per-step config. Adding a desk = a `steps[]` entry; reordering = moving lines, legal
whenever `emits`/`accepts` chain; adding an agent = one contract file, zero `MainPage` edits.

```js
{
  key: 'portfolio', label: 'Portfolio Desk', entryTab: 'portfolio', agentKey: 'portfolio',
  steps: [
    { agent: 'portfolio', label: 'Mandate',   awaits: 'mandate' },
    { agent: 'scanner',   label: 'Screen',    awaits: 'candidate_list', each: 'sleeves', mount: 'fresh' },
    { agent: 'analyst',   label: 'Research',  awaits: 'coverage_set',   each: 'names' },
    { agent: 'portfolio', label: 'Allocate',  awaits: 'portfolio_plan', gate: true },
    { monitor: 'themis',  label: 'Monitor' },
  ],
}
```

- **`each: '<field>'`** — fan out over the incoming artifact's items, one agent run per item, **join
  before advancing**. Without this the sleeve run stays bespoke and the refactor skips the expensive
  part (see §5).
- **`mount: 'fresh' | 'continues'`** — real config, not an implementation detail. Argus remounts on
  *entering* a run and continues between sleeves (`MainPage.jsx:1949`); Kairos must never be keyed or
  its draft dies. A fan-out step remounts on entry only.
- **`gate: true`** — never auto-advances past this, whatever the mode (§4).
- **`monitor:`** — a background step, no tab, nowhere the user stands. Terminal display only, as
  `previousStep` already treats it.

---

## 4. The conveyor — auto and manual

A run is `{ pipelineKey, stepIndex, artifact, mode, fanout }`, held by a `usePipelineRun` hook in
`MainPage` (state for what renders, a ref for what async handlers accumulate — the split
`sleeveRunRef` already had to learn the hard way).

- **`manual`** (default) — the artifact lands, the conveyor offers *"Send to Prometheus"*, and the
  user can keep chatting at the current desk first. This is today's behaviour, made generic.
- **`auto`** — the artifact lands and the next step is briefed immediately.

Set at launch from the hub, changeable mid-run (switching to manual pauses at the next boundary).

### Rules that hold in BOTH modes

1. **Auto never crosses into execution.** The last authoring step before a monitor is always a gate.
   Arming and order confirmation are human everywhere else in the app (`OrderConfirmDialog`,
   `PreEntryDialog`, Atlas review's *auto = pre-check only, never auto-execute*); a pipeline toggle
   must not become the back door around that.
2. **No artifact → no advance.** A turn that ends in a question (Argus asking for a window, Kairos
   for a horizon) drops the run to manual and says so. Never a stall — that is the `handleSkipSleeve`
   scar, where a listless turn silently lost every remaining sleeve.
3. **Auto runs are bounded and abortable.** A max step count and max fan-out width; Stop cancels the
   in-flight turn and **pins** the run rather than advancing. Anything the budget drops is logged
   and shown — a silently truncated run reads as a complete one.
4. **The run is visible.** `sleeveRun` already proved this: a run used to be invisible and the only
   evidence was Argus starting to talk again. The conveyor owns one progress surface for every desk.

---

## 5. Empty is a result, not an absence

`MainPage.jsx:1910` records what this costs: a sleeve that screened empty stalled the run, and Atlas
built a book quietly missing a sleeve its own architecture had called for.

So the join must **pass empties forward, not filter them**. `status: 'empty' | 'partial'` plus `note`
rides on the artifact, and the receiving desk is told what did not come back — an unfilled sleeve is
a decision (widen it, drop it, reallocate its weight), and one Atlas cannot make without being told.
A generic conveyor loses this by default; it is the single most important thing to carry over.

---

## 6. What stays where

| | Owner |
|---|---|
| Order, fan-out, mount policy, advance | the pipeline service (data + one conveyor) |
| What an artifact *says* (lens, constraints, horizon) | the emitting agent |
| How to open on an artifact (`brief`) | the receiving agent |
| Whether to advance | the user (manual) or the mode (auto), never an agent |

No agent learns another agent's name. Axl stays a launcher — the conveyor is a belt the user pushes,
not an autonomous router (see `project_axl_agent`: routing was abandoned deliberately).

---

## 7. Migration order

Each phase deletes the per-hop state it replaces from `MainPage`; nothing is left running twice.

0. **Rule (a), standalone. — DONE (not live-verified).** `src/services/pipeline/scanOrigin.js`
   answers "which desk asked for this scan" from the inbox alone, and `handleGenerateList` saves
   only when the answer is the user. Independent of the conveyor; the invariant it establishes
   (`saved ⟺ empty inbox`) is what the envelope later relies on, and it is the first file of the
   pipeline service.

   "Hide Update list mid-run" turned out to need **no code**: `editingScanId` is only ever set from
   `chatRestore.scanId`, and both inbound hops (`handleOpenArgus`, `_screenSleeve` on entry) bump
   `scannerResetKey`, remounting Argus with it null. Mid-run refinement was already unreachable.
   Worth knowing before anyone "fixes" it.

1. **Envelope + contracts + conveyor + the trade desk. — DONE (not live-verified).**
   `artifact.js` / `hop.js` / `contracts.js` + `scanner.contract.js` / `kairos.contract.js`.
   `MainPage` gained `emitArtifact` + `_applyHop` and lost `scanHandoff`, `kairosScanResult` and
   `buildScanSeedMessage`; `scanInbox` / `kairosInbox` hold artifacts instead. Single-pick mode is
   now derived (`scanInbox?.kind === SCAN_REQUEST`) rather than a flag, and `handleBuildFromCandidate`
   feeds Kairos the SAME artifact the live hop does — one inbox, not one per source.

   The mode toggle is live in the agentbar. Auto is implemented where the hops actually settle: each
   panel hands its emission over once the turn ends instead of rendering the offer, and asks the
   conveyor first (`viaUser: false`), so a gate still refuses. A refused hop keeps the offer rather
   than losing it.

   `scannerSeed` survives as the delivery channel for `deliver: 'seed'` — it is the mechanism, not a
   per-hop payload. `_screenSleeve` now composes its brief through `contractFor('scanner').brief()`
   (the inversion, applied) but still applies its own hop: its remount discipline is per-sleeve, and
   that is phase 4's to move.

   Known gap, unreachable today: if auto is refused mid-run the panel has no offer to fall back to
   until the user flips to manual. No step on the trade desk is gated, so it cannot fire yet; the
   real fix is §4's "no artifact → drop to manual", which lands with the fan-out work.
2. **Assist + Research + Scan desks. — DONE (not live-verified).** `mentor.contract.js` (accepts a
   candidate, `deliver: 'seed'`, words its own opening turn — and says where a name came from
   rather than calling it "my own trade", which would have Mentor pressure-test a plan nobody has
   made) and `analyst.contract.js` (accepts a candidate list, emits a coverage set,
   `deliver: 'artifact'`). No behaviour changed: neither desk routes anything yet.

   The claim is now a test — inserting a scan step in front of the assist desk makes it route, with
   no agent edited, and the backward leg comes free. Also added: every kind emitted is accepted by
   someone and vice versa, with Atlas's two loose ends named explicitly so phase 4 empties the list.

   **It found a real bug.** A third acceptor of `candidate_list` broke the outside-a-pipeline
   fallback: routing by capability alone was only ever unambiguous while Kairos was the sole taker.
   Editing a call and then asking Kairos for another name would have silently done nothing. Fixed by
   BORROWING the emitting desk's own chain when no pipeline is active — a desk's pipeline knows
   which of three acceptors comes next, and nothing else does. The borrowed chain routes but does
   not stamp a step, since the user never entered it.

   Worth knowing before phase 3 argues about it: Prometheus already paces its own queue internally
   (one name per turn, the rest named in the prompt so it can pace itself, the unqueued pool carried
   so "do KLAC as well" works). The `each` fan-out partly exists there already, woven into the
   prompt text rather than just the iteration.
3. **Argus → Prometheus. — DONE (not live-verified), and it changed the plan.** `analystScanResult`
   is gone; Prometheus takes a `candidate_list` artifact from all three producers, so it has ONE
   inbox however the names reached it. Names are the `items`, the frame is the `context`
   (`queued` / `pool` / `bySector` / `sector`), and Argus's read now rides on the item it belongs
   to rather than on the envelope — a list carries one per candidate.

   **The hop is delivered, not routed, and that is a finding.** A `candidate_list` leaving Argus
   means Kairos on the trade desk and Prometheus on the portfolio desk; the artifact cannot say
   which, because the difference is not in the names but in what they are FOR. Routing it would
   misroute an investing candidate clicked while the trade desk happens to be open, and "the desk I
   am standing on" is the wrong answer when the user came from a saved list.

   That is exactly the `startAt(pipeline, step, artifact)` gap already recorded in §8 — sending a
   list to research is ENTERING the portfolio pipeline at its Research step, not advancing along
   whatever chain is open. Until that exists the intent lives in the button the user pressed. So
   what phase 3 bought is the shape, not the routing, and the routing needs `startAt` rather than
   more cleverness in `planHop`.

   `each` was not needed: Prometheus already paces its own queue, and its pacing is woven into the
   prompt text (which name, what follows it, what is on the list but unqueued), not just the
   iteration. Moving that to the conveyor would have split one behaviour across two files to no end.
4. **Atlas → Argus → Prometheus → Atlas.** The sleeve run: fan-out, join, empty, partial, and the
   two refs. Last because it exercises everything, and because it is the one with a scar per branch.

Tests per phase (`pipelineNav.test.jsx` is the precedent): advance, fan-out/join, empty-carries-
forward, gate-blocks-auto, no-artifact-drops-to-manual, abort-pins.

## 8. Decided-and-deferred

Recorded so they are not re-litigated. Each was discussed, decided, and put off — none is an
oversight, and none blocks the phases above.

**Reviewing a mid-run list.** Rule (a) removes the review surface for sleeve lists: they are not in
the Scans tab and the crumb is display-only (`PipelineCrumb`, `MainPage.jsx:83` — spans, no click
handler). Getting back to Argus still works via the back button, one step at a time, and Argus holds
every sleeve in one transcript because it only remounts on *entering* a run. **Accepted:** a mid-run
list is transcript-only for now. When review is built, the natural home is the run itself — each
crumb step showing what it produced, persisted or not — and completed steps become clickable, since
the run already knows which ones have an artifact.

**Editing a mid-run list.** Not supported. Editing stays where the list is: the Scans tab, user
scans only.

**Adding a name after the hop.** Two cases, and only one needs anything built. A name Argus already
surfaced is *already* solved without walking back — `analystScanResult.pool` is "everything screened
— 'also do KLAC' reads from this" (`MainPage.jsx:2169`) — the user says it to Prometheus where they
stand. A genuinely new name needs artifact amendment, which is deferred. When it lands, the intended
policy is **additive delta**: the revised artifact re-hops carrying only what is new, downstream
appends, and **a re-hop never re-runs completed work** (otherwise one added name re-researches
twelve). With one asymmetry — *additions can be silent, removals cannot*: dropping a covered name
changes the book, and Atlas has to be told, for the same reason an empty sleeve is a result (§5).

**Thread provenance.** A mid-run screening thread is never linked (nothing is saved to link it to),
so it stays an unlinked draft in Argus's own drawer and TTLs away — the zero-work default, and
correct for an abandoned run. The better end state is retroactive: the run collects each step's
`threadId` and links them all to the artifact the run produces when it is created, so "why is KLAC
in my book" reaches back through the screen that found it. The run shape should carry a `threadIds`
field from the start — unused for now — so this needs no re-plumbing later.

**Entering a pipeline mid-way. — BUILT (not live-verified).** `planEntry({steps, agent, artifact})`
+ `enterPipelineAt(pipelineKey, agent, artifact)`. Promoted from "later, if worth it" the moment
phase 3 found that two live hops need it: routing a `candidate_list` out of Argus is undecidable
from the artifact, and entering says what routing could not.

The step is named by **agent, never index** — an index is the one thing a reorder silently breaks
(move Research ahead of Screen and every caller quoting `2` enters the wrong desk, with nothing to
catch it). Named, the entry point moves with the step, which is the property the whole design
exists to have. There is a test for exactly that.

- a sleeve (`handleResearchList`) enters **portfolio @ analyst** — Mandate and Screen are skipped
  because the names already exist
- one name (`handleResearchCandidate`) enters **research @ analyst** — a single ticker is a
  coverage question, not the start of a book

Answering the open question: Atlas is **not** cut out. The user can walk back from Research to
Screen to Mandate, and Prometheus hands the coverage forward to Atlas at the end either way
(`handleSleeveResearched`). A test pins the backward path, since it is what makes skipping safe.

Refuses when the named desk does not accept the kind, so a wrong pairing is a caller's `false`
rather than a panel handed something it cannot read.

## 9. Open

- **Desk keys are stated three times** — `DESKS[].key`, the `<route>` tags in
  `axl_system_prompt.md:220`, and `EDIT_KIND_DESKS` in `axl.controller.js:86`. Cross-repo, so a
  shared constant is a copy either way; at minimum a test asserting the three lists match.
- **Auto-mode default** — per run only, or a remembered per-user preference? Per run to start.
- **Resume** — a run is session-scoped. `ref`-carried artifacts survive as entities; an interrupted
  auto run does not. Persisting runs is a later question, not a blocker.
