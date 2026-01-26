# pdfanki

Create Anki decks from PDF/EPUB files using NLP with LLMs.

## Installation

- `pnpm i -g @shbernal/pdfanki-cli`

### Requirements

- Node >=20
- Provider API keys via environment variables: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`

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
- `--index` expects a JSON array of chapter ranges for PDFs. Format:

  ```json
  [
    { "title": "Introduction", "start": 1, "end": 3 },
    { "title": "Chapter 1", "start": 4, "end": 18 },
    { "title": "Chapter 2", "start": 19, "end": 35 }
  ]
  ```

- Pages are 1-based and inclusive; `start` ≤ `end`. Each entry maps to one output section.
- `--index-create-template` : creates an `index.json` template for custom separation of sections.
- `--index-count` : specify how many chapters create for the `index.json` template.

- Index is only supported for PDFs. EPUB files generally often provide a well-structured index.

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
