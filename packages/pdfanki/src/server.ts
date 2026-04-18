import { promises as fs } from 'fs'
import { basename, extname } from 'path'
import {
  parsePdfWithPdfParse,
  transformPdfParseResult,
} from './pdfJsonUtils.js'
import { parseEpubWithEpubLib, transformEpubResult } from './epubJsonUtils.js'
import { DEFAULT_EPUB_TITLE_FILTERS, type EpubFilters } from './epubFilters.js'
import { cleanTransformedResult } from './textTransformation.js'
import type { BookJson, IndexEntry } from './types/flashcards.js'
import type { SupportedProvider } from './providers.js'
import { bookJsonToPlainText } from './providers.js'

type SupportedFileType = 'pdf' | 'epub'

export type ConvertFileOptions = {
  inputPath: string
  type?: string
  indexPath?: string
  indexRanges?: string
  startChapter?: number
  endChapter?: number
  minChars?: number
  provider?: SupportedProvider
  model?: string
  epubFilters?: EpubFilters
  debug?: boolean
}

export type ConvertFileResult = {
  data: BookJson
  text: string
  fileType: SupportedFileType
  sourcePath: string
}

function normalizeType(type?: string): SupportedFileType | undefined {
  if (!type) return undefined
  const value = type.toLowerCase()
  if (value === 'pdf' || value === 'application/pdf') return 'pdf'
  if (value === 'epub' || value === 'application/epub+zip') return 'epub'
  return undefined
}

function inferFileType(
  inputPath: string,
  provided?: string,
): SupportedFileType {
  const typeFromArg = normalizeType(provided)
  if (typeFromArg) return typeFromArg

  const ext = extname(inputPath).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.epub') return 'epub'

  throw new Error(
    'Unable to infer file type. Please pass --type pdf|epub or use a .pdf/.epub file extension.',
  )
}

function normalizeIndexTitle(
  value: unknown,
  sourceLabel: string,
  entryNumber: number,
): string | undefined {
  if (typeof value === 'undefined' || value === null) {
    return undefined
  }

  if (typeof value !== 'string') {
    throw new Error(
      `${sourceLabel} entry ${entryNumber} has invalid "title"; expected a string.`,
    )
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeIndexPage(
  value: unknown,
  field: 'start' | 'end',
  sourceLabel: string,
  entryNumber: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${sourceLabel} entry ${entryNumber} has invalid "${field}"; expected a positive integer.`,
    )
  }

  return value
}

function validateIndexEntries(
  entries: IndexEntry[],
  sourceLabel: string,
): IndexEntry[] {
  if (entries.length === 0) {
    throw new Error(`${sourceLabel} must contain at least one range.`)
  }

  for (let i = 0; i < entries.length; i++) {
    const current = entries[i]
    if (current.start > current.end) {
      throw new Error(
        `${sourceLabel} entry ${i + 1} has start page ${current.start} greater than end page ${current.end}.`,
      )
    }

    const previous = entries[i - 1]
    if (!previous) continue

    if (current.start < previous.start) {
      throw new Error(
        `${sourceLabel} entries must be sorted by start page in ascending order.`,
      )
    }

    if (current.start <= previous.end) {
      throw new Error(
        `${sourceLabel} entries ${i} and ${i + 1} overlap on pages ${current.start}-${Math.min(previous.end, current.end)}.`,
      )
    }
  }

  return entries
}

function normalizeIndexEntries(
  rawEntries: unknown[],
  sourceLabel: string,
): IndexEntry[] {
  const entries = rawEntries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `${sourceLabel} entry ${index + 1} must be an object with "start" and "end" fields.`,
      )
    }

    const entryRecord = entry as Record<string, unknown>
    const start = normalizeIndexPage(
      entryRecord.start,
      'start',
      sourceLabel,
      index + 1,
    )
    const end = normalizeIndexPage(
      entryRecord.end,
      'end',
      sourceLabel,
      index + 1,
    )
    const title = normalizeIndexTitle(entryRecord.title, sourceLabel, index + 1)

    return title ? { start, end, title } : { start, end }
  })

  return validateIndexEntries(entries, sourceLabel)
}

async function loadIndexFile(indexPath?: string): Promise<IndexEntry[] | null> {
  if (!indexPath) return null

  const raw = await fs.readFile(indexPath, 'utf8')
  const parsed = JSON.parse(raw)

  if (!Array.isArray(parsed)) {
    throw new Error('Index file must be a JSON array of chapters')
  }

  return normalizeIndexEntries(parsed, 'Index file')
}

function parseIndexRanges(indexRanges?: string): IndexEntry[] | null {
  if (typeof indexRanges === 'undefined') return null

  const trimmed = indexRanges.trim()
  if (!trimmed) {
    throw new Error('Index ranges must not be empty.')
  }

  const parts = trimmed.split(',').map(part => part.trim())
  const entries = parts.map((part, index) => {
    if (!part) {
      throw new Error(
        `Index ranges segment ${index + 1} is empty. Use comma-separated "<start>-<end>" ranges.`,
      )
    }

    const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part)
    if (!match) {
      throw new Error(
        `Index ranges segment ${index + 1} must use "<start>-<end>" syntax.`,
      )
    }

    return {
      start: Number.parseInt(match[1], 10),
      end: Number.parseInt(match[2], 10),
    }
  })

  return validateIndexEntries(entries, 'Index ranges')
}

async function resolveIndexEntries(options: {
  indexPath?: string
  indexRanges?: string
}): Promise<IndexEntry[] | null> {
  const { indexPath, indexRanges } = options

  if (indexPath && typeof indexRanges !== 'undefined') {
    throw new Error('Use either indexPath or indexRanges, not both.')
  }

  if (typeof indexRanges !== 'undefined') {
    return parseIndexRanges(indexRanges)
  }

  return loadIndexFile(indexPath)
}

function applyMinCharsFilter(
  book: BookJson,
  minChars?: number,
): { data: BookJson; filteredCount: number } {
  if (typeof minChars !== 'number' || minChars <= 0) {
    return { data: book, filteredCount: 0 }
  }

  let filteredCount = 0
  const keptSections: BookJson['content'] = []

  for (const section of book.content) {
    const textLength = section.text?.length ?? 0
    if (textLength < minChars) {
      filteredCount++
      continue
    }
    keptSections.push(section)
  }

  if (filteredCount === 0) {
    return { data: book, filteredCount: 0 }
  }

  const reindexedContent = keptSections.map((section, index) => ({
    ...section,
    index: index + 1,
  }))

  return {
    filteredCount,
    data: {
      ...book,
      metadata: {
        ...book.metadata,
        extractedSections: reindexedContent.length,
        filteredSections:
          (book.metadata?.filteredSections ?? 0) + filteredCount,
      },
      content: reindexedContent,
    },
  }
}

export async function convertFileFromPath(
  options: ConvertFileOptions,
): Promise<ConvertFileResult> {
  const {
    inputPath,
    type,
    indexPath,
    indexRanges,
    startChapter,
    endChapter,
    minChars,
    epubFilters,
    debug,
  } = options

  if (!inputPath) {
    throw new Error('inputPath is required')
  }

  if (
    typeof startChapter !== 'undefined' &&
    (!Number.isInteger(startChapter) || startChapter <= 0)
  ) {
    throw new Error('startChapter must be a positive integer')
  }

  if (
    typeof endChapter !== 'undefined' &&
    (!Number.isInteger(endChapter) || endChapter <= 0)
  ) {
    throw new Error('endChapter must be a positive integer')
  }

  const fileType = inferFileType(inputPath, type)
  const fileBuffer = await fs.readFile(inputPath)
  const originalFile = { name: basename(inputPath) }

  if (fileType === 'pdf') {
    if (
      typeof startChapter !== 'undefined' ||
      typeof endChapter !== 'undefined'
    ) {
      throw new Error(
        'PDF extraction does not support chapter selection. Use --index or --index-ranges for PDFs.',
      )
    }

    const parsedIndex = await resolveIndexEntries({ indexPath, indexRanges })
    const pdfData = await parsePdfWithPdfParse(fileBuffer, Boolean(debug))
    const transformed = transformPdfParseResult(
      pdfData,
      originalFile,
      parsedIndex,
    )
    const cleaned = cleanTransformedResult(transformed)
    const { data: filteredByMinChars } = applyMinCharsFilter(cleaned, minChars)
    return {
      data: filteredByMinChars,
      text: bookJsonToPlainText(filteredByMinChars),
      fileType,
      sourcePath: inputPath,
    }
  }

  const appliedTitleFilters = epubFilters?.titles ?? DEFAULT_EPUB_TITLE_FILTERS
  const epubData = await parseEpubWithEpubLib(
    fileBuffer,
    originalFile.name,
    appliedTitleFilters,
    minChars,
  )
  const transformed = transformEpubResult(
    epubData,
    originalFile,
    startChapter,
    endChapter,
    appliedTitleFilters,
    minChars,
  )
  const cleaned = cleanTransformedResult(transformed)
  return {
    data: cleaned,
    text: bookJsonToPlainText(cleaned),
    fileType,
    sourcePath: inputPath,
  }
}

export {
  cleanExtractedText,
  cleanTransformedResult,
} from './textTransformation.js'
export {
  parsePdfWithPdfParse,
  transformPdfParseResult,
  parseEpubWithEpubLib,
  transformEpubResult,
}
export { generateFlashcards, bookJsonToPlainText } from './providers.js'
export {
  DEFAULT_EPUB_TITLE_FILTERS,
  type EpubFilters,
  type EpubTitleFilter,
} from './epubFilters.js'
export type { SupportedProvider } from './providers.js'
export type {
  BookJson,
  ContentSection,
  IndexEntry,
} from './types/flashcards.js'
