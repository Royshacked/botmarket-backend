# Pythia step 4 — geopolitics: how intense, and who it touches

**Status: BUILT — step 4 complete (2026-10-12), QA cycle fixed (2026-10-13, §9). Decisions §8 all five as recommended (Roy, 2026-10-12); 4a BUILT and run 2026-10-12 (§3.1); 4b the map ACCEPTED as drafted (Roy, 2026-10-12; the Gulf and the Red Sea kept apart); 4c T3 declared exactly (§6) BEFORE any test code, then run — FAILED, so the map is shown as hypotheses only; 4d BUILT 2026-10-12 (§3.3) — step 4 complete.** Step 4 of [pythia-assessment.md](./pythia-assessment.md) §12; the
input it fills is §4.5 ("what could hit this industry from outside the economy?"). Before step 4 every assessment
carried `geopolitics` as a gap; now the desk reads the measure and leaves it out only when nothing touching the
industry is elevated and the news shows nothing. Where a design passage below and an "as built" note disagree, the
note is what runs.

Relates to: [pythia-money-flows.md](./pythia-money-flows.md) (step 8 — the same shape: an engine job, a reviewed
map, a declared test, then Pythia's wiring); [industry-screener.md](./industry-screener.md) §5 (every forecasting
idea failed — this is awareness, tested before it is believed); [pythia-industries-and-channels.md](./pythia-industries-and-channels.md)
§9 (the archived `geopolitical` channel, defined and never run).

---

## 1. What this is, and what it is not

It is **awareness**: which live geopolitical risks touch an industry, how intense each is NOW against its own
normal, whether it is rising, and which way it cuts (hurts or helps). Pythia already reads the news; what she
lacks is a MEASURE of intensity and a MAP from a risk to the industries it reaches.

It is **not a forecast**. The index measures how much the press writes about a risk, not what it will do to
anyone's revenue. The map's "hurts / helps" is a hypothesis per line until the test (§6) says otherwise.

## 2. What was sampled (2026-10-12, before any design)

| Source | What came back | Verdict |
|---|---|---|
| Caldara–Iacoviello **GPR, monthly** (`matteoiacoviello.com/gpr_files/data_gpr_export.dta`) | Free, no key, 0.8 MB. The headline index since 1985 (and a historical one since 1900), THREATS and ACTS apart, 8 category shares (war threats, peace threats, military build-ups, nuclear, terror threats, war begins, war escalates, terror acts), and **44 country indexes** (ARG … ZAF — Taiwan, China, Russia, Ukraine, Israel, Saudi Arabia, Turkey, Egypt, Korea, India, Venezuela among them; **no Iran, Iraq or North Korea**). Latest: September 2026 | **The intensity measure** |
| GPR, **daily** (`data_gpr_daily_recent.dta`) | 1.6 MB; 15,253 days to **2026-10-05** (a week old), with 7- and 30-day averages, threats and acts | **The "this week" line** |
| Its `.xls` twins | The same data; reading them needs a new dependency (`xlrd`) | Use the `.dta` — pandas reads it natively |
| The daily file's `event` notes | 11 in 40 years | Not an event feed |
| The engine's news queue (`aether_news_queue`) | 5,553 stories in the last month, `macro_tags` EMPTY on all — the tags come only from GNews queries, and Render has no GNews key | Not a source; Pythia's own news tools (FMP, Finnhub, GNews words, web search) stay the news side |
| What the index says now | Global GPR averaged 111 over 2016–25; it hit **330 in March 2026** and stands at 146 (September). Countries furthest above their own 2016–25 normal over the last 12 months: Venezuela (+4.4 sd), Switzerland, Denmark, the US, Saudi Arabia, India, Israel | Live and moving — worth measuring |

## 3. The pieces

### 3.1 The GPR job (engine, weekly)

`scripts/fetch_geopolitical_risk.py`, Sunday before Pythia's week: both `.dta` files → one small document per run
(`geopolitical_risk`, + `_runs`, complete-run marker): the global index (monthly level, daily 7- and 30-day
averages, threats vs acts, the category shares) and every country's monthly index — each with its **intensity**
(z against its own normal, D1) and its **trend** (the last 3 months against the 3 before). Nothing per day is stored.

**As built (2026-10-12)** — `aether-engine geopolitics/gpr.py`, `scripts/fetch_geopolitical_risk.py`, cron
`geopolitical-risk` Sunday 04:30 UTC → `geopolitical_risk` (+ `_runs`), 12 runs kept. Intensity = the last three
months' mean as a z against the 120 months before them (no z under 60 months of history); elevated at z ≥ 2;
the daily 7-day line as a percentile of its own ten years. A source over 100 days (monthly) or 30 days (daily)
old, or with under 40 countries, is refused, not written. Dry run: global 147 for Jul–Sep (z +0.7, −30% on the
March spike now out of the window), this week 178 (above 92% of the last ten years' weeks); one country
elevated — Saudi Arabia, z +2.2 — so "turning elevated" is rare, as a trigger should be.

### 3.2 The exposure map (reviewed config)

`geopolitics/exposure_map.yaml` in the engine: named RISKS, each with the country indexes that measure it, words
for the news, and the GICS sub-industries it HURTS and HELPS — each with a one-line why and a strength (1 direct,
2 through a supplier or a customer). Drafted by Claude, reviewed by Roy (D3), like the NAICS crosswalk. First
draft list (D2) — as DESIGNED; the accepted map measures each risk by fewer countries (as built: Taiwan TWN+CHN,
US–China CHN, Gulf SAU+ISR, Red Sea EGY+SAU, Russia–Ukraine RUS+UKR, Israel ISR, Korea KOR, Venezuela VEN) and its
lines differ in detail — `exposure_map.yaml` is the record:

| Risk | Measured by | Hurts (examples) | Helps (examples) |
|---|---|---|---|
| Taiwan Strait | TWN, CHN | Semiconductors, Semiconductor Equipment, Tech Hardware, Electronic Components | Aerospace & Defense |
| US–China trade and tech | CHN, USA | Broadline / apparel retail (import cost), Autos, Semiconductor Equipment (export bans) | domestic substitutes (Steel, some Electrical Equipment) |
| Gulf and Hormuz | SAU, ISR, TUR, EGY | Passenger Airlines, Chemicals, Marine Transportation | Integrated / E&P Oil & Gas, A&D |
| Red Sea shipping | EGY, ISR, SAU | Retailers' freight, Air Freight & Logistics | Marine Transportation (rates) |
| Russia–Ukraine | RUS, UKR, POL | Fertilizers' inputs, European-exposed industrials | Fertilizers (prices), Agricultural Products, A&D, Gas |
| Israel and neighbours | ISR, EGY, TUR | — | A&D |
| Korean peninsula | KOR, JPN | Semiconductors (memory), Tech Hardware | A&D |
| Venezuela | VEN | — | Refining (heavy crude), E&P |

Gaps by construction: no Iran / Iraq / North Korea index — the Gulf and Korea risks read their neighbours'.

**As drafted (2026-10-12)** — `aether-engine geopolitics/exposure_map.yaml`, validated by `geopolitics/exposure.py`
(every code a GICS sub-industry, every country a GPR index, every line a strength, a reason and a French-49 industry
for T3; nothing both hurt and helped). A risk is as intense as its HOTTEST party; the US index is left out of every
risk (it rises with anything the US is party to). The weekly job writes each risk's reading WITH its lines onto the
run's document — the backend cannot read the engine's files, so it joins an industry to its risks by code (this
replaces §3.3's "joined in Node from the map"). First reading through the draft: Gulf and Hormuz +2.2 and Red Sea
+2.2 (both on Saudi Arabia — elevated), Israel +0.8, Taiwan +0.7, US–China +0.7, Venezuela +0.3, Russia–Ukraine
+0.1, Korea −0.3. The Gulf and the Red Sea share their measure (no Yemen or Iran index), so they move together.

### 3.3 Per sub-industry, and where it lands

For every sub-industry, the risks that touch it: name, direction, strength, intensity now, trend, and an
**elevated** flag (intensity above the D1 line). *(Designed as joined in Node from the map; as built, the engine
writes each risk with its lines onto the run, and Node joins by code — §3.2's note.)*
- **Pythia:** `get_geopolitics` (the global reading, then the risks touching an industry); `evidence.geopolitics`
  stops being a gap; the facts freeze on each assessment as `geopolitics`, like `flows`.
- **Prompt:** the index counts newspaper articles — attention, not impact; a map direction is a hypothesis
  (*as built: always — T3 failed*); an elevated risk is a reason to READ the news on it, not a verdict.
- **Board:** one row per touching risk under the money rows. *(As built: ONE "geopolitics" row listing the
  touching risks, after the insiders / funds / government rows.)*
- **Change scan:** a touching risk turning elevated since the assessment (D4).

**4d as built (2026-10-12).** `api/strategy/geopoliticsData.service.js`: `latestReading` (the latest COMPLETE run),
`geoFacts` (an industry's view: the world's reading and the mapped risks touching it, hottest first, with side,
strength and why — frozen on each industry assessment as `geopolitics`; themes stay without), `readAllGeo` (one read for
the scan), `formatGeo`. The tool `get_geopolitics` (appended before `consult`), the prompt's fifth input (attention,
not impact; the directions failed T3; an elevated risk is a reason to read the news, the `cause` only when the news
shows revenue or costs moving), a board row ("Gulf and the Strait of Hormuz helps it — ELEVATED (+2.2)"), and the scan's
`geo_elevated` leg (weight 2, against FROZEN facts only — none on a pre-step-4 assessment or a theme). A failed read
is logged and never fails an assessment or the weekly scan. The first reading run before the map existed had no
risks on it; the job was rerun the same day with the map.

## 4. Cost

Free: two downloads a week (2.4 MB, transient). No model calls in the job; Pythia's turn grows by a few lines.

## 5. Risks

- **Attention, not impact.** A risk the press shouts about may not touch revenue; a quiet one may. The index is the
  first, not the second.
- **The map is judgment.** It names who is hurt and helped; a wrong line is visible (each line says why) and
  reviewable, and T3 tests the lines with history.
- **The index lags a week** (daily to last Monday) and a month for countries.
- **The source is one academic site** — if it moves or stops, the job fails loudly (a complete-run marker, never
  zeros: step 8's sanity floor applies).

## 6. The test — declared in outline now, exactly before any test code (as T1 was)

**T3 — do the map's directions hold?** After a risk's index JUMPS (crossing its elevated line), do the industries
the map says it HURTS trail the market, and those it HELPS beat it, over the next 1, 3 and 6 months? Data: the GPR
country and global series 1985–2026 and Ken French's 49 industries (no survivorship, already local); each map
line gets its nearest French-49 industry for the test (Chips, Aero, Guns, Ships, Oil, Trans, Chems, Agric …). Bar
(to be fixed in writing before the run): the helped-minus-hurt spread after jumps ≥ +2pp over 3 months, t ≥ 2,
judged on 2005–2025. Pass → a base rate per risk rides on assessments. Fail → the map is shown as hypotheses,
said so.

**T3 exactly, declared 2026-10-12 BEFORE any test code or result (Roy approved the outline the same day).** It tests
the ACCEPTED map as it stands — written in 2026 with hindsight about which industries matter, which this test cannot
remove; what it tests is the DIRECTIONS, not the choice of risks.
1. *Intensity, month by month, as live:* each country index's z at month end t exactly as `gpr.intensity` computes it
   on the series up to t (the last 3 months' mean against the 120 before; none under 60 months of history). A risk's
   z is its hottest country's. The country indexes start in 1985, so z exists from about 1990 (60 months) and in full
   from 1995.
2. *Events:* a risk TURNING ELEVATED — z ≥ 2 at t and < 2 at t−1 (the live trigger). A crossing within 6 months of
   the same risk's previous event is the same episode and is dropped.
3. *Lines:* each risk's hurts and helps mapped to their French-49 industry (`ff49`); a French-49 industry that sits
   on BOTH sides of one risk (the Gulf: Trans hurt through airlines, helped through tankers) is dropped from that
   risk — it cannot be tested at that grain — and counted; repeats on one side count once.
4. *Outcome per event:* each line's French-49 value-weighted return minus the market's (`ff_market`) over months
   t+1 … t+h, compounded; the event's SPREAD = the mean over its helped industries minus the mean over its hurt
   ones (a risk with one side only: that side, signed — helped +, hurt −). h = 3 is judged; 1 and 6 reported.
5. *Statistic:* events in the same month are averaged into one number (the months, not the events, are the sample);
   the mean of those, with a plain t (episodes are at least 6 months apart within a risk; across risks, same-month
   events are already merged).
6. *Judged on* events at t in 2005-01 … 2025-12 with 3 months after them. **Pass:** mean spread ≥ +2pp and
   t ≥ 2. Reported, not judged: 1995–2004; h = 1 and 6; each risk alone; strength-1 lines alone; how many events
   and how many dropped lines.
7. *What passes means:* the base rate rides on assessments for the risks whose own mean spread has the right sign
   (their numbers attached, said to be few events each). A fail: the map stays shown as hypotheses, said so, and
   `BASE_RATES` gains nothing — as for the insider cluster.

**Result (run 2026-10-12, `aether-engine scripts/run_geopolitics_test.py`): FAILED — and the sign is the wrong way.**

| | helped minus hurt, after a risk turns elevated | t | event-months |
|---|---|---|---|
| **3 months, judged 2005–2025** | **−2.35pp** | **−1.08** | 29 |
| 1 month, judged | −1.42pp | −1.22 | 29 |
| 6 months, judged | −1.08pp | −0.35 | 29 |
| strength-1 lines only, 3 months | +0.24pp | 0.15 | 32 |
| 3 months, 1995–2004 (reported) | −2.00pp | −0.63 | 13 |

By risk (3 months, all years, few events each): Taiwan Strait −5.7pp (18), Israel −5.2pp (7), US–China −4.2pp (10),
Korea −2.9pp (7), Russia–Ukraine −1.1pp (11), Gulf +0.7pp (12), Red Sea +1.6pp (10). Venezuela has NO testable line:
its only French-49 industry, Oil, sits on both sides (refiners hurt, producers helped) and was dropped as declared.
Dropped as both-sided: Trans (Gulf, Red Sea), Chems (Russia–Ukraine), Oil (Venezuela).

**So:** the map ships as HYPOTHESES, as declared — `BASE_RATES` gains nothing, and 4d's prompt and board must say the
directions are untested-or-failed, as the insider cluster says "no tested edge". Read honestly, the numbers lean the
OTHER way — and the review (2026-10-13, line by line on the saved events) found about HALF of that is the HELPED side
lagging, not the hurt side winning: after a Taiwan scare gold trailed the market by 5.8pp and defence by 1.2 while
chips beat it by 3.1 and hardware by 2.0; Israel's −5.2pp is oil (−11.6pp, mostly 1990-10 and 2001-09); US–China's is
steel (−7.1) against chips (+3.9). That is the pattern of hedges and commodities bought at a scare's peak and sold
after it, with the hurt lines recovering — a hypothesis for a NEW declared test, not a reading of this one: at
t −1.08 the reverse is no more proven than the map.

*Notes added in review (2026-10-13), none changing the FAIL:* (1) **episodes:** a crossing is dropped when it falls
within 6 months of the last kept event, so kept events are at least 7 months apart; (2) **strength-1 is not a subset
of the main run:** filtering by strength BEFORE the both-sided drop brings back lines the main run dropped (Venezuela's
Oil, the Gulf's and the Red Sea's Trans) — hence 32 event-months against 29; (3) **dependence:** risks share countries
(Saudi Arabia in the Gulf and the Red Sea, Israel in the Gulf and Israel, China in Taiwan and US–China) and adjacent
events' windows overlap, so the plain t overstates |t| — the FAIL and "no more proven" only get stronger; (4)
**publication lag:** month t's index is published in the first days of t+1, while returns are counted from t+1's
first day — a few days' overlap; (5) **proxies corrected after the test** (Roy, 2026-10-13): Agricultural Products is
Food, not Agric (farms), and cruise lines are Trans, not Meals — Russia–Ukraine's number above rests on the old farm
proxy; a rerun would be a new declared test.

## 7. Build order

1. **4a** the GPR job (intensity and trend; the D1 baseline).
2. **4b** the exposure map — Claude's draft → Roy's review.
3. **4c** T3, declared exactly, then run.
4. **4d** Pythia: tool, prompt, frozen facts, board row, scan trigger. Docs.

4a alone gives Pythia the global reading; each part ships on its own.

## 8. Decisions for Roy

**Decided 2026-10-12 (Roy): 1–5 as recommended** — each index against its own trailing ten years; the eight
risks; a Claude draft of the map for Roy's review; a risk turning elevated triggers a reassessment (weight 2);
the bar in §6 as outlined.

1. **"Elevated" against what:** each index's own trailing ten years (recommended — moves with the world), or a
   fixed 2016–2025 decade (stable, but ages).
2. **The risks:** the eight above (recommended to start), plus or minus.
3. **The map:** a Claude draft you review (recommended, as the NAICS crosswalk), or written by hand.
4. **The scan:** a touching risk turning elevated buys a reassessment of the industries it hurts or helps
   (recommended, weight 2), or shown only until T3.
5. **The bar in §6** — as outlined, or different.

## 9. QA cycle (2026-10-13)

Three reviews (engine; backend wiring; board and docs), every finding checked against the code, all fixed except the
map's directions (Roy: only the two proxy corrections):
- **The job refuses** a mapped country that is missing from the file or ends before the global index (the source
  dropping Taiwan would have left the Taiwan risk on China alone); each country carries its own `through`; the
  monthly staleness is 75 days from the month's first day (100 let a missed release pass); staleness is checked
  against TODAY, not `--asof`.
- **No false crossings:** a reading without the map's risks freezes nothing (an empty list would have made every
  already-elevated risk look new); only risks the frozen reading measured are compared (`map_risks`); a risk counts
  as turning elevated only if it was frozen below 1.5 (`SCAN.GEO_REARM_Z`) — one frozen at 1.9 ticking to 2.0 is
  noise. A risk elevated when assessed, calmed, and elevated again is NOT re-flagged: the desk read it.
- **Pythia gets each risk's news words**, the tool's nulls read n/a, a line with no strength is not called
  indirect, "40-year" is gone (judged 2005–2025), and the prompt says to leave `geopolitics` out when nothing
  touching is elevated and the news shows nothing.
- **One citation cleaner** (`agentUtils.plainCitations`) for industries AND themes, handling a URL with one level of
  parentheses.
- **The board** says "sd". **The weekly scan** survives a flows or geopolitics reader that throws. **The tool's
  logic** is `geopoliticsText` (tested). The controller reads geopolitics beside the other reads.
