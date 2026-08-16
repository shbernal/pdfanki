# Changelog

Notable changes per release. Both published packages — `@shbernal/pdfanki` and
`@shbernal/pdfanki-cli` — share this file and a version number. Versions before
0.4.0 predate it; see the
[tags](https://github.com/shbernal/pdfanki/tags) for their history.

## 0.4.0

A dependency round. Nothing about the markdown `pdfanki` writes changes, and no
flag or command changes, but which Anki notes a rebuilt deck matches on import
does — read the first entry before upgrading.

### Changed

- **`@shbernal/mdanki` is now `^3.0.0`**, which changes how a note's identity is
  derived, and that identity is what Anki matches on at import.

  What you get: rebuilding a deck from the same book and re-importing it now
  **updates** its notes. Before, the identity was derived from a value that
  differed on every run, so every re-import added a second copy of every card.
  Verified through `pdfanki md anki` on a 200-card deck: two independent builds
  now produce byte-for-byte the same note identities, where previously they
  produced none in common.

  What it costs, once: **the first import after upgrading duplicates a deck you
  have already imported.** Old and new identities do not overlap at all, so Anki
  sees an entirely new set of notes rather than an update. Every import after
  that one is stable.

  If you would rather not merge the two copies by hand, delete the deck in Anki
  before importing the first deck built with this version. Review history goes
  with it either way, so a deck you have been studying is worth the merge.

- **Deck building releases its database.** `mdanki` held a WASM heap per
  conversion until the process exited. No API change.

### Deprecated

`mdanki` now warns when a markdown file uses the `%` front/back separator or
`[#tag]` tag lines, both of which a future major stops recognizing. `pdfanki`
does not generate either, so this only reaches you if you pass hand-written
markdown to `pdfanki md anki`.
