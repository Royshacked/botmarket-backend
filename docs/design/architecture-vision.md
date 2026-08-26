# Architecture Vision — House vs Per-User Pipeline

**Core principle:** Does the process need to know WHO the user is?
- No → house layer (runs once, writes to DB, all users read)
- Yes → user layer (scoped to user + workspace)

The monitors and reconciler always run across all workspaces. The workspace
is a UI/authoring scope, never an engine filter.

---

## 1. House Layer

Runs once, shared across all users. No user identity involved.

| Process | Trigger | Output |
|---|---|---|
| **Pythia** | Monitor cadence / macro catalyst | One published tilt in DB — all users read the same view |
| **Argus** (house mode) | Pythia publishes / updates tilt | Candidate list → Prometheus research queue (no human step) |
| **Prometheus** | Argus candidate queue | Coverage theses in DB — owner-blind, all users read |
| **Channel engine** | Scheduled | Channel states, K matrix, exposure matrix, forecasts in DB |
| **Market Brief** | Daily, market open | One brief per TTL, cached across users |

**The tilt is the mandate.** When Pythia publishes, Argus kicks off automatically
→ Prometheus queue → coverage in DB. No human is needed until Prometheus
confirms the coverage draft.

---

## 2. User Layer

Per-user, reads from the house layer. All per-user work is scoped to a
workspace (live / paper / manual).

### Atlas — three flows, no forced phases

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

**Coverage rule:** if coverage does not exist for a requested name → Prometheus
researches it and puts it in DB. Same trigger regardless of which flow surfaced
the name.

**Coverage has two origins — Atlas must handle both:**

| Origin | Has Aether signal? | What's present |
|---|---|---|
| Aether surfaced the name → Prometheus covered it | Yes | Thesis + PT + exposure score + lag profile + channel attribution |
| Direct research (user request, Argus scan, Pythia-convicted sector) | No | Thesis + PT + qualitative conviction only |

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
scans all covered names, only names inside convicted sectors. An
Aether-surfaced name reaches the mandate pool naturally if it is covered and
its sector is convicted. No separate routing path needed.

### Argus — three triggers, no pre-market scheduled scan

1. **Pythia-triggered** — tilt published → Argus auto-scans convicted sectors →
   candidate list → Prometheus queue
2. **User scan** — user asks Argus against their own criteria → personal scan
   list → can feed Mentor
3. **Mentor helper** — user building a trade with Mentor → turns to Argus
   mid-session to find or confirm a name

### Mentor

Per-user setups and trades, scoped to user + workspace. Reads Argus scan lists.
Constructs entry / stop / target from engine signals and Argus candidates.

---

## 3. The Full Pipeline

```
Pythia (macro conviction)
  + Channel engine (quantitative exposure)
         ↓
       ARGUS  ← shared discovery engine
      ↙      ↘
Coverage      Setup/scan candidates
candidates    (for Mentor)
    ↓
Prometheus → coverage in DB
    ↓
Atlas (allocates from pre-researched pool)
Mentor (builds setups from scan lists)
```

---

## 4. How the Channel Engine Feeds Each Desk

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

The same event, at different hops, routes to different desks. The exposure
matrix's `lag_profile` makes this deterministic:

| Signal | Lag | Desk | Nature |
|---|---|---|---|
| 1st / 2nd order repricing gap | Days–weeks | Mentor | Setup — trade before gap closes |
| Structural channel shift | Months–quarters | Atlas | Position — own the exposure |
| Regime change | Quarters | Pythia → Atlas | Tilt — rebalance the book |

The Hormuz 1st-order airline trade is Mentor. The 3rd-order regional bank play
is Atlas. Not a judgment call at routing time — read off `lag_profile`.

---

## 5. The Flywheel

```
engine surfaces uncovered 2nd/3rd order name
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
less per-user computation at every desk. Coverage researched once is read by
Pythia, Atlas, Mentor, and the coverage monitor indefinitely.

---

## 6. Token Savings

| What | How costs are reduced |
|---|---|
| Pythia | One run per review cycle, not per user session |
| Coverage | Researched once per name, consumed by every desk forever |
| Argus house scan | Event-driven (tilt change), not daily |
| Atlas | Discovery and research cost already paid — Atlas just fetches + allocates |
| Market Brief | One brief per TTL, shared across all users at market open |

What stays per-user: Mentor setups, Atlas sizing / allocation decisions,
Argus personal scans, all conversations.

---

## 7. Admin / Ops Layer (not built)

- Research queue management — names Argus surfaced, waiting for Prometheus
- Coverage lifecycle — initiate, maintain, drop
- Channel engine edge governance — K admission process (`channel-graph-build-spec.md` §8)
- Pythia re-author approval — already exists as the confirm-offer pattern

Prometheus uses draft → confirm before publishing coverage. The admin layer
manages the research queue that feeds Prometheus and governs the channel
engine's edge admission.

### 7.1 User roles

Multi-user platform. Role enum on the user record:

| Role | Access |
|---|---|
| `admin` | Ops dashboard + all trading desks. Superset of trader. |
| `trader` | Own desks + workspace. Reads house output. |
| `viewer` | Read-only. Add later if needed. |

Admin is set by an existing admin or seeded at setup. Traders cannot
self-promote. At least two admins should exist at all times — no single
point of failure on one person's session.

### 7.2 Admin absence — the pipeline must never block

The house layer runs on a schedule regardless of who is logged in. Ops
actions (research queue approvals, edge governance, coverage lifecycle) are
human gates in that pipeline — if no admin acts, the pipeline stalls silently.

**Design rule: ops actions are async approvals, not blocking gates.**

- The pipeline continues with existing state while the queue waits
- Admin is notified (in-app, email) when items need a decision
- Nothing is lost; nothing blocks traders from using the desks

**Timeout defaults** — the queue drains itself if unchallenged:

| Queue | Default | Rationale |
|---|---|---|
| Research queue item | Auto-approve after N days | Coverage is low-risk to generate |
| Provisional K edge | Auto-reject after one quarter | Edges are high-risk to add |
| Coverage drop | Requires explicit admin action | No safe default for deletion |

Admin is the override, not the gatekeeper. A logged-out admin should be
invisible to traders — they see slightly stale coverage until the queue
drains, nothing more.

---

## Related

- `docs/design/channel-graph-build-spec.md` — channel engine full build spec
- `docs/design/opportunist-desk.md` — Tyche desk design (reads engine output, builds lag-trade candidates)
- `docs/desks/trade-pipeline.md` — Mentor pipeline detail
