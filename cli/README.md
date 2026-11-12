# pdfanki

[![weekly downloads](https://img.shields.io/npm/dw/%40shbernal%2Fpdfanki-cli.svg?label=npm%20downloads&logo=npm)](https://www.npmjs.com/package/@shbernal/pdfanki-cli)
[![total downloads](https://img.shields.io/npm/dt/%40shbernal%2Fpdfanki-cli.svg?label=npm%20total%20downloads&logo=npm)](https://www.npmjs.com/package/@shbernal/pdfanki-cli)

Create Anki decks from PDF/EPUB files using NLP with LLMs.

## Installation

- `pnpm i -g @shbernal/pdfanki-cli`

### Requirements

- Node >=24
- Provider API keys via environment variables for API-backed providers: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY`
- Optional experimental Codex provider: locally installed official `codex` CLI with an existing login; pdfanki calls `codex exec` and does not read Codex auth files directly

## Config (XDG)

- Config dir: `$XDG_CONFIG_HOME/pdfanki/` or `~/.pdfanki/` if unset
- Auto-created on first run:
  - `settings.json` with nested `output`, `generation`, and `epub` sections.
  - `prompts/default.md`: default prompt
    - you can select any `.md` in this dir as prompt.

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
        "defaultModel": "gemini-3.8-flash"
      },
      "anthropic": {
        "defaultModel": "claude-sonnet-5-5"
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

The file is read key by key. A value that is not the type the setting expects
falls back to that setting's default rather than reaching the command that uses
it, so a `"previewChars": "twelve"` costs you `previewChars` and nothing else. An
unreadable EPUB title filter is dropped and the rest of the array is kept. Keys
pdfanki does not know are ignored, not carried through, and a file that will not
parse at all gives the defaults.

The flat spellings `outputPath`, `defaultProvider`, `defaultPrompt`, `providers`
and `epubFilters` are still read for files written before the nested sections
existed. Where both are present the nested one wins.

## Building from markdown you already have

`pdfanki md anki <input>` takes a Flashcard Markdown file rather than a document,
so no model is involved and no API key is needed.

Images are resolved beside the deck that names them, which is where a relative
reference in a vault points. A reference to `http` or `https` is only fetched
when `--remote-media` is passed; without it the image stays in the card as
written and a warning names it. That is off by default because reaching the
network is a new capability on a command that was already published, not because
downloading is discouraged. `--remote-timeout` bounds one download and defaults
to 10000ms.

Fenced code blocks are coloured at build time for any language Prism is loaded
with, and a fence with no language or an unknown one is left alone rather than
guessed at. The theme's stylesheet is folded into the note type's CSS, so the
colours reach Anki with no media file and nothing to run on the card. Every
command that writes an `.apkg` gets this, not only `md anki`.

For a directory of decks, a note type of your own, or a choice of code theme,
[`ankimd build`](https://www.npmjs.com/package/@ankimd/cli) has all three.

## Usage

- The CLI is organized by source type, then by target type:
  - `pdfanki pdf <json|md|anki> <input>`
  - `pdfanki epub <json|md|anki> <input>`
  - `pdfanki json <md|anki> <input>`
  - `pdfanki md anki <input>`

- Create an Anki deck from a PDF: `pdfanki pdf anki file.pdf --deck-title "Title"`
- Use DeepSeek explicitly (with `DEEPSEEK_API_KEY` set): `pdfanki pdf md file.pdf --provider deepseek --model deepseek-chat`
- Use OpenRouter explicitly (with `OPENROUTER_API_KEY` set): `pdfanki pdf md file.pdf --provider openrouter --model z-ai/glm-5`
- Use the experimental local Codex CLI provider: `pdfanki pdf md file.pdf --provider codex --model gpt-5.4 --codex-reasoning-effort high`
- Extract JSON from an EPUB section slice: `pdfanki epub json file.epub --start-section 3 --end-section 5 --min-char 300`
- Extract JSON from an EPUB while skipping specific sections: `pdfanki epub json file.epub --exclude-sections "3,7,19,25-27"`
- Extract JSON from an EPUB with section previews: `pdfanki epub json file.epub --preview`
- Extract JSON from an EPUB with 200-char previews: `pdfanki epub json file.epub --preview 200`
- Build an Anki deck from extracted JSON: `pdfanki json anki file.json --provider deepseek --model deepseek-reasoner`
- Build an Anki deck from existing markdown: `pdfanki md anki deck.md`
- Same, downloading the images it links to: `pdfanki md anki deck.md --remote-media --remote-timeout 20000`
- List available prompts from the configured prompts directory: `pdfanki prompts list`
- Print the current `settings.json` config to stdout: `pdfanki config`
- Reset the local config directory to defaults: `pdfanki config reset`
- Simulate extraction or markdown generation without writing files: `pdfanki pdf json file.pdf --dry-run`

- Inspect the file contents before passing it to an AI model : `pdfanki pdf json file.pdf`
  - Use cases :
    - Check if the file has been correctly separated in sections (for PDF, you'll often need an index file)
    - Remove sections that have not been filtered using regex or minimum of characters

- Inspect the markdown flashcards before creating the deck : `pdfanki pdf md file.pdf`
  - Use cases :
    - Make editions to the AI model output
    - Add images (option currently not supported by pdfanki)
    - Compress flashcards with similar content (option currently not supported by pdfanki)

### Usage notes

- Default outputs go to the current working directory with filenames derived from the input (`kebab-case`).
- The `codex` provider is experimental. It pipes each section prompt into `codex exec --ephemeral --skip-git-repo-check`, captures the final Markdown from stdout, and relies on your existing Codex CLI authentication rather than `OPENAI_API_KEY`.
- Codex `defaultModel` maps to `codex exec --model`, and `reasoningEffort` maps to a per-run `model_reasoning_effort` config override. CLI flags `--model`, `--codex-reasoning-effort`, and `--codex-profile` override `settings.json` without editing `~/.codex/config.toml`.
- Set `output.path` to change the default output directory for conversion commands.
- Set `output.paths.json`, `output.paths.md`, or `output.paths.apkg` to route specific artifact types to dedicated directories.
- Use `-o, --out` to override the final output path for any conversion command.
- Output path precedence is `--out`, then `output.paths.<artifact>`, then `output.path`.
- `--dry-run` skips writing the requested output and failure artifact files, while keeping the normal terminal feedback.
- Successful `... anki` commands only write the requested `.apkg`. Partial markdown/debug files are written only when markdown generation fails.
- Log and UX controls:
  - `--verbose`: detailed per-section logs and provider/model diagnostics.
  - `--quiet` / `-q`: warnings and errors only.
  - `--no-color`: disable ANSI colors.
  - `--no-spinner`: disable loading animations and progress rendering.
- `pdfanki index template 8 --from-file book.pdf` generates `./book.index.json` by default.
- `--index <path>` expects a JSON array of chapter ranges for PDFs. `title` is optional:

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

- Pages are 1-based and inclusive; `start` ≤ `end`. Each entry maps to one output section.
- Ranges must be in ascending order and must not overlap. Gaps are allowed.
- `--full-fidelity` on `pdfanki pdf json` or `pdfanki epub json` writes the unpruned extraction payload.
- `--start-section <num>` / `--end-section <num>` restrict EPUB extraction to a 1-based inclusive section range.
- `--exclude-sections "<section>,<section>,<start>-<end>"` skips specific EPUB sections by original 1-based section number.
- `--min-char <num>` filters out extracted sections with fewer than `<num>` characters.
- `--preview` prints a text preview under each EPUB section during parsing.
- `--preview <num>` or `--preview-chars <num>` sets the EPUB preview length. If no explicit value is provided and no config value is set, the default is `120`.

- PDFs only support filtering through `--index` or `--index-ranges`. EPUB section filtering uses `--start-section` / `--end-section`.

### JSON shape for `pdfanki json ...`

The CLI accepts the same minimal JSON it writes with `pdfanki pdf json` / `pdfanki epub json`:

- `metadata` is optional and ignored for model calls; omit it for the minimal shape.

```json
{
  "content": [
    { "index": 1, "title": "Chapter 1", "text": "..." },
    { "index": 2, "title": "Chapter 2", "text": "..." }
  ]
}
```
