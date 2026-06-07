# Public-Domain Book Inputs

These EPUBs were copied from `~/Work/speedreader/tests/fixtures/epubs/public-domain/`.
They are official Project Gutenberg EPUB3 downloads with sidecar provenance files.

Tracked books:

- `scientific-management.pg6435.epub`: compact technical/management nonfiction.
- `yellow-wallpaper.pg1952.epub`: short fiction.
- `jekyll-hyde.pg43.epub`: novella with multiple extractable sections.

The current deterministic tests use these books for:

- SHA-256 and provenance sidecar checks.
- EPUB extraction assertions on metadata, section counts, and stable text markers.
- CLI Codex-provider wiring through a fake local `codex` executable, with output written only to a temp directory.

Do not add generated test outputs here.

