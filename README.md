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

Config (XDG)
- Config dir: `$XDG_CONFIG_HOME/pdfanki/` or `~/.pdfanki/` if unset
- Auto-created on first run:
  - `settings.json` (defaults to the `gemini` provider)
  - `prompts/default.md` (you can pick any `.md` in this directory as the prompt)

How the CLI works
- You always convert between an input state and an output state:
  - File: PDF/EPUB source
  - JSON: Structured contents of the file
  - Markdown: Flashcards in Markdown
  - Anki: Final `.apkg`
- Example: create an Anki deck from a file
  - `pdfanki --from-file book.pdf --to-anki --deck-title "Book Deck"`
- Example: generate markdown with DeepSeek
  - `pdfanki --from-file book.pdf --provider deepseek --model deepseek-chat --to-md`
- Example: generate markdown with OpenRouter
  - `pdfanki --from-file book.pdf --provider openrouter --model z-ai/glm-5 --to-md`
- Example: print the current config
  - `pdfanki config`
- Inspect intermediate steps before sending to a model or exporting:
  - `pdfanki --from-file book.pdf --to-json`
  - `pdfanki --from-file book.pdf --to-md`
- Simulate JSON or markdown generation without writing files:
  - `pdfanki --from-file book.pdf --to-json --dry-run`
  - `pdfanki --from-file book.pdf --to-md --dry-run`
- Defaults go to the current working directory with filenames derived from the input (`kebab-case`).

Local fixtures
- Put local real files under `fixtures/local/`.
- Expected names:
  - `fixtures/local/sample.pdf`
  - `fixtures/local/sample.pdf.index.json`
  - `fixtures/local/sample.epub`
- These files are gitignored so you can keep private or large source documents out of the repo.

PDF index helpers
- `--index-create-template`: Generate an `index.json` scaffold.
- `--index-count`: Specify how many chapters to include in the template.
- `--index` expects a JSON array of chapter ranges (1-based pages, inclusive):

```json
[
  { "title": "Introduction", "start": 1, "end": 3 },
  { "title": "Chapter 1", "start": 4, "end": 18 },
  { "title": "Chapter 2", "start": 19, "end": 35 }
]
```

Minimal JSON shape
Use the same structure for `--from-json` or when inspecting output from `--to-json`:

```json
{
  "content": [
    { "index": 1, "title": "Chapter 1", "text": "..." },
    { "index": 2, "title": "Chapter 2", "text": "..." }
  ]
}
```
