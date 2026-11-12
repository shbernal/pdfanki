import type { BookJson, ReadonlyBookJson, ReadonlyContentSection } from "./types/flashcards.js";

/**
 * Clean and normalize text content extracted from PDFs. Takes `unknown` because
 * the sections it runs over come out of PDF and EPUB parsers that promise
 * nothing about a section's `text`; anything that is not a string is an empty
 * one as far as this is concerned.
 */
export function cleanExtractedText(text: unknown): string {
  if (!text || typeof text !== "string") {
    return "";
  }

  let cleanedText = text;

  // 1. Remove special characters like null characters and carriage returns
  cleanedText = cleanedText
    .replaceAll("\0", "") // Remove null characters
    .replaceAll("\r", ""); // Remove carriage returns

  // 2. Collapse every run of whitespace, newlines included, to one space
  cleanedText = cleanedText.replaceAll(/\s+/g, " ");

  // 3. Trim whitespace from start and end
  cleanedText = cleanedText.trim();

  return cleanedText;
}

/** Apply text cleaning to every content section in a transformed result. */
export function cleanTransformedResult(transformedResult: ReadonlyBookJson): BookJson;
export function cleanTransformedResult<T extends null | undefined>(transformedResult: T): T;
// The implementation return type carries `ReadonlyBookJson` that the two
// overloads do not, because the guard below hands the argument straight back
// when there is nothing to clean. The overloads are what a caller sees.
export function cleanTransformedResult(
  transformedResult: ReadonlyBookJson | null | undefined,
): BookJson | ReadonlyBookJson | null | undefined {
  if (!transformedResult?.content) {
    return transformedResult;
  }

  // Create a copy to avoid mutating the original
  const cleanedResult = {
    ...transformedResult,
    content: transformedResult.content.map((section: ReadonlyContentSection) => ({
      ...section,
      text: cleanExtractedText(section.text),
    })),
  };

  return cleanedResult;
}
