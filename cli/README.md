# pdfanki

Create Anki decks from PDF/EPUB files using NLP with LLMs.

## Installation

- `pnpm i -g @shbernal/pdfanki-cli`

### Requirements

- Node >=20
- Provider API keys via environment variables: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `DEEPSEEK_API_KEY`

## Config (XDG)

- Config dir: `$XDG_CONFIG_HOME/pdfanki/` or `~/.pdfanki/` if unset
- Auto-created on first run:
  - `settings.json` with `gemini` as default provider.
  - `prompts/default.md`: default prompt
    - you can select any `.md` in this dir as prompt.

## Usage

- For each command, you need to specify an input state and output state, based on the steps followed by the CLI :
  - File : EPUB/PDF taken as input (only input)
  - JSON : The contents of the file in JSON
  - Markdown (md) : The flashcards on markdown
  - Anki : The Anki deck in .apkg (only output)

- Create an Anki deck from a PDF/EPUB : `pdfanki --from-file file.pdf --to-anki --deck-title "Title"`
- Use DeepSeek explicitly (with `DEEPSEEK_API_KEY` set): `pdfanki --from-file file.pdf --provider deepseek --model deepseek-chat --to-md`
- List available prompts from the configured prompts directory: `pdfanki list-prompts`
- Print the current `settings.json` config to stdout: `pdfanki config`
- Simulate extraction or markdown generation without writing files: `pdfanki --from-file file.pdf --to-json --dry-run`

- Inspect the file contents before passing it to an AI model : `pdfanki --from-file file.pdf --to-json`
  - Use cases :
    - Check if the file has been correctly separated in sections (for PDF, you'll often need an index file)
    - Remove sections that have not been filtered using regex or minimum of characters

- Inspect the markdown flashcards before creating the deck : `pdfanki --from-file file.pdf --to-md`
  - Use cases :
    - Make editions to the AI model output
    - Add images (option currently not supported by pdfanki)
    - Compress flashcards with similar content (option currently not supported by pdfanki)

### Usage notes

- Default outputs go to the current working directory with filenames derived from the input (`kebab-case`).
- `--dry-run` skips writing JSON, markdown, `.apkg`, and failure artifact files, while keeping the normal terminal feedback.
- Log and UX controls:
  - `--verbose`: detailed per-section logs and provider/model diagnostics.
  - `--quiet` / `-q`: warnings and errors only.
  - `--no-color`: disable ANSI colors.
  - `--no-spinner`: disable loading animations and progress rendering.
- `--index` expects a JSON array of chapter ranges for PDFs. Format:

  ```json
  [
    { "title": "Introduction", "start": 1, "end": 3 },
    { "title": "Chapter 1", "start": 4, "end": 18 },
    { "title": "Chapter 2", "start": 19, "end": 35 }
  ]
  ```

- Pages are 1-based and inclusive; `start` ≤ `end`. Each entry maps to one output section.
- `--start-chapter <num>` / `--end-chapter <num>` restrict EPUB extraction to a 1-based inclusive chapter range.
- Generate a blank index template: `pdfanki index-template 8 --from-file book.pdf` (writes `./book.index.json`; omit `--from-file` to default to `./index.json`).
- `--min-char <num>` filters out extracted sections with fewer than `<num>` characters.

- PDFs only support filtering through `--index`. EPUB chapter filtering uses `--start-chapter` / `--end-chapter`.

### JSON shape for `--from-json` / `--to-json`

The CLI accepts the same minimal JSON it writes with `--to-json`:

- `metadata` is optional and ignored for model calls; omit it for the minimal shape.

```json
{
  "content": [
    { "index": 1, "title": "Chapter 1", "text": "..." },
    { "index": 2, "title": "Chapter 2", "text": "..." }
  ]
}
```
