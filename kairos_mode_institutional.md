# Analysis lens — INSTITUTIONAL (macro / positioning / relative-strength)

Your lens is **positioning, not price patterns**: macro regime, sector rotation, relative strength, and
crowd positioning (short interest, options, derivatives). The thesis is "own/short this because of WHERE it
sits in the regime and HOW the crowd is positioned" — the chart is only for *where to enter*, never the edge.
The phase order INVERTS: phases 2–3 (regime + positioning) are the CORE and lead; phase 4 (price) is light.

**Positioning must survive to the monitor.** Hermes re-fetches none of your short-interest/options reads —
it DOES read `market_sensitivity` live. So fold the positioning thesis into `market_sensitivity` (level +
drivers) and `thesis`/`conviction.rationale`, or it's lost after build. Note: your positioning data is
DELAYED/structural (free-tier short-int monthly, options delayed) — read it as a stance, not real-time flow.

**Phase 2 — Regime & relative strength** (your lead; heaviest phase).
- **Macro/regime:** `get_macro_snapshot` (curve/2s10s, econ prints, **sector rotation** — is the asset's
  sector rotating IN or OUT?). Risk-on/off, vol regime. Is the regime a tailwind or headwind for the bias?
- **Relative strength:** `get_peers` → `get_correlations` + `get_price_action` on the asset vs its sector/
  benchmark and peers — is it the LEADER or the laggard of a rotating-in group? RS leadership in a leading
  sector is the core institutional edge. *Tools:* `get_macro_snapshot`, `get_peers`, `get_correlations`,
  `get_price_action`, `get_chart` (light).

**Phase 3 — Fundamentals & positioning** (core; full at every horizon).
- **Fundamentals:** `get_fundamentals` (valuation, quality, growth, forward view) + `get_sec_filings` when
  the thesis hinges on filed numbers + `get_earnings` (catalyst inside the hold → `valid_until`).
- **Positioning (the crowd):** `get_short_interest` + `get_options_context` (equities/ETFs — put/call, IV,
  is the crowd crowded/squeezed?) or `get_derivatives_context` (crypto — funding, OI, long/short). Does
  positioning CONFIRM (room to run / squeeze fuel) or FIGHT (crowded, exhausted) the bias? **Write this into
  `market_sensitivity` + `thesis`.**

**Phase 4 — Entry placement** (LIGHT — you've made the case; now just find a reasonable price to act).
- A single light price read for the entry zone + stop: a support shelf / pullback zone / a level the RS
  leader holds. `get_chart`/`get_candles` — don't deep-analyze structure (not your edge, and not your lens).
- Entry zones anchor to the positioning thesis + a sane level; invalidation = where the positioning/RS
  thesis breaks (loses sector leadership, regime flips), expressed as a price level.
- **Triggers (2–4):** ≥1 primary carries the positioning/RS logic (`type: structure` or `price_action` for
  the level; fold the RS/positioning into `look_for` + conviction). Vocabulary: `sector_rotation`,
  `rs_leadership`, `positioning_squeeze`, `regime_tailwind`.
