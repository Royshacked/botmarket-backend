# Pythia step 4 — geopolitics: how intense, and who it touches

**Status: DESIGN (2026-10-12); decisions §8 all five as recommended (Roy, 2026-10-12); 4a in progress.** Step 4 of [pythia-assessment.md](./pythia-assessment.md) §12; the
input it fills is §4.5 ("what could hit this industry from outside the economy?"). Today every assessment carries
`geopolitics` as a GAP. Decisions for Roy are in §8.

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

### 3.2 The exposure map (reviewed config)

`geopolitics/exposure_map.yaml` in the engine: named RISKS, each with the country indexes that measure it, words
for the news, and the GICS sub-industries it HURTS and HELPS — each with a one-line why and a strength (1 direct,
2 through a supplier or a customer). Drafted by Claude, reviewed by Roy (D3), like the NAICS crosswalk. First
draft list (D2):

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

### 3.3 Per sub-industry, and where it lands

For every sub-industry, the risks that touch it: name, direction, strength, intensity now, trend, and an
**elevated** flag (intensity above the D1 line). Read in the backend from the latest complete run joined with
the map — the map's lines are small, so the per-industry view is computed in Node, not stored per node.
- **Pythia:** `get_geopolitics` (the global reading, then the risks touching an industry); `evidence.geopolitics`
  stops being a gap; the facts freeze on each assessment as `geopolitics`, like `flows`.
- **Prompt:** the index counts newspaper articles — attention, not impact; a map direction is a hypothesis unless
  a base rate is attached (T3); an elevated risk is a reason to READ the news on it, not a verdict.
- **Board:** one row per touching risk under the money rows.
- **Change scan:** a touching risk turning elevated since the assessment (D4).

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
