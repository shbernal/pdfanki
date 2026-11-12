import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/epubJsonUtils.js
import EPub, { type Metadata } from "epub";

import { describeError } from "./describeError.js";
import { DEFAULT_EPUB_TITLE_FILTERS, type EpubTitleFilter } from "./epubFilters.js";
import type { BookJson } from "./types/flashcards.js";

/** A chapter as pulled out of the EPUB, before content filtering. */
interface ExtractedChapter {
  index: number;
  title: string;
  text: string;
  originalIndex: number;
  error?: string;
}

/** A chapter kept for conversion. */
interface ContentChapter {
  index: number;
  title: string;
  text: string;
  originalChapterIndex: number;
}

/** A chapter dropped by a filter, with why. */
interface FilteredChapter {
  originalIndex: number;
  title: string;
  reason?: string;
}

/** A title filter rule compiled to a predicate. */
interface TitleMatcher {
  readonly reason: string;
  readonly test: (titleLower: string) => boolean;
}

/** The half-open chapter selection a `--start-section`/`--end-section` pair names. */
interface ChapterRange {
  readonly startIdx: number;
  readonly endIdx: number;
}

/** What `parseEpubWithEpubLib` hands `transformEpubResult`. */
export interface EpubParseResult {
  readonly metadata: Metadata;
  readonly chapters: readonly Readonly<ExtractedChapter>[];
  readonly totalChapters: number;
}

/** The name of the file a transform is describing. */
interface SourceFile {
  readonly name: string;
}

/** A chapter title as the EPUB spells it, or a generated stand-in. */
function chapterTitleOf(title: unknown, chapterNumber: number): string {
  return typeof title === "string" && title.trim().length > 0 ? title : `Section ${chapterNumber}`;
}

const DEFAULT_PREVIEW_CHARS = 120;

const ANSI_BRIGHT_BLUE = "\u001B[94m";
const ANSI_BRIGHT_GREEN = "\u001B[92m";
const ANSI_BRIGHT_RED = "\u001B[91m";
const ANSI_BRIGHT_YELLOW = "\u001B[93m";
const ANSI_UNDERLINE = "\u001B[4m";
const ANSI_RESET = "\u001B[0m";

function canUseColor(): boolean {
  return process.stdout.isTTY && process.env.NO_COLOR !== "1";
}

function styleText(
  text: string,
  options: Readonly<{
    useColor?: boolean;
    color?: "blue" | "green" | "red" | "yellow";
    underline?: boolean;
  }> = {},
): string {
  const useColor = options.useColor === true;
  const { color } = options;
  const underline = options.underline === true;
  if (!useColor) {
    return text;
  }

  let prefix = "";
  if (underline) {
    prefix += ANSI_UNDERLINE;
  }
  if (color === "blue") {
    prefix += ANSI_BRIGHT_BLUE;
  } else if (color === "green") {
    prefix += ANSI_BRIGHT_GREEN;
  } else if (color === "red") {
    prefix += ANSI_BRIGHT_RED;
  } else if (color === "yellow") {
    prefix += ANSI_BRIGHT_YELLOW;
  }

  if (!prefix) {
    return text;
  }
  return `${prefix}${text}${ANSI_RESET}`;
}

function formatNumberGroups(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absValue = Math.abs(Math.trunc(value));
  const grouped = absValue.toString().replaceAll(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${grouped}`;
}

function formatChapterLabel(chapterNumber: number, totalChapters: number): string {
  const width = Math.max(2, String(totalChapters).length);
  return `${String(chapterNumber).padStart(width, " ")}.`;
}

function parseSectionSelectionValue(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" && typeof value !== "string") {
    throw new TypeError(`${label} must be an integer`);
  }

  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`${label} must be an integer`);
  }

  return parsed;
}

function resolveChapterRange(
  totalChapters: number,
  startChapter?: unknown,
  endChapter?: unknown,
): ChapterRange {
  const parsedStart = parseSectionSelectionValue(startChapter, "Start section");
  const parsedEnd = parseSectionSelectionValue(endChapter, "End section");
  const startIdx = (parsedStart ?? 1) - 1;
  const endIdx = (parsedEnd ?? totalChapters) - 1;

  if (startIdx < 0 || startIdx >= totalChapters) {
    throw new Error(`Start section ${parsedStart} is out of range (1-${totalChapters})`);
  }
  if (endIdx < 0 || endIdx >= totalChapters) {
    throw new Error(`End section ${parsedEnd} is out of range (1-${totalChapters})`);
  }
  if (startIdx > endIdx) {
    throw new Error("Start section cannot be greater than end section");
  }

  return { startIdx, endIdx };
}

function getChapterRangeReason(chapterNumber: number, selectedRange: ChapterRange): string | null {
  if (chapterNumber < selectedRange.startIdx + 1 || chapterNumber > selectedRange.endIdx + 1) {
    return `outside range ${selectedRange.startIdx + 1}-${selectedRange.endIdx + 1}`;
  }

  return null;
}

/**
 * Parse EPUB using epub library and return a promise
 */
export function parseEpubWithEpubLib(
  fileBuffer: Buffer | Uint8Array,
  fileName: string,
  titleFilters: readonly EpubTitleFilter[] = DEFAULT_EPUB_TITLE_FILTERS,
  minChars?: number,
  preview = false,
  previewChars = DEFAULT_PREVIEW_CHARS,
  excludedChapters?: ReadonlySet<number>,
  startChapter?: unknown,
  endChapter?: unknown,
): Promise<EpubParseResult> {
  return (async () => {
    // Create a temporary file since epub library expects a file path
    const tempFilePath = join(tmpdir(), `temp_epub_${Date.now()}_${fileName}`);

    try {
      // Write buffer to temporary file
      writeFileSync(tempFilePath, fileBuffer);

      console.log(`Parsing EPUB file: ${fileName}`);
      const epub = new EPub(tempFilePath);
      await epub.parse();

      const useColor = canUseColor();
      const titleMatchers = buildTitleMatchers(titleFilters);
      const bookTitle =
        (epub.metadata.title || fileName.replace(/\.epub$/i, "")).trim() || fileName;
      console.log(
        styleText(bookTitle, {
          useColor,
          color: "blue",
          underline: true,
        }),
      );

      // Get content list (chapters)
      const chapters = epub.flow;
      const totalChapters = chapters.length;
      const selectedRange = resolveChapterRange(totalChapters, startChapter, endChapter);

      const sectionsFoundMessage = `${totalChapters} content sections:`;
      console.log(
        styleText(sectionsFoundMessage, {
          useColor,
          color: "blue",
        }),
      );

      // Extract text from all chapters
      const extractedChapters: ExtractedChapter[] = [];
      for (const [i, chapter] of chapters.entries()) {
        const chapterNumber = i + 1;
        const chapterTitle = chapterTitleOf(chapter.title, chapterNumber);
        const styledChapterTitle = styleText(chapterTitle, {
          useColor,
          color: "blue",
        });
        const selectionReason = getSelectionFilterReason(
          chapterNumber,
          selectedRange,
          excludedChapters,
        );

        if (selectionReason) {
          extractedChapters.push({
            index: chapterNumber,
            title: chapterTitle,
            text: "",
            originalIndex: chapterNumber,
          });
          const filteredChapterLabel = styleText(formatChapterLabel(chapterNumber, totalChapters), {
            useColor,
            color: "red",
          });
          console.log(
            `${filteredChapterLabel} ${styleText("[filtered out]", { useColor, color: "red" })} "${styledChapterTitle}" - ${selectionReason}`,
          );
          continue;
        }

        try {
          // Get chapter content
          const cleanText = cleanHtmlText(await epub.getChapter(chapter.id));
          const sectionCharCount = cleanText.length;
          const filterResult = shouldFilterContent(
            chapterNumber,
            chapterTitle,
            cleanText,
            titleMatchers,
            minChars,
            selectedRange,
            excludedChapters,
          );

          extractedChapters.push({
            index: chapterNumber,
            title: chapterTitle,
            text: cleanText,
            originalIndex: chapterNumber,
          });
          const charCountLabel = styleText(`${formatNumberGroups(sectionCharCount)} char`, {
            useColor,
            color: "yellow",
          });

          if (filterResult.shouldFilter) {
            const filteredChapterLabel = styleText(
              formatChapterLabel(chapterNumber, totalChapters),
              {
                useColor,
                color: "red",
              },
            );
            console.log(
              `${filteredChapterLabel} ${styleText("[filtered out]", { useColor, color: "red" })} "${styledChapterTitle}" ${charCountLabel} - ${filterResult.reason}`,
            );
          } else {
            const processedChapterLabel = styleText(
              formatChapterLabel(chapterNumber, totalChapters),
              {
                useColor,
                color: "green",
              },
            );
            console.log(
              `${processedChapterLabel} ${styleText("Processing:", { useColor, color: "green" })} ${styledChapterTitle} ${charCountLabel}`,
            );

            if (preview) {
              console.log(`  ${buildPreviewText(cleanText, previewChars)}`);
            }
          }
        } catch (chapterError) {
          const reason = describeError(chapterError);
          console.warn(`Failed to extract chapter "${chapterTitle}": ${reason}`);
          // Add empty chapter to maintain index consistency
          extractedChapters.push({
            index: chapterNumber,
            title: chapterTitle,
            text: "",
            originalIndex: chapterNumber,
            error: reason,
          });
        }
      }

      return {
        metadata: epub.metadata,
        chapters: extractedChapters,
        totalChapters,
      };
    } catch (error) {
      throw new Error(`Failed to parse EPUB: ${describeError(error)}`, { cause: error });
    } finally {
      try {
        unlinkSync(tempFilePath);
      } catch {
        console.warn(`Could not clean up temporary file: ${tempFilePath}`);
      }
    }
  })();
}

/**
 * Transform EPUB result to match PDF output format
 */
export function transformEpubResult(
  epubData: EpubParseResult,
  originalFile: SourceFile,
  startChapter?: unknown,
  endChapter?: unknown,
  titleFilters: readonly EpubTitleFilter[] = DEFAULT_EPUB_TITLE_FILTERS,
  minChars?: number,
  excludedChapters?: ReadonlySet<number>,
): BookJson {
  const { metadata, chapters, totalChapters } = epubData;
  const selectedRange = resolveChapterRange(totalChapters, startChapter, endChapter);

  const content: ContentChapter[] = [];
  const filteredOut: FilteredChapter[] = [];
  let contentNumber = 1;

  const titleMatchers = buildTitleMatchers(titleFilters);

  // Process all chapters so out-of-range sections are counted as filtered.
  for (const [i, chapter] of chapters.entries()) {
    const chapterNumber = i + 1;

    // Empty text is one of the reasons this filters on, so a kept chapter has text.
    const filterResult = shouldFilterContent(
      chapterNumber,
      chapter.title,
      chapter.text,
      titleMatchers,
      minChars,
      selectedRange,
      excludedChapters,
    );

    if (filterResult.shouldFilter) {
      filteredOut.push({
        originalIndex: chapterNumber,
        title: chapter.title,
        ...(filterResult.reason === undefined ? {} : { reason: filterResult.reason }),
      });
      continue;
    }

    content.push({
      index: contentNumber,
      title: chapter.title,
      text: chapter.text,
      originalChapterIndex: chapterNumber,
    });
    contentNumber++;
  }

  // Build metadata to match PDF format
  const transformedMetadata = {
    title: metadata.title || originalFile.name.replace(".epub", ""),
    author: metadata.creator || "Unknown Author",
    publisher: metadata.publisher || "Unknown Publisher",
    date: metadata.date || "Unknown Date",
    language: metadata.language || "Unknown Language",
    // `ISBN` is not one of the OPF fields the epub library types, so it arrives
    // through that interface's index signature as `unknown`.
    isbn: typeof metadata.ISBN === "string" ? metadata.ISBN : null,
    fileType: "epub",
    totalPages: totalChapters, // For EPUB, chapters are equivalent to "pages"
    extractedPages: selectedRange.endIdx - selectedRange.startIdx + 1,
    extractedSections: content.length,
    filteredSections: filteredOut.length,
    extractedRange: `Chapters ${selectedRange.startIdx + 1}-${selectedRange.endIdx + 1}`,
    processingMethod: "epub-library",
    hasIndex: true, // EPUB inherently has structured chapters
    indexChapters: totalChapters,
  };

  return {
    metadata: transformedMetadata,
    content,
  };
}

function buildPreviewText(text: string, previewChars: number): string {
  const normalizedPreviewChars =
    Number.isInteger(previewChars) && previewChars > 0 ? previewChars : DEFAULT_PREVIEW_CHARS;
  const normalizedText = text.replaceAll(/\s+/g, " ").trim();

  if (!normalizedText) {
    return "[empty]";
  }

  if (normalizedText.length <= normalizedPreviewChars) {
    return normalizedText;
  }

  return `${normalizedText.slice(0, normalizedPreviewChars).trimEnd()}...`;
}

/**
 * Helper function to clean HTML and extract plain text
 */
function cleanHtmlText(htmlContent: string): string {
  if (!htmlContent) {
    return "";
  }

  // Remove HTML tags and decode entities
  const text = htmlContent
    .replaceAll(/<script[^>]*>.*?<\/script>/gi, "") // Remove scripts
    .replaceAll(/<style[^>]*>.*?<\/style>/gi, "") // Remove styles
    .replaceAll(/<[^>]*>/g, "") // Remove HTML tags
    .replaceAll("&nbsp;", " ") // Replace non-breaking spaces
    .replaceAll("&amp;", "&") // Replace HTML entities
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll(/\s+/g, " ") // Normalize whitespace
    .trim();

  return text;
}

/**
 * Function to check if content should be filtered out
 */
function buildTitleMatchers(filters: readonly EpubTitleFilter[]): TitleMatcher[] {
  const matchers: TitleMatcher[] = [];

  for (const rule of filters) {
    if (rule.type === "string" && typeof rule.value === "string") {
      const normalized = rule.value.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      matchers.push({
        reason: rule.value,
        test: (titleLower) => titleLower === normalized,
      });
    } else if (rule.type === "regex" && typeof rule.pattern === "string") {
      try {
        const regex = new RegExp(rule.pattern, rule.flags ?? "i");
        matchers.push({
          reason: rule.pattern,
          test: (titleLower) => regex.test(titleLower),
        });
      } catch (error) {
        console.warn(
          `Skipping invalid EPUB title filter regex "${rule.pattern}": ${describeError(error)}`,
        );
      }
    }
  }

  return matchers;
}

function getSelectionFilterReason(
  chapterNumber: number,
  selectedRange: ChapterRange,
  excludedChapters?: ReadonlySet<number>,
): string | null {
  const rangeReason = getChapterRangeReason(chapterNumber, selectedRange);
  if (rangeReason) {
    return rangeReason;
  }

  if (excludedChapters?.has(chapterNumber)) {
    return "excluded by --exclude-sections";
  }

  return null;
}

function shouldFilterContent(
  chapterNumber: number,
  title: string | undefined,
  text: string | undefined,
  titleMatchers: readonly TitleMatcher[],
  minChars: number | undefined,
  selectedRange: ChapterRange,
  excludedChapters?: ReadonlySet<number>,
): { shouldFilter: boolean; reason?: string } {
  const selectionReason = getSelectionFilterReason(chapterNumber, selectedRange, excludedChapters);
  if (selectionReason) {
    return { shouldFilter: true, reason: selectionReason };
  }

  const textLength = text?.length ?? 0;

  // Check if content is empty
  if (!text || text.trim().length === 0) {
    return { shouldFilter: true, reason: "empty content" };
  }

  if (typeof minChars === "number" && minChars > 0 && textLength < minChars) {
    return {
      shouldFilter: true,
      reason: `below minimum characters: ${formatNumberGroups(textLength)} < ${formatNumberGroups(minChars)}`,
    };
  }

  // Check if title matches filtering patterns (case insensitive)
  if (!title) {
    return { shouldFilter: false };
  }

  const titleLower = title.toLowerCase().trim();

  for (const matcher of titleMatchers) {
    if (matcher.test(titleLower)) {
      return {
        shouldFilter: true,
        reason: `matches filter pattern: ${matcher.reason}`,
      };
    }
  }

  return { shouldFilter: false };
}
