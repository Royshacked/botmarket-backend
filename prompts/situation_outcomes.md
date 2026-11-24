You review the options of the house's situation network. You did not write them; your job is to find what their
author missed. The network is a set of numbered questions about what happens next, each with 2–4 options and
probabilities, and each option carries the industry effects it ASSUMES (what wins, what loses if it happens). Code
spreads probabilities through links between options and scores industries from the effects: an option that is not
there holds no probability, moves no link and pushes no industry, from the day the question is asked.

For EVERY question, attack its options:
- Is a plausible outcome MISSING? Plausible = you would put at least about 5% on it by the resolve-by date.
- Is an option LUMPING two outcomes that would move industries DIFFERENTLY? Example: "Does Nvidia name a permanent CEO?
  Yes / No" — "Yes" holds both an outsider (a governance reset) and the old CEO coming back (continuity, a relief
  rally). The label fits both; the effects fit one.
- An outcome that would move the same industries the same way as an existing option is NOT missing: leave it in.

For each question that needs it, ONE change:
- `add_option`: the question gains the missing outcome as a new option (`key`, `label`, `signpost`: what would show it
  starting). Give the question's FULL new probabilities, the new option included. Only when it has fewer than 4 options.
  When an option lumps two outcomes, the new option takes the one its effects do NOT fit, and its share of the old
  option's probability; relabel nothing.
- `reword`: the question itself is framed on the wrong thing, or it has 4 options already and still misses an outcome.
  Give the replacing question: its wording, 2–4 options (each with a signpost) that cover what can happen, and their
  probabilities. Ask it about what MOVES INDUSTRIES ("Who leads Nvidia by Q1 2027?"), not about a label that hides it.
- `follow_up`: an option is likely enough (about 20% or more, or its signpost has fired) and, IF it happens, the next
  question decides which way industries move. "Does Nvidia name a permanent CEO? Yes" → "Who becomes CEO?": an insider,
  an outsider, the old CEO back. Give `under_option` (the option's key), the follow-up's question, its 2–4 options (each
  with a signpost), its probabilities AS IF that option happened, and its resolve-by date. Only when the follow-up's
  options would move industries differently from each other; not under a question that hangs under another already.
Questions that are fine get no entry. The lines marked "(follow-up of N, if X)" already hang under an option. Most questions are fine; a change is a claim you must argue in `reasoning`, with the
outcome named and why its industries move differently. Change at most 8 questions: the most consequential first.

Use only the question list and what you know up to the as-of date. Answer in the JSON schema given.
