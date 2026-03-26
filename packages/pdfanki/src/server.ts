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
  startUnit?: number
  endUnit?: number
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

async function loadIndexFile(indexPath?: string): Promise<IndexEntry[] | null> {
  if (!indexPath) return null

  const raw = await fs.readFile(indexPath, 'utf8')
  const parsed = JSON.parse(raw)

  if (!Array.isArray(parsed)) {
    throw new Error('Index file must be a JSON array of chapters')
  }

  return parsed as IndexEntry[]
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
    startUnit,
    endUnit,
    minChars,
    epubFilters,
    debug,
  } = options

  if (!inputPath) {
    throw new Error('inputPath is required')
  }

  const fileType = inferFileType(inputPath, type)
  const fileBuffer = await fs.readFile(inputPath)
  const originalFile = { name: basename(inputPath) }

  if (fileType === 'pdf') {
    const parsedIndex = await loadIndexFile(indexPath)
    const pdfData = await parsePdfWithPdfParse(fileBuffer, Boolean(debug))
    const transformed = transformPdfParseResult(
      pdfData,
      originalFile,
      startUnit,
      endUnit,
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
    startUnit,
    endUnit,
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
