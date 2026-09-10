# Architecture Vision — House vs Per-User Pipeline

> **Revised 2026-09-10.** Aether's channel-graph engine was deleted, not paused — it was
> measured against held-out data and did not work. Every section describing Aether now
> describes what it actually does: identify the companies a named event reaches, and quote
> what their own filings say. The paragraphs that still name channels are the record of why
> that engine went, which is worth keeping; nothing in this document describes it as
> something that runs. `channel-graph-build-spec.md` went with the code.

**Core principle:** Does the process need to know WHO the user is?
- No → house layer (runs once, writes to DB, all users read)
- Yes → user layer (scoped to user + workspace)

**Role split:**
- `admin` — can author house-layer outputs (tilt, coverage batch) and access admin-gated desks (Pythia, Argus→Prometheus feed, Prometheus lifecycle, Aether discovery runs)
- `trader` — all trading desks + workspace. Reads house output. Can trigger single-name on-demand research through Atlas.

The monitors and reconciler always run across all workspaces. The workspace
is a UI/authoring scope, never an engine filter.

---

## 1. House Layer

Runs once, shared across all users. No user identity involved.
Admin is the human gate for house-layer authoring; the pipeline continues with
existing state while the queue waits.

| Process | Trigger | Who can trigger | Output |
|---|---|---|---|
| **Pythia** | Monitor cadence / macro catalyst / admin on-demand | Admin only | One published tilt in DB — all users read the same view |
| **Argus** (house mode) | Pythia publishes / updates tilt | Admin only (auto from Pythia) | Candidate list → Prometheus research queue |
| **Prometheus** (batch) | Argus candidate queue | Admin only | Coverage theses in DB — owner-blind, all users read |
| **Aether** | Admin presses Run discovery | Admin runs; all users read | Event candidates — companies a named event reaches, each with a filing sentence |
| **Market Brief** | Daily, market open | Automated | One brief per TTL, shared across all users |

**The tilt is the mandate.** When Pythia publishes, Argus kicks off automatically
→ Prometheus queue → coverage in DB. No human is needed until Prometheus
confirms the coverage draft.

---

## 2. User Layer

Per-user, reads from the house layer. All per-user work is scoped to a
workspace (live / paper / manual).

### Atlas — three flows + one on-demand path, no forced phases

1. **Mandate build** — user activates a mandate → Atlas reads the Pythia tilt
   → fetches covered names in convicted sectors → allocates. Atlas is a pure
   allocator here, not a researcher.

2. **Conviction trade** — user wants to hold one asset long-term → Atlas chats
   freely, fetches coverage for that name, looks at a chart if asked → generates
   a single-asset portfolio. No forced phases.

3. **Manual monitoring** — user provides existing names (from their bank) →
   Atlas fetches coverage per name → shows conviction / price target / risks →
   asks only for what it cannot derive (entry prices + quantities) → generates a
   monitored portfolio.

4. **Uncovered name (on-demand)** — user building a portfolio asks for a name
   that is not in coverage → Atlas hands the name to Prometheus (single-name
   on-demand research, available to all users) → Prometheus researches and
   writes coverage to DB → Atlas resumes and allocates the name. This path is
   distinct from the admin-initiated batch research queue.

**Coverage has two origins — Atlas must handle both:**

| Origin | Has Aether signal? | What's present |
|---|---|---|
| Aether surfaced the name → Prometheus covered it | Yes | Thesis + PT + the event that named it, and what its filings said |
| Direct research (user request via Atlas, Argus scan, Pythia-convicted sector) | No | Thesis + PT + qualitative conviction only |

Atlas allocates from a mixed pool. The Aether exposure score is optional
enrichment, not a required field. When present, it is weighted; when absent,
Atlas falls back to the qualitative conviction score alone. Names without an
Aether score are not second-class — they have a different evidence basis.

Atlas should be transparent about which backing a name has:
- `conviction: thesis + a disclosed exposure to a named event` — Aether-backed
- `conviction: thesis only` — direct research, no Aether signal

Allocation weight draws from both sources:
```
allocation_weight = f(
  coverage_conviction,      // always present
  PT_upside,                // always present
  aether_exposure_score,    // present if Aether surfaced the name
  aether_lag_confidence,    // present if Aether surfaced the name
  event_correlation         // portfolio-level: cap gross exposure to any one event
)
```

The mandate build pre-filter is Pythia's convicted sectors — Atlas never
scans all covered names, only names inside convicted sectors.

### Argus — three triggers, no pre-market scheduled scan

1. **Pythia-triggered** (admin / house) — tilt published → Argus auto-scans
   convicted sectors → candidate list → Prometheus batch queue
2. **User scan** — user asks Argus against their own criteria → personal scan
   list → can feed Mentor
3. **Mentor helper** — user building a trade with Mentor → turns to Argus
   mid-session to find or confirm a name

Triggers 2 and 3 are available to all users. Trigger 1 is admin-only (fired
automatically when Pythia publishes).

### Mentor

Per-user setups and trades, scoped to user + workspace. Reads Argus scan lists.
Constructs entry / stop / target from engine signals and Argus candidates.
Available to all users.

---

## 3. Admin-Only Desks

### Pythia

Admin-only desk. All users can read the published tilt and see the forecast
view, but only admins can access the Pythia chat interface or trigger a new
forecast (on-demand or cadence).

- Chat with Pythia to author / revise the macro narrative
- Trigger a forecast manually (outside the normal monitor cadence)
- Confirm / reject the draft before it publishes to the house layer

### Prometheus — coverage lifecycle

Batch research (Argus-queued) is admin-only. On-demand single-name research
(Atlas-triggered) is available to all users.

**Coverage lifecycle states (admin-managed):**

| State | Description | Who can transition |
|---|---|---|
| `queued` | Argus surfaced the name, waiting for research | Admin approves or rejects |
| `draft` | Prometheus wrote the thesis, pending review | Admin confirms or revises |
| `live` | Published coverage, visible to all desks | Admin retires or revises |
| `revised` | Admin edits an existing live thesis | Admin publishes revision |
| `retired` | Coverage dropped — name no longer in pool | Requires explicit admin action; no safe default |

**Rules:**
- Retiring coverage requires explicit admin action. No auto-timeout.
- Revising creates a new draft state; the live thesis stays visible until the
  revision is confirmed.
- On-demand single-name research (user → Atlas → Prometheus) bypasses the
  queue and goes straight to `draft`, then `live` on admin confirm.

### Aether

**It identifies; it does not forecast.** A named event goes in, and the companies it
reaches come out — each with a mechanism, a citable press fact, and whatever its own SEC
filings say. That distinction is the whole design, because the previous version did the
opposite and was deleted for it (2026-09-10).

The engine used to model the world as coupled macro channels transmitting pressure through
a matrix `K`, and forecast a company as `channel_state × exposure − priced_in`. Measured
against held-out data it did not work, from four independent directions: 13 channel→
fundamentals edges tested and 1 survived; rate channels moving a blended cost of debt ~7bp
on a 480bp base; fx scaled by read foreign-revenue share right in sign and ordering and
wrong by a factor of 5,000; channel moves against analyst revisions over 90 months showing
no decay curve. The pattern behind all four: where macro transmission is strong enough to
measure, it is obvious enough to be priced.

**What Aether does now:**
- A news queue is filled daily; an admin presses **Run discovery** when a story is worth it
- The selector triages headlines to the few that are runnable — a named subject, something
  that changed, a path to a company's revenue or costs, and an actor that is not the
  company itself
- Claude with web search proposes the companies each event reaches, both sides
- Every proposed name is verified against its own filings on EDGAR, where a sentence counts
  only if it names the subject AND carries a figure
- Survivors are ranked on evidence depth, tier, disclosed size and whether the move has
  already happened, and every drop keeps its row and its reason

**Why discovery is manual:** it is the one leg that spends per run — a model call with web
search per event, plus several hundred SEC requests. Whether today held an event worth that
is a judgement, and a schedule cannot make one.

**User-facing surface:** the Aether desk in the right column — one row per company, with
the events that named it inside. Readable by every signed-in user; only an admin can start
a run, and only on a host that has the engine.

---

## 4. The Full Pipeline

```
Aether (event exposure) ──→ names ───→ (a candidate list the desks can read)
                                  ↓
                                ARGUS  ← shared discovery engine
                               ↙      ↘
                         Coverage      Setup/scan candidates
                         candidates    (for Mentor)
                               ↓
                         Prometheus → coverage in DB
                               ↓
                 Atlas (allocates from pre-researched pool)
                                  ↑
                         on-demand: Atlas → Prometheus → Atlas
                 Mentor (builds setups from scan lists)
```

---

## 5. How the Aether Engine Feeds Each Desk

Summary:

### Pythia — validator, not discoverer

Engine hands Pythia: the events in the window and the companies each reached.
Pythia's job is judgment — does what is happening support this regime label? Is
it already priced? What kills it?

Pythia can say NO. If the coverage book is thin or the move is already priced,
she publishes neutral and states why. **Pythia is what turns the engine's output
into a position the house is willing to be graded against.**

### Prometheus — thesis backbone

Engine hands Prometheus: which events reached a specific name, the mechanism for
each, and the sentence its own filings carry. Prometheus adds what the engine
cannot — management quality, moat, price target, rating, catalysts, risks.

Engine surfaces uncovered 2nd/3rd order names → creates research demand →
Prometheus fills it → house coverage list grows.

### Atlas — position layer

Engine's structural long-lag signals (months–quarters) feed Atlas's conviction
trade flow. Long lag → Atlas builds a position, not a setup. Atlas reads
pre-researched coverage already backed by the engine's quantitative data.

### Mentor — setup layer

Engine's short-lag signals (days–weeks) feed Mentor directly. The event →
Mentor path is the fastest in the pipeline: no discovery step, no research
queue, pre-computed answer. Engine provides exposure score, lag, confidence;
Mentor constructs entry / stop / target.

### Lag determines the desk — always

| Signal | Lag | Desk | Nature |
|---|---|---|---|
| 1st / 2nd order repricing gap | Days–weeks | Mentor | Setup — trade before gap closes |
| Structural shift in a named exposure | Months–quarters | Atlas | Position — own the exposure |
| Regime change | Quarters | Pythia → Atlas | Tilt — rebalance the book |

---

## 6. The Flywheel

```
Aether engine surfaces uncovered 2nd/3rd order name
  → Argus screens it
  → Prometheus covers it → DB grows
  → Pythia cross-check improves
  → better tilt → tighter Argus filter
  → more targeted Prometheus queue
  → resolved forecasts update elasticity confidence in exposure matrix
  → edge weights in K re-estimated
  → loop
```

The DB is the primary cost-reduction mechanism. A richer shared state means
less per-user computation at every desk.

---

## 7. Token Savings

| What | How costs are reduced |
|---|---|
| Pythia | One run per review cycle (admin), not per user session |
| Coverage | Researched once per name, consumed by every desk forever |
| Argus house scan | Event-driven (tilt change), not daily |
| Atlas | Discovery and research cost already paid — Atlas just fetches + allocates |
| Market Brief | One brief per TTL, shared across all users at market open |

What stays per-user: Mentor setups, Atlas sizing / allocation decisions,
Argus personal scans, all conversations.

---

## 8. Admin / Ops Layer

- Research queue management — names Argus surfaced, waiting for Prometheus
- Coverage lifecycle — initiate, revise, maintain, retire
- Pythia re-author / trigger — already exists as the confirm-offer pattern

### 8.1 User roles

| Role | Access |
|---|---|
| `admin` | Pythia desk, Aether feed controls, Prometheus lifecycle, Argus→Prometheus feed, ops dashboard + all trading desks. Superset of trader. |
| `trader` | Mentor, Atlas, Argus (user scan + Mentor helper), reads Pythia tilt / Aether view / coverage. |
| `viewer` | Read-only. Add later if needed. |

Admin is set by an existing admin or seeded at setup. Traders cannot
self-promote. At least two admins should exist at all times.

### 8.2 Admin absence — the pipeline must never block

**Design rule: ops actions are async approvals, not blocking gates.**

- The pipeline continues with existing state while the queue waits
- Admin is notified (in-app, email) when items need a decision
- Nothing is lost; nothing blocks traders from using the desks

**Timeout defaults:**

| Queue | Default | Rationale |
|---|---|---|
| Research queue item | Auto-approve after N days | Coverage is low-risk to generate |
| Provisional K edge | Auto-reject after one quarter | Edges are high-risk to add |
| Coverage drop | Requires explicit admin action | No safe default for deletion |

Admin is the override, not the gatekeeper.

---

## 9. Implementation plan — `feat/multiuser-refactor` (branch)

### Agreed design decisions

**House pipeline (admin only):**
- Pythia forecast → Argus house scan → all schools, all cap sizes (no cap filter) → Prometheus batch research → coverage tagged with school(s)
- Coverage is house-owned (no userId). All users read. Only admin can write (CRUD).
- Every Prometheus revision updates the school tags if the fit changes.

**Atlas — four flows, no Argus in the portfolio build loop:**
- Atlas fetches directly from the Prometheus coverage pool (`get_coverage`).
- For mandate build: filter by convicted sectors (from Pythia tilt) AND mandate selection school.
- `<screen_request>` does NOT exist in the portfolio build flow. Atlas never routes to Argus for portfolio construction.
- Empty sleeve (no coverage for this sector/school) → tell the user, do not hand off to Argus.
- User explicitly asks for an uncovered name → `<coverage_request>` → research queue → Prometheus.
- `<coverage_request>` is the only Atlas → Prometheus path available to traders.

**Argus — unchanged for now:**
- Trade desk pipeline (user scan + Mentor helper) unchanged.
- Users can still chat with Argus directly.
- Argus is NOT in the Atlas portfolio build pipeline.

**Schools:**
- Source of truth: `investorSchools.js` — hyphens (`quality-value`, `growth-durability`, `income`, `passive`).
- `coverage.service.js` SCHOOLS must match (hyphens). Mandate block emits hyphens. Filter must match.
- Prometheus tags schools; Atlas reads them. Tag is a pre-filter, not a cage — Atlas still applies school judgment over each thesis.

**Aether — deferred (build last).**

---

### Step status (as of 2026-08-26)

| # | What | Status |
|---|---|---|
| 1 | Coverage pivot — house-owned, role split, admin middleware | ✅ committed (`5c12b8c`) |
| 2 | Admin pipeline — research queue, Argus house scan, Pythia gate | ✅ committed (`159e894`) |
| 3 | `school` filter on `getCoverage` + schools shown per coverage line + tests | ✅ done, uncommitted |
| 4 | `coverage_request` 4th Atlas flow — parse, enqueue, strip from reply + tests | ✅ done, uncommitted |
| 5 | Add `school` to `get_coverage` tool schema (`agentTools.registry.js`) | ✅ done |
| 6 | Fix SCHOOLS naming — align `coverage.service.js` to hyphens (matches `investorSchools.js`) | ✅ done |
| 7a | Prometheus (analyst) prompt — instruct to tag school(s) on every `<coverage>` block and update on revision | ✅ done |
| 7b | Atlas prompt Phase 4 — remove `<screen_request>` from portfolio build; add `<coverage_request>` for user-named uncovered name; instruct `get_coverage` call to filter by sector + school | ✅ done |

---

## Related

- `docs/desks/trade-pipeline.md` — Mentor pipeline detail
