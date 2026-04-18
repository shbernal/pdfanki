pdfanki
=======

Create Anki decks from PDF/EPUB files using NLP with LLMs. This repository hosts the CLI plus shared packages and tooling that power the end-to-end workflow.

Project layout
- `cli/`: The published CLI (`@shbernal/pdfanki-cli`)
- `fixtures/local/`: Gitignored local real-file fixtures for CLI smoke tests
- `packages/`: Shared libraries used by the CLI
- `scripts/`, `turbo.json`, `pnpm-workspace.yaml`: Repo-level tooling

Requirements
- Node.js >= 20
- Provider API key exported in your shell: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY`

Install (CLI)
```bash
pnpm i -g @shbernal/pdfanki-cli
```

Local repo workflows
- Run the local-dev CLI against repo sources from the project root:
  - `pnpm pdfanki-local -- epub json /path/to/book.epub`
- Run the pack/install smoke test from the project root:
  - `pnpm cli-local-test`
- `pnpm cli-local-test` defaults to writing tarballs under `.tmp/packed/`.
- Override the pack output directory when needed:
  - `PDFANKI_PACK_DIR=/tmp/pdfanki-packed pnpm cli-local-test`
- Sync config prompts into tracked repo prompts:
  - `pnpm fetch-config-prompts`
- Override the prompt source directory when needed:
  - `PDFANKI_CONFIG_PROMPTS_DIR=/path/to/prompts pnpm fetch-config-prompts`

Config (XDG)
- Config dir: `$XDG_CONFIG_HOME/pdfanki/` or `~/.pdfanki/` if unset
- Auto-created on first run:
  - `settings.json` (defaults to the `gemini` provider)
  - `prompts/default.md` (you can pick any `.md` in this directory as the prompt)

How the CLI works
- The CLI is organized around source commands and target subcommands:
  - `pdfanki pdf <json|md|anki> <input>`
  - `pdfanki epub <json|md|anki> <input>`
  - `pdfanki json <md|anki> <input>`
  - `pdfanki md anki <input>`
- Example: create an Anki deck from a PDF
  - `pdfanki pdf anki book.pdf --deck-title "Book Deck"`
- Example: generate markdown from a PDF with DeepSeek
  - `pdfanki pdf md book.pdf --provider deepseek --model deepseek-chat`
- Example: generate markdown from a PDF with OpenRouter
  - `pdfanki pdf md book.pdf --provider openrouter --model z-ai/glm-5`
- Example: extract JSON from an EPUB chapter range
  - `pdfanki epub json book.epub --start-chapter 3 --end-chapter 5 --min-char 300`
- Example: build an Anki deck from existing markdown
  - `pdfanki md anki deck.md`
- Example: build an Anki deck from existing extracted JSON
  - `pdfanki json anki book.json --provider deepseek --model deepseek-reasoner`
- Example: print the current config
  - `pdfanki config`
- Example: reset the local config directory
  - `pdfanki config reset`
- Example: list local prompts
  - `pdfanki prompts list`
- Inspect intermediate steps before sending to a model or exporting:
  - `pdfanki pdf json book.pdf`
  - `pdfanki pdf md book.pdf`
- Simulate JSON or markdown generation without writing files:
  - `pdfanki pdf json book.pdf --dry-run`
  - `pdfanki pdf md book.pdf --dry-run`
- Defaults go to the current working directory with filenames derived from the input (`kebab-case`).
- Use `-o, --out` to override the final output path for any conversion command.
- `... anki` commands only write the requested `.apkg` on success. If markdown generation fails, partial/debug markdown artifacts are still written for diagnosis.

Local fixtures
- Put local real files under `fixtures/local/`.
- Expected names:
  - `fixtures/local/sample.pdf`
  - `fixtures/local/sample.pdf.index.json`
  - `fixtures/local/sample.epub`
- These files are gitignored so you can keep private or large source documents out of the repo.

PDF index helpers
- `pdfanki index template <count> [out]`: Generate an `index.json` scaffold.
- `pdfanki pdf json|md|anki <input> --index <path>` expects a JSON array of chapter ranges (1-based pages, inclusive). `title` is optional:

```json
[
  { "start": 1, "end": 3, "title": "Introduction" },
  { "start": 4, "end": 18 },
  { "start": 19, "end": 35, "title": "Chapter 2" }
]
```

- `--index-ranges "<start>-<end>,<start>-<end>"` provides the same PDF section boundaries inline:

```txt
--index-ranges "1-3,4-18,19-35"
```

- Ranges must be in ascending order and must not overlap. Gaps are allowed.
- Use `--full-fidelity` with `pdfanki pdf json` or `pdfanki epub json` to write the unpruned extraction payload.

Minimal JSON shape
Use the same structure for `pdfanki json md`, `pdfanki json anki`, or when inspecting output from `pdfanki pdf json` / `pdfanki epub json`:

```json
{
  "content": [
    { "index": 1, "title": "Chapter 1", "text": "..." },
    { "index": 2, "title": "Chapter 2", "text": "..." }
  ]
}
```
