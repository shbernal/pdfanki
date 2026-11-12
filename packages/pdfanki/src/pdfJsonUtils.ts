// lib/pdfJsonUtils.js
import { type PageTextResult, PDFParse, VerbosityLevel } from "pdf-parse";

import { isList } from "./isList.js";
import type { BookJson, ReadonlyIndexEntry } from "./types/flashcards.js";

/**
 * A PDF's own info and metadata dictionaries. The keys are the document's, not
 * ones this package chose, so every read narrows rather than assumes.
 */
type PdfDictionary = Readonly<Record<string, unknown>>;

/** What `parsePdfWithPdfParse` collects for the transform below. */
export interface PdfParseResult {
  readonly pageTexts: readonly string[];
  readonly rawTextContent: string;
  readonly info: PdfDictionary;
  readonly metadata: unknown;
  readonly numpages: number;
  readonly numrender: number;
  readonly version: string | null;
}

/** How far apart two pdf2json y-positions can be and still be one line. */
const SAME_LINE_TOLERANCE = 0.1;

/** A page as pdf2json models it: positioned runs of URI-encoded text. */
interface Pdf2JsonRun {
  readonly T?: string;
}

interface Pdf2JsonText {
  readonly x: number;
  readonly y: number;
  readonly R?: readonly Pdf2JsonRun[];
}

interface Pdf2JsonPage {
  readonly Texts?: readonly Pdf2JsonText[];
}

/** What pdf2json hands `transformPdf2jsonResult`. */
export interface Pdf2JsonResult {
  readonly pdfData: {
    readonly Pages?: readonly Pdf2JsonPage[];
    readonly Meta?: PdfDictionary;
  };
  readonly rawTextContent?: string;
}

/** The name of the file a transform is describing. */
interface SourceFile {
  readonly name: string;
}

/**
 * The first candidate that is a non-empty string. This is `||` over a run of
 * fallbacks, kept because an empty PDF title must still fall through to the
 * filename rather than be reported as the title.
 */
function firstNonEmptyString(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function isDictionary(value: unknown): value is PdfDictionary {
  return Boolean(value) && typeof value === "object";
}

/** Read one field off an object the parser owns and nothing types. */
function readUnknownField(source: unknown, key: "_metadata" | "PDFFormatVersion"): unknown {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  if (key === "_metadata") {
    return "_metadata" in source ? source._metadata : undefined;
  }

  return "PDFFormatVersion" in source ? source.PDFFormatVersion : undefined;
}

/** Read one field off a metadata dictionary the parser owns and nothing types. */
function readMetadataString(source: unknown, key: "title" | "author"): string | undefined {
  if (!source || typeof source !== "object" || !(key in source)) {
    return undefined;
  }

  const value: unknown =
    key === "title"
      ? "title" in source
        ? source.title
        : undefined
      : "author" in source
        ? source.author
        : undefined;

  return typeof value === "string" ? value : undefined;
}

/** One extracted unit of PDF text: a chapter, or the whole document. */
interface PdfSection {
  index: number;
  title: string;
  text: string;
  pageRange?: string;
  pageCount?: number;
  processedPages?: number;
}

/**
 * Parse PDF using pdf-parse (pdf.js under the hood) and collect per-page text.
 * @param fileBuffer Raw PDF buffer
 * @param debug When true, enable pdf.js warnings (verbosity 1); default suppresses warnings.
 */
export async function parsePdfWithPdfParse(
  fileBuffer: Buffer | Uint8Array,
  debug = false,
): Promise<PdfParseResult> {
  const parser = new PDFParse({
    data: fileBuffer,
    ...(debug ? { verbosity: VerbosityLevel.WARNINGS } : {}),
  });

  try {
    // Avoid parallel calls so the same buffer isn't transferred twice to the
    // pdf.js worker (Node 24 will throw a DataCloneError otherwise).
    const textResult = await parser.getText();
    const infoResult = await parser.getInfo();

    const pageTexts =
      textResult.pages?.map((page: Readonly<PageTextResult>) => page.text ?? "") ?? [];

    // pdf.js nests the document's own metadata one level down under
    // `_metadata` when it has any; otherwise the outer object is it.
    const metadata: unknown = infoResult.metadata
      ? (readUnknownField(infoResult.metadata, "_metadata") ?? infoResult.metadata)
      : {};

    return {
      pageTexts,
      rawTextContent: textResult.text || "",
      info: isDictionary(infoResult.info) ? infoResult.info : {},
      metadata,
      numpages: textResult.total || infoResult.total || pageTexts.length,
      numrender: pageTexts.length,
      version: firstNonEmptyString(readUnknownField(infoResult.info, "PDFFormatVersion")) ?? null,
    };
  } finally {
    await parser.destroy();
  }
}

/**
 * Transform pdf2json result to our expected format
 */
export function transformPdf2jsonResult(
  parsedData: Pdf2JsonResult,
  originalFile: SourceFile,
  index: readonly ReadonlyIndexEntry[] | null | undefined,
): BookJson {
  const { pdfData, rawTextContent } = parsedData;
  const pages: readonly Pdf2JsonPage[] = pdfData.Pages ?? [];
  const meta: PdfDictionary = pdfData.Meta ?? {};

  let content: PdfSection[] = [];
  let processingMethod = "pdf2json";

  if (index && Array.isArray(index)) {
    // Process by chapters using the provided index
    content = processWithIndex(pages, index);
    processingMethod = "pdf2json-with-index";
  } else {
    // Process as a single text document when no index is provided.
    content = processAsSingleText(pages, 0, pages.length - 1, originalFile.name);
    processingMethod = "pdf2json-single-text";
  }

  // If no structured text found, fall back to raw text content
  if (content.length === 0 && rawTextContent && rawTextContent.trim().length > 0) {
    content = [
      {
        index: 1,
        title: originalFile.name.replace(".pdf", ""),
        text: rawTextContent.trim(),
      },
    ];
  }

  // Build metadata
  const metadata = {
    title: firstNonEmptyString(meta.Title) ?? originalFile.name.replace(".pdf", ""),
    author: firstNonEmptyString(meta.Author) ?? "Unknown Author",
    creator: firstNonEmptyString(meta.Creator) ?? null,
    producer: firstNonEmptyString(meta.Producer) ?? null,
    creationDate: firstNonEmptyString(meta.CreationDate) ?? null,
    modificationDate: firstNonEmptyString(meta.ModDate) ?? null,
    fileType: "pdf",
    totalPages: pages.length,
    extractedPages: index ? getTotalPagesFromIndex(index) : pages.length,
    extractedSections: content.length,
    filteredSections: 0,
    extractedRange: index ? `Chapters 1-${index.length}` : "All Pages",
    processingMethod,
    pdfVersion: firstNonEmptyString(meta.PDFFormatVersion) ?? null,
    hasAcroForm: Boolean(meta.IsAcroFormPresent),
    hasXFA: Boolean(meta.IsXFAPresent),
    hasIndex: Boolean(index),
    indexChapters: index?.length ?? 0,
  };

  return {
    metadata,
    content,
  };
}

/**
 * Transform pdf-parse result to our expected format (similar to pdf2json path).
 */
export function transformPdfParseResult(
  parsedData: PdfParseResult,
  originalFile: SourceFile,
  index: readonly ReadonlyIndexEntry[] | null | undefined,
): BookJson {
  const pageTexts: readonly string[] = parsedData.pageTexts;
  const totalPages = parsedData.numpages || pageTexts.length;
  const meta: PdfDictionary = parsedData.info;
  const { rawTextContent } = parsedData;

  let content: PdfSection[] = [];
  let processingMethod = "pdf-parse";

  if (index) {
    content = processWithIndexFromPageText(pageTexts, index);
    processingMethod = "pdf-parse-with-index";
  } else {
    content = processAsSingleTextFromPages(pageTexts, 0, totalPages - 1, originalFile.name);
    processingMethod = "pdf-parse-single-text";
  }

  if (content.length === 0 && rawTextContent && rawTextContent.trim().length > 0) {
    content = [
      {
        index: 1,
        title: originalFile.name.replace(".pdf", ""),
        text: rawTextContent.trim(),
      },
    ];
  }

  const metadata = {
    title:
      firstNonEmptyString(
        meta.Title,
        meta.title,
        readMetadataString(parsedData.metadata, "title"),
      ) ?? originalFile.name.replace(".pdf", ""),
    author:
      firstNonEmptyString(
        meta.Author,
        meta.author,
        readMetadataString(parsedData.metadata, "author"),
      ) ?? "Unknown Author",
    creator: firstNonEmptyString(meta.Creator) ?? null,
    producer: firstNonEmptyString(meta.Producer) ?? null,
    creationDate: firstNonEmptyString(meta.CreationDate) ?? null,
    modificationDate: firstNonEmptyString(meta.ModDate) ?? null,
    fileType: "pdf",
    totalPages,
    extractedPages: index ? getTotalPagesFromIndex(index) : totalPages,
    extractedSections: content.length,
    filteredSections: 0,
    extractedRange: index ? `Chapters 1-${index.length}` : "All Pages",
    processingMethod,
    pdfVersion: parsedData.version,
    hasIndex: Boolean(index),
    indexChapters: index?.length ?? 0,
  };

  return {
    metadata,
    content,
  };
}

/**
 * Process PDF with chapter index
 */
function processWithIndex(
  pages: readonly Pdf2JsonPage[],
  index: readonly ReadonlyIndexEntry[],
): PdfSection[] {
  const content: PdfSection[] = [];

  index.forEach((chapter, chapterIndex) => {
    const title =
      typeof chapter.title === "string" && chapter.title.trim().length > 0
        ? chapter.title.trim()
        : `Section ${chapterIndex + 1}`;
    const startPage = chapter.start - 1; // Convert to 0-based index
    const endPage = chapter.end - 1; // Convert to 0-based index

    // Validate page range
    if (startPage < 0 || endPage >= pages.length || startPage > endPage) {
      console.warn(
        `Skipping chapter "${title}": invalid page range ${chapter.start}-${chapter.end}`,
      );
      return;
    }

    // Extract text from chapter pages
    let chapterText = "";
    /* Sliced rather than indexed: the bounds are checked just above, and a
       slice carries that proof into the loop. */
    for (const page of pages.slice(startPage, endPage + 1)) {
      const pageText = extractTextFromPage(page);
      if (pageText && pageText.trim().length > 0) {
        chapterText += `${pageText.trim()}\n\n`;
      }
    }

    // Only add chapter if it has content
    if (chapterText.trim().length > 0) {
      content.push({
        index: chapterIndex + 1,
        title,
        text: chapterText.trim(),
        pageRange: `${chapter.start}-${chapter.end}`,
        pageCount: endPage - startPage + 1,
      });
    } else {
      console.warn(`Chapter "${title}" has no extractable text`);
    }
  });

  return content;
}

/**
 * Process PDF with chapter index using plain page text.
 */
function processWithIndexFromPageText(
  pageTexts: readonly string[],
  index: readonly ReadonlyIndexEntry[],
): PdfSection[] {
  const content: PdfSection[] = [];
  const totalPages = pageTexts.length;

  index.forEach((chapter, chapterIndex) => {
    const title =
      typeof chapter.title === "string" && chapter.title.trim().length > 0
        ? chapter.title.trim()
        : `Section ${chapterIndex + 1}`;
    const startPage = chapter.start - 1;
    const endPage = chapter.end - 1;

    if (startPage < 0 || endPage >= totalPages || startPage > endPage) {
      console.warn(
        `Skipping chapter "${title}": invalid page range ${chapter.start}-${chapter.end}`,
      );
      return;
    }

    let chapterText = "";
    for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
      const pageText = pageTexts[pageIndex];
      if (pageText && pageText.trim().length > 0) {
        chapterText += `${pageText.trim()}\n\n`;
      }
    }

    if (chapterText.trim().length > 0) {
      content.push({
        index: chapterIndex + 1,
        title,
        text: chapterText.trim(),
        pageRange: `${chapter.start}-${chapter.end}`,
        pageCount: endPage - startPage + 1,
      });
    } else {
      console.warn(`Chapter "${title}" has no extractable text`);
    }
  });

  return content;
}

/**
 * Process PDF as a single text document (new default when no index)
 */
function processAsSingleText(
  filteredPages: readonly Pdf2JsonPage[],
  startPage: number,
  endPage: number,
  fileName: string,
): PdfSection[] {
  let allText = "";
  let processedPages = 0;

  filteredPages.forEach((page) => {
    const pageText = extractTextFromPage(page);
    if (pageText && pageText.trim().length > 0) {
      allText += `${pageText.trim()}\n\n`;
      processedPages++;
    }
  });

  // Only return content if we found text
  if (allText.trim().length > 0) {
    const actualStartPage = startPage + 1;
    const actualEndPage = endPage + 1;

    return [
      {
        index: 1,
        title: fileName.replace(".pdf", ""),
        text: allText.trim(),
        pageRange: `${actualStartPage}-${actualEndPage}`,
        pageCount: endPage - startPage + 1,
        processedPages,
      },
    ];
  }

  return [];
}

/**
 * Process PDF as a single text document from per-page text.
 */
function processAsSingleTextFromPages(
  filteredPages: readonly string[],
  startPage: number,
  endPage: number,
  fileName: string,
): PdfSection[] {
  let allText = "";
  let processedPages = 0;

  filteredPages.forEach((pageText) => {
    if (pageText && pageText.trim().length > 0) {
      allText += `${pageText.trim()}\n\n`;
      processedPages++;
    }
  });

  if (allText.trim().length > 0) {
    const actualStartPage = startPage + 1;
    const actualEndPage = endPage + 1;

    return [
      {
        index: 1,
        title: fileName.replace(".pdf", ""),
        text: allText.trim(),
        pageRange: `${actualStartPage}-${actualEndPage}`,
        pageCount: endPage - startPage + 1,
        processedPages,
      },
    ];
  }

  return [];
}

/**
 * Calculate total pages covered by index
 */
function getTotalPagesFromIndex(index: readonly ReadonlyIndexEntry[]): number {
  return index.reduce((total, chapter) => total + (chapter.end - chapter.start + 1), 0);
}

/**
 * Extract text content from a pdf2json page object
 */
function extractTextFromPage(page: Pdf2JsonPage): string {
  if (!page.Texts || !isList(page.Texts)) {
    return "";
  }

  let pageText = "";

  // Sort texts by Y position (top to bottom), then X position (left to right)
  // Reading order: down the page first, then across whatever shares a line.
  const sortedTexts = page.Texts.toSorted((left, right) => {
    if (Math.abs(left.y - right.y) < SAME_LINE_TOLERANCE) {
      return left.x - right.x;
    }

    return left.y - right.y;
  });

  sortedTexts.forEach((textObj) => {
    if (textObj.R && isList(textObj.R)) {
      textObj.R.forEach((run) => {
        if (run.T) {
          // Decode URI-encoded text
          const decodedText = decodeURIComponent(run.T);
          pageText += `${decodedText} `;
        }
      });
    }
  });

  return pageText;
}
