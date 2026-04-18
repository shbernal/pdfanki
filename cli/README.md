# pdfanki

Create Anki decks from PDF/EPUB files using NLP with LLMs.

## Installation

- `pnpm i -g @shbernal/pdfanki-cli`

### Requirements

- Node >=20
- Provider API keys via environment variables: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY`

## Config (XDG)

- Config dir: `$XDG_CONFIG_HOME/pdfanki/` or `~/.pdfanki/` if unset
- Auto-created on first run:
  - `settings.json` with `gemini` as default provider.
  - `prompts/default.md`: default prompt
    - you can select any `.md` in this dir as prompt.

## Usage

- The CLI is organized by source type, then by target type:
  - `pdfanki pdf <json|md|anki> <input>`
  - `pdfanki epub <json|md|anki> <input>`
  - `pdfanki json <md|anki> <input>`
  - `pdfanki md anki <input>`

- Create an Anki deck from a PDF: `pdfanki pdf anki file.pdf --deck-title "Title"`
- Use DeepSeek explicitly (with `DEEPSEEK_API_KEY` set): `pdfanki pdf md file.pdf --provider deepseek --model deepseek-chat`
- Use OpenRouter explicitly (with `OPENROUTER_API_KEY` set): `pdfanki pdf md file.pdf --provider openrouter --model z-ai/glm-5`
- Extract JSON from an EPUB chapter slice: `pdfanki epub json file.epub --start-chapter 3 --end-chapter 5 --min-char 300`
- Build an Anki deck from extracted JSON: `pdfanki json anki file.json --provider deepseek --model deepseek-reasoner`
- Build an Anki deck from existing markdown: `pdfanki md anki deck.md`
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
- Use `-o, --out` to override the final output path for any conversion command.
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
- `--start-chapter <num>` / `--end-chapter <num>` restrict EPUB extraction to a 1-based inclusive chapter range.
- `--min-char <num>` filters out extracted sections with fewer than `<num>` characters.

- PDFs only support filtering through `--index` or `--index-ranges`. EPUB chapter filtering uses `--start-chapter` / `--end-chapter`.

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
