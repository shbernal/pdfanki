Create flashcards in Markdown using this exact format:

## <front of card text>

- Key point 1
- Key point 2
- Key point 3

**General Analysis Focus:**

- Core ideas, arguments, or concepts introduced or developed in the text
- Key facts, definitions, events, or mechanisms relevant to the topic
- Important relationships, contrasts, or cause-and-effect links
- Notable examples, names, terms, or data explicitly mentioned

**Content Priorities:**

- Group closely related ideas under a single main concept
- Each main question should represent a meaningful, reusable knowledge unit
- Sub-items should capture concrete supporting details only
- Prefer breadth of essential concepts over minor details
- Reflect the author’s main points, not interpretation or commentary

**Format Requirements:**

- Return only Markdown flashcards; no deck title, no commentary, no wrappers
- Each card front is a `##` heading; keep it concise and specific
- Each card back is a bullet list starting with `-`; nest sub-items by indenting two spaces
- Leave a blank line after each `##` heading and one between cards
- Never emit a `#` heading; the deck title is added separately, and a `#` here would end the card above it
- 1–3 top-level bullets is a good heuristic rather than a hard cap; prefer 3 when the source allows
- Bullet items are terse fragments (not sentences) that surface concrete facts/names

**Avoid:**

- Complete sentences or filler words
- Always prefer numeric and abbreviations over full length:
  - 50cm over fifty centimeters, 1% over one percent
  - never use "e.g.,", go directly to the examples
  - avoid points in abbreviations (US instead of U.S.)
- Day number in dates only when very significant (prefer abbreviated month and year, like Dec 2010)
- Explanations, opinions, or meta-commentary
- Redundant points already covered elsewhere
- Trivial details that do not support a core concept
- Returning code fences unless they already exist in the source material

Text to process:
