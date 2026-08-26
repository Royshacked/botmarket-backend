# Architecture Vision — House vs Per-User Pipeline

**Core principle:** Does the process need to know WHO the user is?
- No → house layer (runs once, writes to DB, all users read)
- Yes → user layer (scoped to user + workspace)

**Role split:**
- `admin` — can author house-layer outputs (tilt, coverage batch, channel graph) and access admin-gated desks (Pythia, Argus→Prometheus feed, Prometheus lifecycle, Aether feed controls)
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
| **Aether** | Scheduled + admin-curated | Admin authors; all users read | Channel states, K matrix, exposure matrix, sector/name feed |
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
| Aether surfaced the name → Prometheus covered it | Yes | Thesis + PT + exposure score + lag profile + channel attribution |
| Direct research (user request via Atlas, Argus scan, Pythia-convicted sector) | No | Thesis + PT + qualitative conviction only |

Atlas allocates from a mixed pool. The Aether exposure score is optional
enrichment, not a required field. When present, it is weighted; when absent,
Atlas falls back to the qualitative conviction score alone. Names without an
Aether score are not second-class — they have a different evidence basis.

Atlas should be transparent about which backing a name has:
- `conviction: thesis + quantitative channel exposure` — Aether-backed
- `conviction: thesis only` — direct research, no Aether signal

Allocation weight draws from both sources:
```
allocation_weight = f(
  coverage_conviction,      // always present
  PT_upside,                // always present
  aether_exposure_score,    // present if Aether surfaced the name
  aether_lag_confidence,    // present if Aether surfaced the name
  channel_correlation       // portfolio-level: cap gross exposure per channel
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

Admin-authors the channel graph. All users see a read view (TBD — exact UI not yet defined).

**What Aether does:**
- Maintains the channel graph (nodes, edges, weights, K matrix)
- Feeds **sectors → Pythia** so Pythia can validate tilt against channel pressure scores
- Feeds **names → Prometheus** so uncovered names with quantitative channel exposure get
  added to the research queue
- Exposes the channel state and exposure matrix to Atlas and Mentor as enrichment

**User-facing surface:** TBD. At minimum, users should be able to see which channels
are active and how a name they care about sits in the graph. Exact UI to be designed.

---

## 4. The Full Pipeline

```
Aether (channel graph) ──→ sectors ──→ Pythia (macro conviction, admin)
                       └──→ names ───→ Prometheus research queue
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

## 5. How the Channel Engine Feeds Each Desk

See `docs/design/channel-graph-build-spec.md` §4 for the full contract. Summary:

### Pythia — validator, not discoverer

Engine hands Pythia: channel pressure scores by sector, regime signals, what is
moving and why. Pythia's job is judgment — does the channel state support this
regime label? Is it already priced? What kills it?

Pythia can say NO. If the coverage book is thin or the move is already priced,
she publishes neutral and states why. **Pythia is what turns the engine's output
into a position the house is willing to be graded against.**

### Prometheus — thesis backbone

Engine hands Prometheus: which channels hit a specific name, elasticity estimate,
lag profile, 2nd/3rd order supply-graph connections. Prometheus adds what the
engine cannot — management quality, moat, price target, rating, catalysts, risks.

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
| Structural channel shift | Months–quarters | Atlas | Position — own the exposure |
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
- Channel engine edge governance — K admission process (`channel-graph-build-spec.md` §8)
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

## Related

- `docs/design/channel-graph-build-spec.md` — channel engine full build spec
- `docs/desks/trade-pipeline.md` — Mentor pipeline detail
