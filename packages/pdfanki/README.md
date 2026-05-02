# @shbernal/pdfanki

Core utilities used by the pdfanki CLI for parsing PDF/EPUB files and generating flashcards.

## Entrypoints

- `@shbernal/pdfanki/server`: Node-facing helpers to parse files and call models.
  - `convertFileFromPath({ inputPath, type?, indexPath?, indexRanges?, startChapter?, endChapter?, excludeChapters?, epubFilters?, debug? })` → `{ data, text, fileType, sourcePath }`.
  - `generateFlashcards({ provider, model, apiKey, prompt, content })` → markdown string.
  - `bookJsonToPlainText(book)` to flatten parsed sections for prompting.
- `@shbernal/pdfanki/client`: Browser-safe helpers for JSON validation/editing.
  - `validateJsonStructure(bookJson)` plus undo/delete helpers for sections.
  - `formatFileSize(bytes)` for UI display.
- `@shbernal/pdfanki`: Shared transforms and types (`BookJson`, `IndexEntry`, `ContentSection`, etc).

All exports are ESM-only.

For PDFs, `indexPath` expects a JSON array of `{ start, end, title? }` ranges, while `indexRanges` accepts an inline string such as `"12-53,54-92,93-118"`.
