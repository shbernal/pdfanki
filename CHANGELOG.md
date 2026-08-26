# Changelog

Notable changes per release. Both published packages — `@shbernal/pdfanki` and
`@shbernal/pdfanki-cli` — share this file and a version number. Versions before
0.4.0 predate it; see the
[tags](https://github.com/shbernal/pdfanki/tags) for their history.

## Unreleased

### Changed

- **Deck building moved from `@shbernal/mdanki` to `@ankimd/core`.** One package now
  owns Flashcard Markdown for the whole family, and `pdfanki` holds none of it: the
  scanner it carried, a second implementation of the same grammar against the same
  section of the spec, is gone. What is left in `cli/src/flashcardPolicy.ts` is the set
  the format hands to a producer rather than requiring, and it is about 300 lines
  smaller.

  Generated decks no longer go through a temporary markdown file on their way to an
  `.apkg`. The cards are passed straight to the writer, so the serialize-and-reparse
  step in the middle is gone along with the failure modes that came with it.

- **Two whitespace departures are now normalized rather than retried.** A missing blank
  line after a `##` heading and a `***` written tight against its neighbours are both
  legal input that a producer must not _emit_, and the deck `pdfanki` writes is rendered
  rather than echoed, so both come out canonical. Previously each cost a model call.
  What still fails the model's output is unchanged: a stray `#`, an empty front, content
  above the first card, a bullet-less answer, an empty bullet, a repeated front.

- **`pdfanki md anki` no longer highlights code or downloads remote images.** Images
  beside the deck that names them are still packaged. Prism highlighting and remote
  fetching were `@shbernal/mdanki` defaults, and reproducing them here would put a
  syntax-highlighting table and a network policy inside a tool whose subject is PDFs.
  [`ankimd build`](https://www.npmjs.com/package/@ankimd/cli) does all three and is the
  command to reach for on a hand-written deck.

## 0.5.0

The format round. `pdfanki` now conforms as a **producer** to
[Flashcard Markdown 1.0](https://github.com/shbernal/flashcard-md-spec) — the written
specification `mdanki` reads — and runs its conformance corpus in the opposite direction
from a consumer: every canonical case must come back out of the serializer byte for byte,
and every invalid case must be rejected.

### Fixed

- **Nested bullets, `###` headings and prose no longer disappear from generated decks.**
  The markdown validator recognized `## ` and `- ` and ignored every other line, so a
  nested list item — which the prompts allow — was dropped between the model writing it
  and the deck being built. So was a `###` heading, and so was any paragraph. Nothing
  reported it, because a deck missing a sub-bullet still looks like a deck.

  The card body is arbitrary Markdown and is now kept verbatim. The validator also tracks
  fenced-code state, so a `## ` or a `***` inside a code block is content rather than
  structure.

### Changed

- **`@shbernal/mdanki` is now `^4.0.0`.** Nothing about a deck `pdfanki` generates
  changes because of it — `pdfanki` has never emitted either of the syntaxes that release
  removed. It matters if you pass **hand-written** markdown to `pdfanki md anki`: a `%`
  line no longer separates front from back, and a `[#tag]()` line no longer sets tags.
  `mdanki` warns on both. In exchange, hand-written decks gain frontmatter tags, bare
  `#tag` tokens, and `/` nesting exported as Anki's `::`.

- **Generated markdown carries a blank line after each `##` heading.** That is the
  canonical spelling, and it is what keeps a deck from being lint-dirty inside an Obsidian
  vault (markdownlint MD022). Existing files are untouched; only newly generated ones
  differ, and only by that blank line.

- **The validator refuses three more things**, each of which would have produced a deck
  that reads wrongly rather than one that fails:
  - a `#` heading anywhere in the model's output — the deck title is added around it, and
    a `#` in the middle would end the card above it,
  - two cards with the same front, which a reviewer cannot tell apart,
  - a `***` written without the blank lines the canonical form puts around it.

  As before, a rejection means that section is asked for again, up to the retry limit.

- **The four prompts share one set of format rules**, checked by a test rather than copied
  four times. Two long-standing wordings are fixed with them: "1–3 items" was a cap the
  authoring convention never intended, and "headings above `##` level" was ambiguous about
  which direction "above" meant.

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
