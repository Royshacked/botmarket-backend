# Kairos + Hermes — Discretionary-Trader Roadmap

Living checklist for making the **Kairos** build agent and the **Hermes** monitor behave more like a
real discretionary trader. Grew out of a gap review (see "The 14 gaps" at the bottom). This doc tracks
the three items we designed — the **out-of-zone momentum pulse**, **re-entry via social chat**, and
**session-timing as a Hermes factor** — plus the still-open items for later.

**Status legend:** ✅ shipped (uncommitted) · 🔵 designed (this doc) · ⬜ open · ➖ partial

---

## Foundation already shipped (uncommitted, pending live-test + commit)

- ✅ Kairos de-biased from reversal-only → **discretionary multi-scenario** (primary + contingency);
  continuation counts equal to reversal (indicators still `confirming`-only).
- ✅ **Above-price breakout zones** first-class + sized as a *window* (Option A).
- ✅ Hermes **proximity polling** (`_proximityGapMin`) so a fast break isn't sampled over (Option B).
  → ➖ partially closes **Hermes #4** (coarse trigger detection); intrabar/wick blind spot remains.
- Tests: 495/495 unit pass. See memory `project_kairos_momentum_scenarios`.

These are the spine the three items below build on (breakout zones + proximity + the `edit`/`edit_proposal`
re-map path).

---

## Priority 1 — Out-of-zone momentum pulse  ✅ built (uncommitted, not live-verified)  (closes Hermes #1 + #2)

> **Status 2026-07-16:** code + 7 tests landed in `hermes.monitor.service.js` + `hermes.assess.js` +
> `hermesMonitor.test.js`; full unit suite 502/502. NOT committed, NOT live-verified. FE-awareness: new
> journal `reason: 'momentum_pulse'` (same entry shape as a zone_trip/expiry assessment; fires the
> existing edit re-map card — no contract change).

**Gap:** Hermes only wakes the LLM when price is inside a Kairos-mapped zone (or at expiry). If the
setup develops at a level the plan didn't draw, Hermes never looks (#1), and it can only re-map at
expiry, not mid-life (#2). A discretionary trader watches the whole chart and redraws levels live.

**Design:** a **gated cascade with early exits** (NOT stages every wake runs through). Two free
arithmetic gates reject ~all quiet wakes; a genuine, throttled move earns **one full visual read** that
can re-map the trade.

```
WAKE
 ├─ Tier 1 (free): price in a mapped zone?        → in-zone assessment (exists)
 ├─ Tier 1.5 (free): material move since anchor?  → no → cheap reschedule  (most wakes end here)
 │        + throttle (don't re-fire on every new high)
 └─ Tier 2 (rare, full VISUAL read, reason 'momentum_pulse'):
        "something's happening off-map — real or noise?"
          ├─ noise  → journal, reschedule
          └─ re-map → edit card: fresh entry zone + invalidation + targets
```

**Scope:** pre-entry readiness path only (`_checkCall` scheduled branch). In-position management
(`_checkPosition`) is out of scope. Catches a material move **either direction** (runaway breakout OR
breakdown through where the idea would be wrong).

**New `monitor_state` fields**
| Field | Type | Purpose |
|---|---|---|
| `pulse_anchor_px` | number\|null | Price where we last "had eyes." Seeded on first wake; reset after every pulse AND after every in-zone assessment. Move-filter measures distance from this → slow grind accumulates instead of resetting each wake. |
| `last_pulse_at` | ISO\|null | Time-throttle so a fast tape can't fire back-to-back pulses. |

**Constants (tunable, start conservative)**
- `MOVE_BANDS = 4` — material = move ≥ 4× nearest zone's band width from anchor (band = free volatility yardstick, reused from `_proximityGapMin`; no ATR fetch).
- `MIN_PULSE_GAP_MIN = 20` — never pulse more than ~once / 20 min / call.

**Tier 1.5 — `_shouldPulse(call, price, nowMs)`** returns true only when ALL hold:
1. Price outside every zone (in-zone = Tier 1's job; near-zone = proximity's job).
2. `pulse_anchor_px` set AND `|price − pulse_anchor_px| ≥ MOVE_BANDS × nearestZoneWidth`.
3. `nowMs − last_pulse_at ≥ MIN_PULSE_GAP_MIN` (or no prior pulse).
4. At least one finite-band zone exists (else no yardstick → never pulse).
- Anchor seeding: null anchor → set to current price, do NOT pulse (first move measured from where watching began).
- Throttle reset: every pulse sets `pulse_anchor_px = price`, `last_pulse_at = now`.

**Tier 2 — the read.** Reuse `deps.assess(call, null, { reason: 'momentum_pulse', price }, deps)` — same
chart-image + candles + news + market pipeline as the in-zone/expiry read (already handles `zone = null`).
Add a reason-specific mandate to the user turn when `reason === 'momentum_pulse'`:
> "Price has moved materially AWAY from your mapped zones. Look at the chart: is this a real development
> the plan didn't map (breakout/breakdown) or noise? If real, RE-MAP — propose a fresh entry zone plus
> new invalidation and targets so the trade has a risk frame — via verdict `edit` + `edit_proposal.changes`.
> If noise, verdict `wait` and say why. Do NOT propose entering without an invalidation and a target."

No new JSON shape — leans on the existing `edit` verdict + `edit_proposal.changes`.

**Output routing**
- `edit` + edit_proposal → fire the existing **edit/attention card** (`_applyAssessment` edit path, `_nextStatus('edit') → 'expiring'`).
- `wait`/`stand_aside`/noise → journal one line, reschedule.
- `enter` (out-of-zone) → **NOT honored in v1** (`_finalizeProposal` snaps stop/TP to the call's *existing* refs, which the pulse's new levels aren't in yet → stale snap). Force re-map-via-card; the pulse proposes, never silently opens. v2: auto-arm the proposed zone once trusted.
- Any verdict → reset anchor + `last_pulse_at`.

**Hook — `_checkCall` scheduled branch**
```
if (reason === 'scheduled') {
    if (pulse_anchor_px == null)  → seed = price, cheap reschedule, return
    if (_shouldPulse(...))        → Tier 2 assess('momentum_pulse'); route edit→card / else→journal;
                                     reset anchor + last_pulse_at; return
    else                          → existing _scheduledPatch(call, nowMs, false, price)
}
```
Also add `'monitor_state.pulse_anchor_px': price` to the in-zone expensive-path `set` (reset after eyes-in-zone).

**Tests** (mirror `hermesMonitor.test.js`)
- `_shouldPulse`: material move trips; sub-threshold no; in-zone → false; no anchor → false (seed); throttled → false; no finite-band zone → false; direction-agnostic.
- `_checkCall`: first wake seeds anchor no-assess; material+not-throttled → `deps.assess('momentum_pulse')`, anchor+time reset; `edit` → card + status `expiring`; `wait` → journal + reschedule no card; sub-threshold → cheap path no assess.
- Regression: far-price scheduled test still reschedules (anchor seeds, move-from-anchor 0 → no pulse).

**Honest caveats**
- The move-filter is now the SOLE cost governor → needs the throttle (done via anchor reset) or a trending name pulses on every new high.
- `MOVE_BANDS=4` / `MIN_PULSE_GAP_MIN=20` are guesses — watch the journal, calibrate.
- Verify at implementation: exact shape of how `edit` + `edit_proposal` is persisted/carded, so the pulse's card is byte-identical to an expiry-review edit card.

**Build checklist**
- [x] Add `pulse_anchor_px`, `last_pulse_at` to `monitor_state` (seed on first scheduled wake; reset after every pulse AND every in-zone assessment).
- [x] `_nearestZoneWidth(call, price)` helper.
- [x] `_shouldPulse(call, price, nowMs)` + constants (`PULSE_MOVE_BANDS=4`, `PULSE_MIN_GAP_MIN=20`), gated to `status==='waiting'`.
- [x] Reason-aware `_PULSE_MANDATE` in `_defaultAssess` user turn for `momentum_pulse`; browse-confirm skipped for pulses.
- [x] Pulse handler block in `_checkCall` scheduled branch (seed → pulse → cheap; edit→card / else→journal; enter coerced→wait; reset anchor + throttle).
- [x] Reset anchor in the in-zone expensive-path set.
- [x] Tests (7 new); full suite 502/502 green.
- [ ] CODE_MAP.md: note the 3-tier readiness cascade (pending docs cycle).
- [ ] FE: recognize `momentum_pulse` journal reason (label/icon) when next touching the timeline.

---

## Priority 2 — Re-entry via social-chat prompt  ✅ backend built (uncommitted; FE card pending)  (closes Kairos #6)

> **Status 2026-07-16:** backend built + 11 tests (513/513 suite). Monitor detects a stop-out
> (`_isStopOut`) → one-shot `_defaultAssessReentry` thesis check → intact fires `call_reentry` card
> (`notifyCallReentry`) + `position_state.reentry` marker; broken/failed → journal, no card. Actions:
> `reviveCall` (`reentry` action → revive to `waiting`, clear position, re-seed pulse anchor, extend
> valid_until, bump `reentry_count`) + `declineReentry` (`decline_reentry` → keep closed). **REMAINING
> = FE:** render `call_reentry` message + [Re-enter]/[Close] buttons in the call pop-out wired to the
> two actions. Deferred: optional `thesis_invalidation` reference kind.

**Gap:** Kairos maps ONE `invalidation` = the stop, and every stop-out is terminal for the call. A pro
distinguishes a *trade* stop (thesis intact → hunt the re-entry) from a *thesis* stop (idea dead →
abandon), and re-enters a still-valid idea 2–3 times.

**Design (human-in-the-loop — the human tap IS the re-entry budget, no coded counter needed):**
1. Stop fires (trade invalidation) → position closes as today.
2. **Hermes runs a quick thesis check at the close:** trade-level stop (thesis intact) vs thesis broken?
3. **Thesis intact** → fire a `reentry_prompt` card to **social chat, Kairos-voiced** (persona the user
   knows, generated by the Hermes monitor): *"Stopped at 248. Thesis still looks intact — [why]. Re-enter
   or close?"* with **[Re-enter] / [Close]**; optionally Hermes proposes the re-entry levels (re-arm
   originals or fresh via re-map).
4. **[Re-enter]** → call revives to a pre-entry armed state (status → waiting/watching, zones re-armed),
   normal monitor resumes. **[Close]** → terminal.
5. **Thesis broken** → no prompt; close with a "thesis broken" note.

**Reuse:** the social-chat card system already routes entry_confirm / call_expiry / invalidation_alert to
the kairos bot with actions — `reentry_prompt` is a new card type in that lane. "Revive + propose levels"
= the pulse's re-map machinery. **Depends on Priority 1** (re-map spine).

**The one genuinely new piece:** a **Hermes read triggered at stop-out**. Today `_reconcilePosition`
finalizes the close *mechanically* (no LLM). Need a hook: stop closes a position → cheap thesis check →
decide alive/dead → fire the card (or not).

**Optional sharpener:** let Kairos mark one reference level `kind: 'thesis_invalidation'` (structural
"idea void" level, distinct from the stop) so Hermes's alive/dead call has a concrete anchor. Light
schema add, not a rule. Take or leave.

**Honest caveats**
- Only failure mode is nagging on a chop-fest. Self-limiting (each needs a human tap AND Hermes only asks
  when thesis intact). Add a soft cap ("asked twice, go quiet") only if it feels spammy — ship without.

**Build checklist**
- [x] Stop-out hook in `_checkPosition` (after reconcile-close persist) → `_maybeOfferReentry` → thesis check.
- [x] `_defaultAssessReentry` read (`thesis_alive` + `why` + `read`; reuses `_runAssessment`).
- [x] `call_reentry` card (`buildCallReentry`/`notifyCallReentry`, kairos-bot voice) + `_isStopOut` gate.
- [x] `reviveCall` on [Re-enter] (→ `waiting`, clear position, re-seed pulse, extend valid_until, `reentry_count++`); `declineReentry` on [Close]; controller actions `reentry`/`decline_reentry`.
- [ ] (Optional/deferred) `thesis_invalidation` reference kind in Kairos schema + prompt.
- [x] Tests (11): stop vs tp/manual; intact → card + marker; broken → no card + stand-down journal; read-fail → no card; revive/decline guards; validity horizon.
- [ ] **FE:** render `call_reentry` message + surface `position_state.reentry` in the call pop-out with [Re-enter]/[Close] wired to the `reentry`/`decline_reentry` actions.

---

## Priority 3 — Session-timing as a Hermes holistic factor  ✅ built (uncommitted)  (closes Kairos #7)

> **Status 2026-07-16:** built + 5 tests (518/518 suite). `sessionPhase(symbol, assetClass, date)` in
> `market.service.js` (asset-class-aware, DST-correct via `_etWall`; crypto/FX→`24h`, index futures use
> RTH texture + `overnight`, equities get opening/mid/lunch/power/into-close + pre/after-market/closed).
> Fed as `SESSION NOW` into the readiness + position user turns; both system prompts weight it as a lens
> (24h carve-out). Re-entry read intentionally omitted (thesis-alive isn't time-sensitive).

**Gap:** the same setup has different odds at 9:45 vs lunch vs power hour. Kairos has `trade_type` +
`valid_until` + intraday cycle mode but no session-clock sense, and Hermes (which pulls the trigger)
doesn't weight time-of-session. **Decision: Kairos builds the general setup; Hermes weighs the session as
one holistic input** (agent-decides, no hardcoded rules).

**Design (prompt + light plumbing, asset-class-aware)**
- **Prompt:** add session-of-day to Hermes's assessment as a holistic consideration — *"a breakout in the
  lunch lull is suspect; too late to initiate an intraday near the close; opening range and power hour
  carry more weight."* Asset-class-aware: equity RTH has this texture; **crypto/FX are 24h → session bias
  immaterial**; futures RTH vs globex.
- **Plumbing:** feed the assessment an explicit **current-time + session-phase label** from `asset_class`
  + current time: `opening | mid | lunch | power | into-close | after-hours | 24h`. Monitor already knows
  open/closed (`isAssetOpen`), so a small extension. Without it Hermes can infer from candle timestamps,
  but the explicit label is reliable.

**Honest caveat:** the multi-asset trap — never apply equity-session logic to BTC. The `24h` phase label
+ prompt line ("session texture immaterial for 24h assets") handles it.

**Standalone** — no dependency on P1/P2. Smallest of the three.

**Build checklist**
- [x] `sessionPhase(symbol, assetClass, date)` → coarse label (asset-class-aware, DST-correct via `_etWall`).
- [x] Pass `SESSION NOW` into both assess user turns (readiness + position).
- [x] Prompt lines weighting session holistically (a lens, not a veto), with the 24h carve-out.
- [x] Tests (5): equity RTH phases + pre/after/weekend; crypto/FX → `24h`; futures RTH vs overnight; symbol fallback.

---

## Suggested build order

1. **Priority 1 (pulse)** — builds the re-map spine everything else reuses.
2. **Priority 2 (re-entry)** — reuses the spine; adds the stop-out thesis hook.
3. **Priority 3 (session)** — small, standalone, drop in anytime.

---

## Still open — the rest of the 14 gaps (not in this doc's scope)

Highest-leverage remaining:
- ⬜ **Kairos #1 ↔ Hermes #3 — planned exits / scaling.** Author a scale/trail ladder in Kairos
  (`size_pct` currently null on every target), execute it in Hermes (today it improvises the whole exit).

⏸️ **DEFERRED (2026-07-16) — the whole risk & sizing cluster. User owns the design decision first**
(risk budget, conviction multiplier, whether book-heat lives in Kairos or Atlas). Do NOT build until the
user specifies the shape. Covers:
- ⏸️ **Kairos #2 ↔ Hermes #6 — conviction-scaled sizing.** Enter proposal has no `size` field →
  everything fills to the `max_size` cap; `conviction` is decorative. Wants: `size = risk_budget ×
  conviction / stop_distance`, capped at `max_size` (the `risk_basis:'stop_distance'` intent is already
  in the schema, just unexecuted).
- ⏸️ **Kairos #3 — book/heat awareness.** Each call built in isolation; no cross-call correlation or
  total-open-risk check. Natural extension of the sizing engine (correlation-discount + heat-clamp).
- ⬜ **Kairos #4** — thin thesis/edge (no "why the inefficiency / who's on the other side").
- ⬜ **Kairos #5** — liquidity/tradability gate (spread / ADV).
- ⬜ **Hermes #5** — company news is cached headlines, not live at decision time.
- ⬜ **Hermes #7** — breakeven-after-+1R slightly mechanical vs structure-based stop moves.
- ➖ **Hermes #4** — coarse/intrabar trigger; partially helped by proximity polling.

---

## Appendix — the 14 gaps (original review)

**Kairos:** 1 exits-not-planned · 2 conviction-decorative-for-sizing · 3 no-book/heat · 4 thin-thesis ·
5 no-liquidity-gate · 6 entry-vs-thesis-invalidation (→ P2) · 7 intraday-session-timing (→ P3).

**Hermes:** 1 blind-outside-zones (→ P1) · 2 no-live-re-mapping (→ P1) · 3 exit-plan-anchor ·
4 coarse-trigger (partial) · 5 news-cached · 6 no-conviction-sizing · 7 BE-mechanical.
