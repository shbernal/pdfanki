Create flashcards in Markdown using this exact format:

## <front of card text>

- Key point 1
- Key point 2
- Key point 3

## Domain Scope (Crypto / Web3)

The source text may cover one or more of the following:

- Blockchain architectures (L1, L2, rollups, sidechains, appchains)
- Consensus mechanisms (PoW, PoS, DPoS, BFT variants, LMD-GHOST, etc.)
- Cryptography primitives (hashing, signatures, Merkle trees, ZK, MPC)
- Token economics (issuance, supply schedules, incentives, slashing, fees)
- Smart contracts and virtual machines (EVM, WASM, account models)
- Protocol mechanics (bridges, oracles, MEV, mempool behavior)
- Governance models (on-chain, off-chain, DAOs)
- Security and failure modes (reorgs, exploits, attack vectors)
- Infra and tooling (nodes, clients, RPCs, indexers)
- Standards and specs (ERCs, BIPs, EIPs, RFC-like documents)

## General Analysis Focus

- Protocol-level mechanisms and invariants
- Formal definitions and terminology used by the author
- Explicit assumptions, constraints, and trade-offs
- Cause–effect relationships (e.g. incentive → behavior → outcome)
- Comparisons between designs, models, or implementations
- Quantitative parameters when mentioned (block time, gas, stake, thresholds)

## Content Priorities (Crypto-Optimized)

- One flashcard = one **atomic technical concept**
- Prefer **mechanisms over narratives**
- Capture **what the system does**, not why it is “good” or “bad”
- Group sub-points only if they are part of the _same mechanism_
- Preserve protocol-specific naming (exact terms, acronyms, variable names)
- Include explicit numbers, formulas, or thresholds if present in the text
- Treat examples as secondary unless they define a standard or pattern

## Format Requirements

- Return **only** Markdown flashcards; no explanations, no intro, no outro
- Each card front is a `##` heading; concise, protocol-specific
- Each card back is a bullet list with **1–3 items** starting with `-`
  - Prefer 3 when the source supports it
- Bullet items are **terse technical fragments**, not sentences
- No subjective language, no metaphors
- One blank line between flashcard groups
- No headings above `##`
- No emojis
- No code fences unless they already exist verbatim in the source

## Precision Rules

- Do not generalize beyond what the text states
- Do not merge concepts from different protocols unless explicitly compared
- Do not introduce external knowledge, best practices, or commentary
- Do not explain cryptographic primitives unless the source does
- Use exact capitalization and terminology from the text when relevant

## Avoid

- High-level summaries (“improves scalability”, “enhances security”)
- Marketing language or ecosystem commentary
- Redundant restatements across multiple cards
- Wallet/user UX details unless the text is explicitly about UX
- Opinions, implications, or future-looking speculation

Text to process:
