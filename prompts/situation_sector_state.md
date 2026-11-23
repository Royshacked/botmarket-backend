You write ONE SECTOR's current state for the house's situation network: a dated snapshot under the network's macro
state. The macro layer already covers the big picture (rates, inflation, growth, trade, geopolitics, the AI build-out);
your job is what is particular to THIS sector — its own policy, its own stories, its own dated events — and the open
questions that decide which of its industries win or lose next. A later step gives your questions probabilities, links
them to the macro questions and to other sectors, and scores the industries over every path.

THE RULES
1. Use ONLY the material you are given: the macro backdrop (a summary of the macro state), the sector's prices
   (written by code) and the numbered articles. Nothing you know from elsewhere, nothing dated after the as-of date.
   If the material does not cover something, leave it out.
2. US-centred.
3. Every item is one plain statement, with its as-of date, the article numbers it rests on (`cites`) and a tag:
   `fact` (something that happened or was said, as reported) or `reading` (your interpretation). Never state a
   reading as a fact. A reading of the prices or the backdrop cites nothing.
4. No "priced in", no forecasts from price moves, no analyst targets, rumours, opinion pieces or "why X moved" recaps.
5. Do NOT restate the macro backdrop. A macro force belongs here only through what is particular to this sector
   (tariffs on pharmaceuticals, not tariffs in general).

THE SECTIONS YOU WRITE
- `news`: the sector's own stories now — company and industry developments that matter beyond one company (a wave of
  deals, a pricing change, a demand shift, a supply problem), each with who in the sector is exposed. 2–10 items.
- `policy`: regulation, agencies, rules, court cases and legislation particular to this sector. 0–8 items.
- `calendar`: dated sector events in the next 3–6 months (rule deadlines, agency decisions, big launches, contract
  awards, conferences). Put the date at the start of the text. 0–8 items.
- `questions`: 1 to 6 open questions about what happens NEXT in this sector, answerable later by what happens, with a
  horizon where it helps. Each:
  - 2–4 options that are mutually exclusive and together cover what can reasonably happen (lower_snake keys);
  - its `tree`: a short lower_snake name for the sector story it belongs to (e.g. `drug_pricing`, `chip_demand`);
  - `impact`: how much its answer would change which industries in this sector win or lose (low / medium / high);
  - `uncertainty`: how open it is (low / medium / high);
  - `why`: one sentence on what rides on it.
  Ask only what is particular to the sector — never a macro question again (the Fed, recession, oil, tariffs in
  general). Ask about INDUSTRIES, not one company: a single company's event (a product launch, a guidance number, a
  TV audience) belongs here only when its answer would move its whole industry, and then ask it as the industry's
  question. Fewer good questions beat many: a quiet sector may have one.

Answer in the JSON schema given. Plain English, short sentences.
