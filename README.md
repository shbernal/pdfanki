pdfanki
=======

Create Anki decks from PDF/EPUB files using NLP with LLMs. This repository hosts the CLI plus shared packages and tooling that power the end-to-end workflow.

Project layout

- `cli/`: The published CLI (`@shbernal/pdfanki-cli`)
- `fixtures/local/`: Gitignored local real-file fixtures for CLI smoke tests
- `packages/`: Shared libraries used by the CLI
- `tests/books/public-domain/`: Tracked public-domain EPUB inputs for deterministic tests
- `scripts/`, `turbo.json`, `pnpm-workspace.yaml`: Repo-level tooling

Requirements

- Node.js >= 24
- Provider API key exported in your shell for API-backed providers: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY`
- Optional experimental Codex provider: locally installed official `codex` CLI with an existing login; pdfanki calls `codex exec` and does not read Codex auth files directly

Install (CLI)

```bash
pnpm i -g @shbernal/pdfanki-cli
```

Local repo workflows

- Run the local-dev CLI against repo sources from the project root:
  - `pnpm pdfanki-local -- epub json /path/to/book.epub`
- Run the pack/install smoke test from the project root:
  - `pnpm cli-local-test`
- Run deterministic tests against tracked public-domain books and fake model providers:
  - `pnpm test`
- Generate live Codex outputs from tracked public-domain books under `.tmp/live-codex/`:
  - `pnpm test:live:codex`
  - Override the live run reasoning effort with `PDFANKI_LIVE_CODEX_REASONING_EFFORT=high pnpm test:live:codex`
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
  - `settings.json` with nested `output`, `generation`, and `epub` sections
  - `prompts/default.md` (you can pick any `.md` in this directory as the prompt)

Default `settings.json` shape:

```json
{
  "output": {
    "path": ".",
    "paths": {}
  },
  "generation": {
    "defaultProvider": "gemini",
    "defaultPrompt": "default",
    "providers": {
      "gemini": {
        "defaultModel": "gemini-3-pro-preview"
      },
      "codex": {
        "defaultModel": "gpt-5.4",
        "reasoningEffort": "medium"
      }
    }
  },
  "epub": {
    "preview": false,
    "previewChars": 120,
    "filters": {
      "titles": [{ "type": "regex", "pattern": "^contents?$", "flags": "i" }]
    }
  }
}
```

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
- Example: generate markdown through the experimental local Codex CLI provider
  - `pdfanki pdf md book.pdf --provider codex --model gpt-5.4 --codex-reasoning-effort high`
- Example: extract JSON from an EPUB section range
  - `pdfanki epub json book.epub --start-section 3 --end-section 5 --min-char 300`
- Example: extract JSON from an EPUB while skipping specific sections
  - `pdfanki epub json book.epub --exclude-sections "3,7,19,25-27"`
- Example: extract JSON from an EPUB with section previews
  - `pdfanki epub json book.epub --preview`
- Example: extract JSON from an EPUB with 200-character previews
  - `pdfanki epub json book.epub --preview 200`
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
- The `codex` provider is experimental. It pipes each section prompt into `codex exec --ephemeral --skip-git-repo-check`, captures the final Markdown from stdout, and relies on your existing Codex CLI authentication rather than `OPENAI_API_KEY`.
- For Codex, `generation.providers.codex.defaultModel` maps to `codex exec --model`, and `generation.providers.codex.reasoningEffort` maps to a per-run `model_reasoning_effort` config override. CLI flags `--model`, `--codex-reasoning-effort`, and `--codex-profile` take precedence over `settings.json` and do not edit `~/.codex/config.toml`.
- Set `output.path` to change the default output directory for conversion commands.
- Set `output.paths.json`, `output.paths.md`, or `output.paths.apkg` to route specific artifact types to dedicated directories.
- Use `-o, --out` to override the final output path for any conversion command.
- Output path precedence is `--out`, then `output.paths.<artifact>`, then `output.path`.
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
- Use `--preview` to print the first characters of each EPUB section during parsing.
- Use `--preview <num>` or `--preview-chars <num>` to override the EPUB preview length. The default is `120`.

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
