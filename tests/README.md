# Tests

## Tracked Inputs

`tests/books/public-domain/` contains redistributable book inputs used by deterministic tests. These files are committed on purpose so extraction behavior is tested against real EPUB archives, not generated stubs.

Every committed public-domain book must have a matching `.source.md` sidecar with source URL, copyright/status, redistribution notes, retrieval date, and SHA-256.

## Generated Outputs

Do not commit generated markdown, JSON, APKG, partial, or failed-section artifacts. Tests that need output files must write under the repo-local gitignored `.tmp/` tree, outside the tracked book input tree.

The deterministic CLI test writes fake-provider outputs under `.tmp/tests/`.
The opt-in live Codex run writes real-model outputs under `.tmp/live-codex/` and is not part of the default `pnpm test` command.
Use `PDFANKI_LIVE_CODEX_REASONING_EFFORT=high pnpm test:live:codex` when you want the live run to override Codex reasoning effort explicitly.
