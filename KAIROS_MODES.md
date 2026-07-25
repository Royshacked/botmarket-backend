# Kairos — Three Modes + Argus Ingest + Edit (design)

Kairos = ONE agent, THREE profiles. The method (analytical lens + tools + pattern vocabulary)
differs; the OUTPUT SCHEMA (the call) is identical and lens-agnostic — Hermes reads it verbatim.
`mode` is a build-time label (prompt/tool selection + UI badge); it never touches the gate or Hermes.

## Decisions (locked)
```
- Disc/SMC boundary: discretionary = CLASSICAL PA (keeps false-breaks/sweeps); order-blocks +
  FVG + BOS/CHoCH + premium/discount MOVE OUT to SMC. (Re-carves today's discretionary, which
  currently reaches for order-blocks FIRST.)
- False-breaks/sweeps = SHARED (disc: "failed breakout"; smc: "liquidity sweep").
- SMC depth = BOTH numeric engine + vision tools.
- Output schema already carries all three (entry_zones/reference_levels/patterns[].look_for are
  free-text, lens-agnostic). Add ONE `mode` field. No schema divergence (point 3 ~free).
- Monitorability (point 7): two layers — GATE (zones/levels, universal, any monitor wakes on)
  + CONTEXT (patterns/thesis + market_sensitivity, method-rich, Hermes grows into). Institutional
  positioning MUST fold into market_sensitivity/thesis (Hermes doesn't re-fetch short-int/options).
```

## The three lenses (carve on the shared prompt spine)
```
discretionary : classical PA — swing points, S/R, prior-day levels, VWAP, trend, momentum,
                chart patterns, + false-breaks/sweeps. Indicators CONFIRM. Light positioning.
                [re-carved: NO order-blocks / FVG / BOS-CHoCH / premium-discount]
smc           : strict smart-money — order-blocks, FVG, BOS/CHoCH, liquidity (equal H/L, sweeps),
                premium/discount. NUMERIC engine (exact levels) + vision. NO confirm-indicators,
                NO macro/fundamentals.
institutional : INVERTED phase order — macro/regime + relative-strength + positioning LEAD;
                candle-level triggers demoted. Positioning written into market_sensitivity/thesis.
```

## Tool allocation (subset per mode; from the tool audit)
```
discretionary : get_quote, get_price_action, get_candles, get_chart(vision), get_indicators,
                get_cycle_analysis, get_false_breaks(vision), + light: get_earnings*, get_short_interest,
                get_options_context.  [DROP get_orderblocks]
smc           : get_candles, get_quote, get_price_action, get_chart, get_false_breaks(vision),
                get_orderblocks(vision) + NEW numeric: get_fvg, get_structure(BOS/CHoCH),
                get_liquidity, get_premium_discount, get_order_blocks(numeric).
institutional : get_macro_snapshot, get_correlations, get_peers, get_sector_snapshot(WIRE from
                scanner), get_short_interest, get_options_context, get_derivatives_context,
                get_fundamentals, get_sec_filings, get_earnings + price for zone placement
                (get_quote, get_price_action, get_candles, get_chart).
```

## Per-mode tool plan — IDEAL vs AVAILABLE (FMP starter + more)

**Key leverage — we own the chart + the raw data.** KLineCharts renders server-side (any study we
overlay → vision reads it) and we hold raw OHLCV (FMP + cTrader). So the pattern for EVERY mode is
**compute numeric (exact monitorable levels) + render on KLineChart for vision (holistic confirm)**.
We are NOT limited to vendor-exposed studies — anything OHLCV-derivable is BUILDABLE (compute + overlay).
HARD gaps are only truly-external data: L2/order-flow, real-time premium positioning (GEX/dark-pool/
options-flow), institutional fund flows.

Data baseline:
```
FMP Starter : real-time quote + intraday + EOD for equity/ETF/crypto/forex (NOT futures/index →
              cTrader candles cover those, alias NQ↔US100). Macro (curve/2s10s/sector rotation),
              fundamentals, earnings, filings, peers, screen.
Yahoo (free): short interest (monthly, delayed), options (put/call ratio, ATM IV).
Binance     : crypto derivatives (funding, OI, long/short ratio).
cTrader     : index/futures candles.
KLineCharts : server-render ANY study/overlay for vision.
NO          : L2/depth, volume-profile/footprint, real-time options-flow/GEX, dark pool,
              real-time COT, institutional fund flows.
```

### Discretionary — WELL covered; enrich, no hard gaps
```
IDEAL      : multi-TF OHLCV, chart vision, classical structure (swing/S-R/pivots/prior-day-week
             levels), momentum (RVOL/ADX/Stoch/Supertrend beyond EMA/RSI/MACD/ATR/VWAP), false-breaks.
HAVE       : get_candles, get_chart(vision), get_indicators(EMA/SMA/RSI/MACD/ATR/VWAP),
             get_price_action(RVOL/range), get_false_breaks(vision), get_cycle_analysis, get_earnings.
BUILDABLE  : numeric classical-structure levels — pivots, prior-day/week H/L/C, swing detection,
             S/R clustering (EXACT monitorable levels vs today's vision estimates) + KLineChart overlay;
             indicator expansion (RVOL/ADX/Stochastic/Supertrend/Donchian/Keltner — the Tier-1 wins).
HARD GAP   : none material (classical PA is fully OHLCV-derivable). Volume-profile = nice, deferred.
```

### SMC — MOST new build (K2); structural-only is honest
```
IDEAL      : multi-TF OHLCV, chart vision w/ SMC overlays, order-blocks, FVG, BOS/CHoCH, liquidity
             (equal-H/L, pools, sweeps), premium/discount (dealing range/OTE), session liquidity
             (Asian/London/NY H/L), + ideally order-flow/L2/footprint.
HAVE       : get_candles, get_chart(vision), get_orderblocks(vision), get_false_breaks(vision/sweeps).
BUILDABLE  : K2 NUMERIC ENGINE (OHLCV + KLineChart overlays) — FVG (3-candle imbalance), BOS/CHoCH
             (swing-structure shift), liquidity/equal-H-L + sweep levels, premium/discount (range
             fib/OTE), numeric order-blocks, session H/L. All OHLCV-derivable → EXACT monitorable
             SMC levels + rendered overlays for vision confirm. First slice: FVG + structure + liquidity.
HARD GAP   : L2 / order-flow / footprint / volume-at-price — UNAVAILABLE (no L2). → "SMC-lite":
             price-STRUCTURE smart-money, not true order-flow. (Structural SMC = ~90% of retail SMC,
             fully buildable.) Honest limitation.
```

### Institutional — decent macro; delayed positioning; buildable RS/breadth/COT
```
CHART ROLE : chart-LIGHT (unlike discretionary + smc which are chart-CORE). The PRICE chart is used
             only for ENTRY/stop placement (phase 4 — every call needs entry_zones), NOT as the lens.
             REPURPOSED: since we own KLineCharts, render institutional-native visuals — RS LINE
             (stock/benchmark ratio series), RRG (RS vs RS-momentum), breadth/sector-rotation heat.
             So institutional gets get_chart(light) + a NEW get_rs_chart (render a ratio/breadth series,
             not candles) — but NOT the structure-vision tools (orderblocks/false-breaks aren't its lens).
IDEAL      : macro/regime, relative strength (stock/sector/market RS ranking, RRG), sector rotation,
             positioning (short-int, options put/call+IV+FLOW+GEX, COT, derivatives funding/OI),
             breadth (A/D, %>MA, new H/L), fundamentals, ETF/fund flows, analyst actions.
HAVE       : get_macro_snapshot(curve/2s10s/sector rotation), get_correlations, get_peers,
             get_short_interest(Yahoo delayed), get_options_context(Yahoo put/call+IV),
             get_derivatives_context(Binance funding/OI), get_fundamentals, get_sec_filings, get_earnings.
WIRE       : get_sector_snapshot, get_analyst_actions, get_market_movers (exist in Argus → add to Kairos).
BUILDABLE  : numeric RS ranking (stock/benchmark ratio + rank — cheap, OHLCV) + RRG-style render;
             market breadth IF index constituents available via FMP (A/D, %>MA); COT (FREE CFTC data —
             futures/fx positioning); RS line render on KLineChart.
HARD GAP   : real-time options-flow / GEX / dark-pool / fund flows — premium/unavailable. Short-int +
             options are DELAYED (Yahoo free) → positioning is "delayed/structural", not real-time flow
             (matches "data forces positioning"). MUST fold positioning into market_sensitivity/thesis
             so it survives to Hermes (Hermes re-fetches none of it, but DOES read market_sensitivity live).
```

## Cross-cutting mandates

**Edit routing is mode-aware (K4) — ONE shared flow:** click edit / asked to re-edit → load artifact →
route to its OWNING agent's chat (call→Kairos) → set chat mode = artifact.mode → restore chat_state.
`mode` on the call + in chat_state makes it free. Same path for all 3 modes; mirrors idea/atlas edit.
The fit-switch (K1 fit-signal) is the one case that CHANGES mode → rebuild in the new mode.

**DO NOT DUPLICATE (hard mandate):** one agent (mode=profile), one edit/routing flow, one decision
flow, one fit-signal. Tool primitives are SHARED SERVICES, not Kairos-only — the OHLCV-primitives
engine (structure levels / SMC / RS+breadth) + KLineChart render is built ONCE and used by every
agent that needs it (Argus already shares the SMC vision tools with Kairos/Hermes). K2 = shared infra.

**Trading context (all desk agents: idea/kairos/atlas must know venue + accounts):**
```
Already backend-authoritative: broker connections + accounts + capabilities (brokerService), paper
  accounts (paperBrokerService), and PER-ARTIFACT marked accounts (idea/call/portfolio already persist
  accounts/mainAccountId/broker). FE-held gap = the user's CURRENT pre-artifact selection (passed per request).
NOW  : shared get_trading_context accessor/tool — assembles the AUTHORITATIVE menu (mode availability
       paper/live/manual, live brokers connected, accounts+capabilities per broker) from existing backend.
       No new state; ONE shared read used by all agents + monitors + re-edit; feeds the FEASIBILITY gate + sizing.
LATER (only if backend-initiated flows need it): persist current SELECTION (user_workspace = active mode +
       selected accounts) so monitor/mobile/re-edit know the workspace without the FE. Cost = sync drift; defer.
```

## Build seams (from audit)
```
mode field      : kairos.service normalizeCall:223 (+ PLAN_FIELDS:41) — one line, default 'discretionary'.
prompt profile  : kairos.agent.service _buildSystemPrompt:215 — inject mode section (dynamic block,
                  not cache-frozen) via a `mode` on chatState (mirrors active_asset).
tool subset     : kairos.agent.service:40 — replace `const tools = KAIROS_TOOLS` with
                  KAIROS_TOOLS_FOR_MODE(mode).
pattern vocab   : free-text already — per-mode enumeration guidance in the prompt only.
numeric SMC     : NEW service (deterministic OHLCV) — none of FVG/BOS/CHoCH/premium-discount exist
                  today; only vision OB/FB (services/priceStructure.tools.js). See project_smc_tools.
argus seed      : kairos.controller parseStreamBody:196 — add structured `seed`/`candidate` param →
                  _buildSystemPrompt dynamic block. Candidate = <kairos_pick>{ticker,direction,
                  thesis,analysis} (pipeline) unified w/ scan_list candidate (richer; persisted in `scans`).
scan-click      : same seed path as argus (point 6). Backend: pass candidate; FE: the click.
edit mode       : light conversational re-open carrying `mode` + revising WITHOUT full re-arm (esp.
                  armed/in-position). Today: editCall=monitor-expiry-only; PUT /kairos/:id=heavyweight
                  full re-validate+re-arm; patchKairosCall=chat_state-only. Gap = the light path.
```

## Phase structure — shared SPINE + per-mode MODULE (all 3 modes, same skeleton)

The output is shared → the workflow to build it is shared. All three modes walk the SAME phase
skeleton; only phase 3 (the lens) and the WEIGHTING differ. Chat UX is identical (agent streams
`<phase>` tags); only phase labels/emphasis adapt per mode.

```
Skeleton (mode-agnostic):
  1. Intake        asset · bias · horizon · seed(Argus/user) · MODE          [shared]
  2. Thesis frame  WHY this trade                                            [shared step, mode content]
  3. Core analysis THE LENS — the mode's method + tools                      [shared step, DIVERGES most]
  4. Zone/level    → entry_zones + reference_levels                          [shared step, mode-anchored]
  5. Scenarios     primary + contingency · patterns[].look_for               [shared]
  6. Sizing/risk   max_size · R:R · conviction                               [shared, mode-agnostic]
  7. Fit + emit    lens_fit signal (+ suggested_mode if poor) + the call     [shared]
```

Prompt structure (matches the `_buildSystemPrompt` seam):
```
SHARED SPINE (static base, cache-frozen): the skeleton + output contract + sizing/risk + fit step.
MODE MODULE  (injected per mode): phase-3 lens (method + tool subset + vocabulary) + phase WEIGHTING
             (which sub-analyses are core vs light). Selected by `mode` on chatState.
```

Per-mode centre of gravity (same skeleton, different weight):
```
                 ph.3 core analysis                         macro/positioning   zone anchoring (ph.4)
discretionary  : classical structure + momentum + false-breaks   light context   S/R + momentum levels
smc            : OB/FVG/liquidity/BOS-CHoCH/premium-discount      OUT             OB/FVG-anchored
institutional  : regime/macro + RS/correlation + positioning      THE CORE, leads positioning confluence
```

## Mode decision — how a mode is chosen (Kairos does NOT decide; it commits)

Three inputs → a recommendation → the user confirms EVERY call → Kairos commits to the lens
and never re-decides. Kairos deciding the lens would collapse the three modes into one adaptive
blend (which is what today's Kairos already is) — the discipline of a fixed lens IS the value.

```
1. FEASIBILITY GATE — deterministic, from a shared `asset_profile` {asset_class, liquidity tier,
   data-availability flags}. Which modes the ASSET can support:
     discretionary : always (universal — classical PA works on any chart)
     smc           : liquid + structure-rich classes (forex / futures-index / crypto-major /
                     large-cap equity) above a liquidity threshold. Weak on illiquid small-caps.
     institutional : positioning data exists — options/short-interest (US equities, ETFs),
                     derivatives funding/OI (crypto), macro/rates (forex, index).
   SOFT: warn-and-allow, NEVER block. discretionary always on the menu; smc/institutional get a
   "weak fit" warning when the asset doesn't support them, but the user may still force them.

2. DRIVER RECOMMENDATION — from Argus, when the candidate originates there. Dominant score →
   mode, ∩ feasibility. Carried in the kairos_pick as `recommended_mode` + a one-line why.
     technical / liquidity dominant        → discretionary (default) or smc (if it read a
                                              smart-money structure)
     relative-strength / macro / positioning → institutional

3. NO per-user default — the mode is an EXPLICIT per-call choice every time. Argus's recommendation
   PRE-FILLS the choice (user confirms/changes); direct-chat = the user picks. No stored style setting.
```

Flow:
```
asset known → feasible = feasibilityGate(asset)              // ⊇ {discretionary}
            → recommended = (Argus driver ∩ feasible)  OR  (direct chat: user picks)
            → USER confirms / overrides to any mode (warn on weak fit)
            → mode committed → Kairos builds THROUGH it (never re-decides)
```

Per entry point:
```
Argus hop / scan-click : recommended_mode handed over in the seed; user confirms at handoff.
direct chat            : user picks the mode; on asset-pin the feasibility gate runs as a GUARD —
                         a weak-fit default surfaces a switch prompt ("SMC won't read cleanly on a
                         thin small-cap — discretionary or institutional?"). Kairos FLAGS
                         (deterministic), the human confirms; Kairos never silently switches.
```

## Mode fit-feedback — IN K1 (post-analysis switch recommendation)
```
Kairos building in its ASSIGNED lens reports when the lens is a POOR FIT (weak/ambiguous read —
e.g. Argus said discretionary but there's no clean classical structure) and RECOMMENDS a switch.
Symmetric with the pre-build feasibility guard:
  pre-build  guard = "the ASSET can't support this mode"       (deterministic)
  post-build guard = "this SETUP doesn't suit this mode"        (Kairos's honest fit read)

Decomposes into three parts — only the first two are net-new; acting on it is FREE:
  1. FIT SIGNAL (net-new, small): each mode profile ends with "commit to your read; report how well
     this setup fits THIS lens; ONLY if it clearly doesn't belong here, name the lens that fits."
     + a `lens_fit` field on the call output (fit rating + suggested_mode when poor).
  2. SURFACING (small): a low-fit build shows "weak discretionary fit — reads like SMC; rebuild in SMC?"
  3. ACTING ON IT (FREE): user switches the mode selector → rebuild = K1's mode selection. No new mechanism.

Guardrails: HIGH bar (only on a clearly-poor fit — avoid thrash / "always wants SMC"); Kairos REPORTS
+ recommends, NEVER silently switches or blends; human confirms; result is a clean SINGLE-lens rebuild.
CALIBRATION (the high-bar threshold) is tuned EMPIRICALLY once the 3 modes run — signal is advisory
(a suggestion, never automatic), so early noise is low-harm. Build the hook in K1; tune later.
```

## FE mode selection (DECIDED) — 3 chips + badge, no heavyweight selector

```
A row of 3 chips (discretionary · smc · institutional) + an active-mode badge. ONE control does all:
  - direct chat  : user taps a chip (explicit, immediate — takes effect THIS turn)
  - Argus/scan   : chip pre-set to recommended_mode; user confirms/re-taps
  - override     : tap another chip anytime
  - lens_fit     : "weak fit — rebuild in smc?" suggestion, tapped → flips chip + rebuilds
  - wire         : active chip = chatState.mode on every request
Over full selector: chips ARE picker+override+fit-target (DRY). Over conversational: no NL ambiguity,
lands this turn (conversational only lands next turn — tools/prompt fixed once a turn starts).
DEFERRED (soft): per-chip feasibility warning (needs asset_profile) — feasibility is warn-never-block.
BACKEND ALREADY DONE: accepts chatState.mode, persists mode on the call (edit relights the right chip),
emits lens_fit. Purely a FRONTEND piece (botmarket-frontend): 3 chips reading call.mode/call.lens_fit + setting chatState.mode.
```

## Build sequence
```
K1  Mode scaffolding (foundation; delivers points 1,2,3): `mode` field + 3 prompt profiles +
    tool-subset selection + wire get_sector_snapshot to Kairos + the FIT SIGNAL (each profile
    reports lens_fit + suggested_mode when poor; acting on it reuses mode selection). SMC vision-only.
K2  Numeric SMC engine (biggest code build; enriches SMC + gives Hermes EXACT levels = point 7):
    FVG, structure(BOS/CHoCH), liquidity, premium/discount, order-blocks as OHLCV tools.
    First slice (per project_smc_tools): FVG + structure + liquidity.
K3  Argus seed ingest + scan-click (points 4,6): structured seed param + unified candidate shape.
K4  Edit mode (point 5): light conversational re-open with mode carry, no full re-arm.
Open: mode SELECTION — user picks vs Argus recommends (kairos_pick could carry a recommended mode).
```
