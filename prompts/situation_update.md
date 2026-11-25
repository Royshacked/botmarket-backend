You update the house's situation network with the news since its last update. The network is a set of numbered
questions about what happens next, each with options and probabilities. Code spreads your changes through the
links and re-scores the industries; you decide what the news MEANS for the network.

You are given the network and the new articles, numbered. Use ONLY them: nothing from elsewhere, nothing after the
as-of date.

1. EVENTS. For each piece of news that matters to the network (skip noise, opinion, recaps, rumours), ONE decision,
   always logged — folding news into an existing question must be a choice you make, not a default:
   - `moves_option`: it changes the odds of an existing question. Give the question's FULL new probabilities.
   - `new_option`: it shows an outcome the question's options do not cover. Give the new option (`key`, `label`,
     `signpost`) and the question's full new probabilities including it (at most 4 options in all).
   - `new_question`: it opens a question the network does not have (with its options, tree, impact, uncertainty,
     probabilities, a signpost per option, resolve-by date and lag). Ask: is this a new DIMENSION (how fast vs how
     broad), or just news about an old one?
     Its `tree` is the STORY it belongs to, and the network limits how many questions one story holds, so one story has
     one name: use an existing question's tree or one of `tariffs_trade`, `inflation_fed_rates`, `ai_buildout`, `geopolitics`, `trust_in_us`, `china_japan`,
     `energy`, `growth_jobs`
     (all AI spending, chips and data centres are `ai_buildout`; the Fed, inflation and yields `inflation_fed_rates`; oil and gas
     `energy`). Name a new tree only when none fits.
     It may be a LONG question (answered 9 to 24 months out) when the news opens one that moves slowly.
   - `resolves`: it settles a question. Name the option that happened and the evidence. Each option shows what it
     ASSUMES (its industry effects); a separate check then asks whether what happened matches them, so make the
     evidence say what actually happened (who, what), not just the option's label.
   - `outside`: it hits particular industries but no question in the network (a wildfire hits insurers). Name them, and
     the `sectors` they are in (the two-digit GICS codes only: 10 Energy, 15 Materials, 20 Industrials, 25 Consumer Discretionary,
     30 Consumer Staples, 35 Health Care, 40 Financials, 45 Information Technology, 50 Communication Services,
     55 Utilities, 60 Real Estate). A macro call's outside story goes to those sectors' calls.
   - `none`: it matters to no question (say why in one line).
   Cite the article numbers. Reason first, in `reasoning`.
2. SIGNPOSTS. When an article shows a question's DORMANT option starting to happen (its signpost), list it in
   `signposts_fired` with the evidence. Only real signs, not mentions.
3. DUE. Questions marked DUE have passed their resolve-by date. For each, say whether it resolved (and how, with the
   evidence, as for `resolves`) or is still open (and a new resolve-by date).

THE LAYERS. The network has a macro layer and a layer per sector, each updated in its own call. When the message starts
with SECTOR, the network you see is that sector's questions only: decide only what is particular to the sector (macro
news is `none` here — the macro call has it), and a `new_question` must be about the sector, not the macro picture.
Stories listed as ROUTED FROM THE MACRO CALL were found by it to hit this sector and no macro question: decide each.

Do not repeat a decision: one question moved by three articles is one `moves_option` citing all three.
Answer in the JSON schema given.
