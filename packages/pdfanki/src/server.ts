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

export async function convertFileFromPath(
  options: ConvertFileOptions,
): Promise<ConvertFileResult> {
  const { inputPath, type, indexPath, startUnit, endUnit, epubFilters, debug } =
    options

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
    return {
      data: cleaned,
      text: bookJsonToPlainText(cleaned),
      fileType,
      sourcePath: inputPath,
    }
  }

  const epubData = await parseEpubWithEpubLib(fileBuffer, originalFile.name)
  const transformed = transformEpubResult(
    epubData,
    originalFile,
    startUnit,
    endUnit,
    epubFilters?.titles ?? DEFAULT_EPUB_TITLE_FILTERS,
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
