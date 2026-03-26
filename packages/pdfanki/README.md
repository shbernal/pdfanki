# @shbernal/pdfanki

Core utilities used by the pdfanki CLI for parsing PDF/EPUB files and generating flashcards.

## Entrypoints

- `@shbernal/pdfanki/server`: Node-facing helpers to parse files and call models.
  - `convertFileFromPath({ inputPath, type?, indexPath?, startChapter?, endChapter?, epubFilters?, debug? })` → `{ data, text, fileType, sourcePath }`.
  - `generateFlashcards({ provider, model, apiKey, prompt, content })` → markdown string.
  - `bookJsonToPlainText(book)` to flatten parsed sections for prompting.
- `@shbernal/pdfanki/client`: Browser-safe helpers for JSON validation/editing.
  - `validateJsonStructure(bookJson)` plus undo/delete helpers for sections.
  - `formatFileSize(bytes)` for UI display.
- `@shbernal/pdfanki`: Shared transforms and types (`BookJson`, `IndexEntry`, `ContentSection`, etc).

All exports are ESM-only.
