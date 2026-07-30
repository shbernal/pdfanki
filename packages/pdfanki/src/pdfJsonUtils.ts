// lib/pdfJsonUtils.js
import { PDFParse, VerbosityLevel } from 'pdf-parse'

/** One extracted unit of PDF text: a chapter, or the whole document. */
type PdfSection = {
  index: number
  title: string
  text: string
  pageRange?: string
  pageCount?: number
  processedPages?: number
}

/**
 * Parse PDF using pdf-parse (pdf.js under the hood) and collect per-page text.
 * @param fileBuffer Raw PDF buffer
 * @param debug When true, enable pdf.js warnings (verbosity 1); default suppresses warnings.
 */
export async function parsePdfWithPdfParse(fileBuffer, debug = false) {
  const parser = new PDFParse({
    data: fileBuffer,
    ...(debug ? { verbosity: VerbosityLevel.WARNINGS } : {}),
  })

  try {
    // Avoid parallel calls so the same buffer isn't transferred twice to the
    // pdf.js worker (Node 24 will throw a DataCloneError otherwise).
    const textResult = await parser.getText()
    const infoResult = await parser.getInfo()

    const pageTexts = textResult.pages?.map(page => page.text ?? '') ?? []

    const metadata =
      (infoResult.metadata &&
        ((infoResult.metadata as { _metadata?: unknown })._metadata ||
          infoResult.metadata)) ||
      {}

    return {
      pageTexts,
      rawTextContent: textResult.text || '',
      info: infoResult.info || {},
      metadata,
      numpages: textResult.total || infoResult.total || pageTexts.length,
      numrender: pageTexts.length,
      version:
        (infoResult.info &&
          (infoResult.info as { PDFFormatVersion?: string })
            .PDFFormatVersion) ||
        null,
    }
  } finally {
    await parser.destroy()
  }
}

/**
 * Transform pdf2json result to our expected format
 */
export function transformPdf2jsonResult(parsedData, originalFile, index) {
  const { pdfData, rawTextContent } = parsedData
  const pages = pdfData.Pages || []
  const meta = pdfData.Meta || {}

  let content: PdfSection[] = []
  let processingMethod = 'pdf2json'

  if (index && Array.isArray(index)) {
    // Process by chapters using the provided index
    content = processWithIndex(pages, index)
    processingMethod = 'pdf2json-with-index'
  } else {
    // Process as a single text document when no index is provided.
    content = processAsSingleText(pages, 0, pages.length - 1, originalFile.name)
    processingMethod = 'pdf2json-single-text'
  }

  // If no structured text found, fall back to raw text content
  if (
    content.length === 0 &&
    rawTextContent &&
    rawTextContent.trim().length > 0
  ) {
    content = [
      {
        index: 1,
        title: originalFile.name.replace('.pdf', ''),
        text: rawTextContent.trim(),
      },
    ]
  }

  // Build metadata
  const metadata = {
    title: meta.Title || originalFile.name.replace('.pdf', ''),
    author: meta.Author || 'Unknown Author',
    creator: meta.Creator || null,
    producer: meta.Producer || null,
    creationDate: meta.CreationDate || null,
    modificationDate: meta.ModDate || null,
    fileType: 'pdf',
    totalPages: pages.length,
    extractedPages: index ? getTotalPagesFromIndex(index) : pages.length,
    extractedSections: content.length,
    filteredSections: 0,
    extractedRange: index ? `Chapters 1-${index.length}` : 'All Pages',
    processingMethod,
    pdfVersion: meta.PDFFormatVersion || null,
    hasAcroForm: meta.IsAcroFormPresent || false,
    hasXFA: meta.IsXFAPresent || false,
    hasIndex: !!index,
    indexChapters: index?.length || 0,
  }

  return {
    metadata,
    content,
  }
}

/**
 * Transform pdf-parse result to our expected format (similar to pdf2json path).
 */
export function transformPdfParseResult(parsedData, originalFile, index) {
  const pageTexts = parsedData.pageTexts || []
  const totalPages = parsedData.numpages || pageTexts.length
  const meta = parsedData.info || {}
  const rawTextContent = parsedData.rawTextContent

  let content: PdfSection[] = []
  let processingMethod = 'pdf-parse'

  if (index && Array.isArray(index)) {
    content = processWithIndexFromPageText(pageTexts, index)
    processingMethod = 'pdf-parse-with-index'
  } else {
    content = processAsSingleTextFromPages(
      pageTexts,
      0,
      totalPages - 1,
      originalFile.name,
    )
    processingMethod = 'pdf-parse-single-text'
  }

  if (
    content.length === 0 &&
    rawTextContent &&
    rawTextContent.trim().length > 0
  ) {
    content = [
      {
        index: 1,
        title: originalFile.name.replace('.pdf', ''),
        text: rawTextContent.trim(),
      },
    ]
  }

  const metadata = {
    title:
      meta.Title ||
      meta.title ||
      (parsedData.metadata && parsedData.metadata.title) ||
      originalFile.name.replace('.pdf', ''),
    author:
      meta.Author ||
      meta.author ||
      (parsedData.metadata && parsedData.metadata.author) ||
      'Unknown Author',
    creator: meta.Creator || null,
    producer: meta.Producer || null,
    creationDate: meta.CreationDate || null,
    modificationDate: meta.ModDate || null,
    fileType: 'pdf',
    totalPages: totalPages,
    extractedPages: index ? getTotalPagesFromIndex(index) : totalPages,
    extractedSections: content.length,
    filteredSections: 0,
    extractedRange: index ? `Chapters 1-${index.length}` : 'All Pages',
    processingMethod,
    pdfVersion: parsedData.version || null,
    hasIndex: !!index,
    indexChapters: index?.length || 0,
  }

  return {
    metadata,
    content,
  }
}

/**
 * Process PDF with chapter index
 */
function processWithIndex(pages, index) {
  const content: PdfSection[] = []

  index.forEach((chapter, chapterIndex) => {
    const title =
      typeof chapter.title === 'string' && chapter.title.trim().length > 0
        ? chapter.title.trim()
        : `Section ${chapterIndex + 1}`
    const startPage = chapter.start - 1 // Convert to 0-based index
    const endPage = chapter.end - 1 // Convert to 0-based index

    // Validate page range
    if (startPage < 0 || endPage >= pages.length || startPage > endPage) {
      console.warn(
        `Skipping chapter "${title}": invalid page range ${chapter.start}-${chapter.end}`,
      )
      return
    }

    // Extract text from chapter pages
    let chapterText = ''
    for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
      const pageText = extractTextFromPage(pages[pageIndex])
      if (pageText && pageText.trim().length > 0) {
        chapterText += pageText.trim() + '\n\n'
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
      })
    } else {
      console.warn(`Chapter "${title}" has no extractable text`)
    }
  })

  return content
}

/**
 * Process PDF with chapter index using plain page text.
 */
function processWithIndexFromPageText(pageTexts, index) {
  const content: PdfSection[] = []
  const totalPages = pageTexts.length

  index.forEach((chapter, chapterIndex) => {
    const title =
      typeof chapter.title === 'string' && chapter.title.trim().length > 0
        ? chapter.title.trim()
        : `Section ${chapterIndex + 1}`
    const startPage = chapter.start - 1
    const endPage = chapter.end - 1

    if (startPage < 0 || endPage >= totalPages || startPage > endPage) {
      console.warn(
        `Skipping chapter "${title}": invalid page range ${chapter.start}-${chapter.end}`,
      )
      return
    }

    let chapterText = ''
    for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
      const pageText = pageTexts[pageIndex]
      if (pageText && pageText.trim().length > 0) {
        chapterText += pageText.trim() + '\n\n'
      }
    }

    if (chapterText.trim().length > 0) {
      content.push({
        index: chapterIndex + 1,
        title,
        text: chapterText.trim(),
        pageRange: `${chapter.start}-${chapter.end}`,
        pageCount: endPage - startPage + 1,
      })
    } else {
      console.warn(`Chapter "${title}" has no extractable text`)
    }
  })

  return content
}

/**
 * Process PDF as a single text document (new default when no index)
 */
function processAsSingleText(filteredPages, startPage, endPage, fileName) {
  let allText = ''
  let processedPages = 0

  filteredPages.forEach(page => {
    const pageText = extractTextFromPage(page)
    if (pageText && pageText.trim().length > 0) {
      allText += pageText.trim() + '\n\n'
      processedPages++
    }
  })

  // Only return content if we found text
  if (allText.trim().length > 0) {
    const actualStartPage = startPage + 1
    const actualEndPage = endPage + 1

    return [
      {
        index: 1,
        title: fileName.replace('.pdf', ''),
        text: allText.trim(),
        pageRange: `${actualStartPage}-${actualEndPage}`,
        pageCount: endPage - startPage + 1,
        processedPages: processedPages,
      },
    ]
  }

  return []
}

/**
 * Process PDF as a single text document from per-page text.
 */
function processAsSingleTextFromPages(
  filteredPages,
  startPage,
  endPage,
  fileName,
) {
  let allText = ''
  let processedPages = 0

  filteredPages.forEach(pageText => {
    if (pageText && pageText.trim().length > 0) {
      allText += pageText.trim() + '\n\n'
      processedPages++
    }
  })

  if (allText.trim().length > 0) {
    const actualStartPage = startPage + 1
    const actualEndPage = endPage + 1

    return [
      {
        index: 1,
        title: fileName.replace('.pdf', ''),
        text: allText.trim(),
        pageRange: `${actualStartPage}-${actualEndPage}`,
        pageCount: endPage - startPage + 1,
        processedPages: processedPages,
      },
    ]
  }

  return []
}

/**
 * Calculate total pages covered by index
 */
function getTotalPagesFromIndex(index) {
  return index.reduce((total, chapter) => {
    return total + (chapter.end - chapter.start + 1)
  }, 0)
}

/**
 * Extract text content from a pdf2json page object
 */
function extractTextFromPage(page) {
  if (!page.Texts || !Array.isArray(page.Texts)) {
    return ''
  }

  let pageText = ''

  // Sort texts by Y position (top to bottom), then X position (left to right)
  const sortedTexts = page.Texts.slice().sort((a, b) => {
    if (Math.abs(a.y - b.y) < 0.1) {
      // Same line
      return a.x - b.x // Sort by X position
    }
    return a.y - b.y // Sort by Y position
  })

  sortedTexts.forEach(textObj => {
    if (textObj.R && Array.isArray(textObj.R)) {
      textObj.R.forEach(run => {
        if (run.T) {
          // Decode URI-encoded text
          const decodedText = decodeURIComponent(run.T)
          pageText += decodedText + ' '
        }
      })
    }
  })

  return pageText
}
