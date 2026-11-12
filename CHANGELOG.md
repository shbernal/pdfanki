# Changelog

Notable changes per release. Both published packages — `@shbernal/pdfanki` and
`@shbernal/pdfanki-cli` — share this file and a version number. Versions before
0.4.0 predate it; see the
[tags](https://github.com/shbernal/pdfanki/tags) for their history.

## Unreleased

### Added

- **Provider calls retry transient errors.** A 429, 500, 502, 503 or 504, or a
  connection reset or timeout, is retried up to 5 tries in all, with exponential
  backoff and jitter, waiting as long as the server asks when it says. Each retry
  prints one line on stderr. Other errors, such as a bad key or a bad request, fail
  at once as before. Gemini, whose `gemini-3.8-flash` often answers 503 "high demand",
  goes through pdfanki's own retry; Anthropic and the OpenAI-compatible providers use
  their SDK's (`maxRetries`, up from the SDK default of 2 retries to 4).

## 0.7.1

The default Anthropic model moves to `claude-sonnet-5-5` ahead of `claude-sonnet-4-5`'s
end of life on 2026-11-30.

### Changed

- **The default Anthropic model is now `claude-sonnet-5-5`.** The old default,
  `claude-sonnet-4-5`, reaches end of life on 2026-11-30. A `defaultModel` in your own
  `settings.json`, or `--model`, still takes precedence: if yours names
  `claude-sonnet-4-5`, change it.

## 0.7.0

The default Gemini model moves to `gemini-3.8-flash`, served on the `v1` API that
`@google/genai` 3 now targets, and both provider SDKs take their new majors.

### Changed

- **The default Gemini model is now `gemini-3.8-flash`.** The old default,
  `gemini-3-pro-preview`, has been shut down, so a run that relied on it failed. Its
  replacement is served on the `v1` Gemini API, which `@google/genai` 3 now targets by
  default. A `defaultModel` set in your own `settings.json`, or `--model`, still takes
  precedence: if yours names `gemini-3-pro-preview`, change it.

- **Provider SDKs moved to new majors:** `@google/genai` 3 (requests go to the `v1` API
  instead of `v1beta`, so a model served only on `v1beta` is no longer reachable) and
  `@anthropic-ai/sdk` 1 (API version 2026-10-21; nothing pdfanki calls changed).

## 0.6.0

Deck building moves to `@ankimd/core`, `md anki` highlights code and can fetch remote
images, and the whole codebase type-checks under `strict`.

### Added

- **`pdfanki md anki` highlights fenced code and can download remote images.** It used
  to package images sitting beside the deck and nothing else, which made it the lesser
  of two commands that do the same job. A fence tagged with a language Prism knows is
  coloured at build time, and the theme's stylesheet rides along in the note type's CSS,
  so a card is coloured with no script and no media file. Every command that writes an
  `.apkg` gets that, not only `md anki`.

  Downloading is opt-in: `--remote-media` turns it on and `--remote-timeout` bounds one
  download, defaulting to 10000ms. Off by default because reaching the network is a new
  capability on a command people already run; an image that is not downloaded stays in
  the card as written and is reported, which is what happened to every remote image
  before. `ankimd build` remains the right tool for a directory of decks, and for a
  template of your own.

### Changed

- **Every parameter that only reads is `readonly`.** `@shbernal/pdfanki` widened them
  throughout: a deck, a section list, a chapter index, an options bag. Widening a
  parameter accepts every caller it accepted before, and no return type changed — a
  deck handed back is still a deck you can edit — so this is visible to TypeScript
  consumers without being a break for any of them. `ReadonlyBookJson`,
  `ReadonlyContentSection`, `ReadonlyIndexEntry` and their siblings are exported
  beside the mutable originals, which stay: a deck is built up and edited on purpose,
  and the types now say which side of that line each signature is on.

- **`@ankimd/core` moved from 0.0.4 to 0.0.7.** Two fixes in it reach `md anki`
  directly: an image written as `](<name>)` or `](name "title")` was never packaged,
  because the reader only recognized `](name)`, and a media file whose name did not stay
  inside the media directory is now refused and reported rather than written. 0.0.5 also
  made a deck's `title` and `titleSource` one discriminated union, which the deck
  `pdfanki` builds already satisfied. 0.0.7 writes the `.apkg` with SQLite 3.54.1, so
  its bytes differ from before while its notes, cards and media do not.

- **Provider SDKs refreshed** within their current majors: openai 7.55,
  `@google/genai` 2.32, `@anthropic-ai/sdk` 0.137.

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

- **Every source file is type-checked under `strict`.** `tsconfig.base.json` had
  `strict: false` with `strictNullChecks` bolted back on, which left the PDF and EPUB
  plumbing implicitly `any` — 125 parameters carrying shapes nobody had written down.
  They are written down now: `PdfParseResult`, `EpubParseResult`, `DeletedSection`, and a
  `BookMetadata` that names every field the extractors actually write. Nothing about the
  emitted deck changed; what changed is that the compiler can now see when it would.

### Fixed

- **Failures report what went wrong instead of `undefined`.** Error handlers reached for
  `.message` through a cast, and the provider SDKs throw their API response rather than
  an `Error`, so a real failure surfaced as "Conversion failed: undefined". Ten call
  sites now describe whatever was thrown, and rethrown errors carry the original as
  `cause`.

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
