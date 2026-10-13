# Pythia names companies — the `names` field

**Status: BUILT 2026-10-13 (§9), one live assessment and a browser drive on axl_dev. Decisions §6: all four as
recommended, for now (Roy, 2026-10-13).** §3.6 of [argus-on-pythia.md](./argus-on-pythia.md). Decisions for Roy in §6.

## 1. Why

Pythia reads company-level evidence on every assessment — the last month's news on the industry's 15 largest
companies, the top capex spenders, the insiders buying — and writes a required `second_order` line on who else the
view reaches. But an assessment has no place for a COMPANY: a name she singles out ("the real winner is supplier
XYZ") lives in free text and goes nowhere. Argus starts from each industry's largest companies; the weekly house
scan queues the largest uncovered ones. The names the evidence actually pointed at are lost.

Since 2026-10-13 the second-order line is shown to Argus (07bbd9b) — as prose. This makes the companies in it, and
in the thesis, structured and checkable.

## 2. The field

An optional list on `<industry_assessment>` (industries and themes alike):

```
"names": [
  { "symbol": "LITE", "why": "optical transceivers sold out into 2029 (Oct 8 report)" },
  { "symbol": "VRT",  "why": "data-center power and cooling — the spend spills here" }
]
```

- **At most 6** (decision 1). **Optional:** an assessment with nothing specific to name is not refused; most will
  name none or a few. Never the largest companies by default — the board and Argus already have those.
- `why` is required per name (≤ 200 characters): the evidence that points at the company, not a stock call.
- **No order from the model.** Whether a name is first order (inside the subject) or second order (elsewhere) is
  worked out by CODE from `gics_companies` (§3) — the model cannot mislabel it.

## 3. The checks (code)

- `checkAssessment` keeps its shape check pure: a list, ≤ 6, each `symbol` a ticker shape, each `why` present.
  A malformed name is DROPPED with a note, never a refusal — the research was paid for.
- `publishAssessment` resolves the names against `gics_companies` (`readCompaniesBySymbol`, one read):
  - **Unknown to the universe** (foreign, under $300M, a typo) → dropped, kept on the revision note as
    `names_dropped` (decision 2).
  - **First order** — its sub-industry is the assessed industry, or one of the theme's links.
  - **Second order** — classified anywhere else. Stored with its own industry.
- Stored on the assessment as `names: [{ symbol, why, order: 'first'|'second', sub_code, industry }]`. Not on the
  light list (a closed row does not show them); in the detail.

## 4. Who reads them

1. **Argus** — `get_house_industries`:
   - the book list adds one line per industry: `the house names: LITE (first), VRT (second — Electrical Components)`;
   - an `{industry}` call lists **the house's names first**, as company rows (so they are grounded through the same
     `SOURCED_EXTRACT`), then the largest companies. A second-order name appears under the industry that named it,
     with its own industry beside it.
   - The rule stays: a preference, nothing added to a score; first and second order equal (Roy, 2026-10-13).
2. **The weekly house scan** (code): a FOR SWING / FOR LONG TERM assessment's names go to Prometheus's queue
   **first**, then the largest uncovered names fill the per-industry count (decision 4). The `why` travels on the
   queue row, so Prometheus's opening reads what pointed at the company.
3. **Atlas's sleeve**: a named company found inside the sleeve's 50-wide screen joins the house-first slots (the same
   half cap). Not inside the screen → not added: the school's floors hold.
4. **The house label** (`houseLabel.service`): a named company carries the label even when its own industry is not
   on the list — "named by the house in Communications Equipment (swing)" (decision 3).
5. **The board**: the opened row lists the names with their `why` and order.

## 5. Pythia's prompt

One short section beside `second_order`: name a company only when the evidence in front of her points at it — a
dated report, a capex line, an insider cluster, a contract — and say which in `why`; second-order names are as
welcome as first-order ones; never list the largest companies for their size; none is a fine answer. Existing
assessments have no names until their next run; nothing is backfilled.

## 6. Decisions for Roy

1. **How many names per assessment?** Recommended: at most 6.
2. **A name outside our universe** (foreign listing, under $300M): drop it, note it on the trail? Recommended: yes —
   Argus and Prometheus cannot price or classify it.
3. **The label on a named company whose industry is not on the list?** Recommended: yes, "named by the house".
4. **The house scan: names first, inside the same per-industry count (3)?** Recommended: yes — names first, the
   largest fill what is left; the weekly ceiling (30) unchanged.

## 7. Build order

1. The field: `checkAssessment` shape, `publishAssessment` resolution, storage, the revision note. Tests.
2. Pythia's prompt; one live assessment on axl_dev (Assess now) to see what she names and what the code keeps.
3. `get_house_industries` (both forms) + grounding; the house scan; the sleeve; the label. Tests.
4. The board's detail lines; bundle; browser drive.
5. Docs, CODE_MAP, the deploy checklist.

No migration, no new environment variable. Cost: a few output tokens per assessment; no extra model call.

## 9. As built (2026-10-13)

As designed, with these specifics:
- **The field** (`industryAssessment.service`): `checkNames` (shape, pure; `NAMES_MAX` 6; a share class spelled as the
  universe spells it, BRK.B → BRK-B), `resolveNames` (pure: first order when the sub-industry is the subject's, or one
  of a theme's links, at ANY order), stored as `names` and `names_dropped` (each with its reason; null when none). The
  universe is read through a lazily imported seam (`_io.companies`): industryData imports this module.
- **Argus**: the book list's `the house names: …` line (own names, and a theme's); the `{industry}` call lists a
  STANDING assessment's names first as company rows — grounded through the same extract — then the largest.
- **The weekly house scan**: an industry's names and its largest share the count; a theme's names take a count of their
  own ahead of its links. The queue row carries `named_why`, and Prometheus's opening then says whose assessment named
  the company and why — not "its industry", which a second-order name is not in.
- **The sleeve**: a named company inside the 50-wide screen joins the house-first slots, wherever it is classified; an
  Avoid industry's names never do.
- **The label**: a named company outside the listed industries carries `named: true` and its `why`; the chip's line reads
  "Named by the house in its swing assessment of Communications Equipment — …". An Avoid industry lends no label.
- **The board**: the opened row lists "companies it names" with order and why.
- **Live** (Communications Equipment, "Assess now", $0.026, 53 s): CIEN, LITE and VIAV, all first order, each with a dated
  piece of evidence; none dropped.
- **Cost, not settled:** that run cost $0.026 against the $0.014–0.015 measured on 2026-10-12/13. The names add at most
  about $0.002 (a few hundred tokens), so the rest is probably the web search reading more that day — one sample.
  At $0.026 a first week of ~166 would stop at the $3 cap after ~115 (the rest wait a week). See the deploy checklist.
- Tests: backend `pythiaNames.test.js` (13), the house list and scan tests updated; frontend the board and the chip.

## 8. Not in this build

- **Grading the names.** Verdicts are graded on the industry basket (pythia_calls). Whether her named companies beat
  the basket is the natural test of this field — worth logging once there are a few weeks of names.
