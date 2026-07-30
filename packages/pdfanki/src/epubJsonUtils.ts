// lib/epubJsonUtils.js
import EPub from 'epub'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_EPUB_TITLE_FILTERS } from './epubFilters.js'

/** A chapter as pulled out of the EPUB, before content filtering. */
interface ExtractedChapter {
  index: number
  title: string
  text: string
  originalIndex: number
  error?: string
}

/** A chapter kept for conversion. */
interface ContentChapter {
  index: number
  title: string
  text: string
  originalChapterIndex: number
}

/** A chapter dropped by a filter, with why. */
interface FilteredChapter {
  originalIndex: number
  title: string
  reason?: string
}

/** A title filter rule compiled to a predicate. */
interface TitleMatcher {
  reason: string
  test: (titleLower: string) => boolean
}

const ANSI_BRIGHT_BLUE = '\u001b[94m'
const ANSI_BRIGHT_GREEN = '\u001b[92m'
const ANSI_BRIGHT_RED = '\u001b[91m'
const ANSI_BRIGHT_YELLOW = '\u001b[93m'
const ANSI_UNDERLINE = '\u001b[4m'
const ANSI_RESET = '\u001b[0m'

function canUseColor() {
  return process.stdout.isTTY && process.env.NO_COLOR !== '1'
}

function styleText(
  text: string,
  options: {
    useColor?: boolean
    color?: 'blue' | 'green' | 'red' | 'yellow'
    underline?: boolean
  } = {},
) {
  const useColor = options.useColor === true
  const color = options.color
  const underline = options.underline === true
  if (!useColor) return text

  let prefix = ''
  if (underline) {
    prefix += ANSI_UNDERLINE
  }
  if (color === 'blue') {
    prefix += ANSI_BRIGHT_BLUE
  } else if (color === 'green') {
    prefix += ANSI_BRIGHT_GREEN
  } else if (color === 'red') {
    prefix += ANSI_BRIGHT_RED
  } else if (color === 'yellow') {
    prefix += ANSI_BRIGHT_YELLOW
  }

  if (!prefix) return text
  return `${prefix}${text}${ANSI_RESET}`
}

function formatNumberGroups(value: number): string {
  const sign = value < 0 ? '-' : ''
  const absValue = Math.abs(Math.trunc(value))
  const grouped = absValue.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${sign}${grouped}`
}

function formatChapterLabel(
  chapterNumber: number,
  totalChapters: number,
): string {
  const width = Math.max(2, String(totalChapters).length)
  return `${String(chapterNumber).padStart(width, ' ')}.`
}

function parseSectionSelectionValue(value, label: string): number | undefined {
  if (typeof value === 'undefined' || value === null) {
    return undefined
  }

  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`)
  }

  return parsed
}

function resolveChapterRange(
  totalChapters: number,
  startChapter?,
  endChapter?,
) {
  const parsedStart = parseSectionSelectionValue(startChapter, 'Start section')
  const parsedEnd = parseSectionSelectionValue(endChapter, 'End section')
  const startIdx = (parsedStart ?? 1) - 1
  const endIdx = (parsedEnd ?? totalChapters) - 1

  if (startIdx < 0 || startIdx >= totalChapters) {
    throw new Error(
      `Start section ${parsedStart} is out of range (1-${totalChapters})`,
    )
  }
  if (endIdx < 0 || endIdx >= totalChapters) {
    throw new Error(
      `End section ${parsedEnd} is out of range (1-${totalChapters})`,
    )
  }
  if (startIdx > endIdx) {
    throw new Error('Start section cannot be greater than end section')
  }

  return { startIdx, endIdx }
}

function getChapterRangeReason(
  chapterNumber: number,
  selectedRange: { startIdx: number; endIdx: number },
): string | null {
  if (
    chapterNumber < selectedRange.startIdx + 1 ||
    chapterNumber > selectedRange.endIdx + 1
  ) {
    return `outside range ${selectedRange.startIdx + 1}-${selectedRange.endIdx + 1}`
  }

  return null
}

/**
 * Parse EPUB using epub library and return a promise
 */
export function parseEpubWithEpubLib(
  fileBuffer,
  fileName,
  titleFilters = DEFAULT_EPUB_TITLE_FILTERS,
  minChars?,
  preview = false,
  previewChars = 120,
  excludedChapters?: ReadonlySet<number>,
  startChapter?,
  endChapter?,
) {
  return (async () => {
    // Create a temporary file since epub library expects a file path
    const tempFilePath = join(tmpdir(), `temp_epub_${Date.now()}_${fileName}`)

    try {
      // Write buffer to temporary file
      writeFileSync(tempFilePath, fileBuffer)

      console.log(`Parsing EPUB file: ${fileName}`)
      const epub = new EPub(tempFilePath)
      await epub.parse()

      const useColor = canUseColor()
      const titleMatchers = buildTitleMatchers(titleFilters)
      const bookTitle =
        (epub.metadata.title || fileName.replace(/\.epub$/i, '')).trim() ||
        fileName
      console.log(
        styleText(bookTitle, {
          useColor,
          color: 'blue',
          underline: true,
        }),
      )

      // Get content list (chapters)
      const chapters = epub.flow
      const totalChapters = chapters.length
      const selectedRange = resolveChapterRange(
        totalChapters,
        startChapter,
        endChapter,
      )

      const sectionsFoundMessage = `${totalChapters} content sections:`
      console.log(
        styleText(sectionsFoundMessage, {
          useColor,
          color: 'blue',
        }),
      )

      // Extract text from all chapters
      const extractedChapters: ExtractedChapter[] = []
      for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i]
        const chapterNumber = i + 1
        const chapterTitle = chapter.title || `Section ${chapterNumber}`
        const styledChapterTitle = styleText(chapterTitle, {
          useColor,
          color: 'blue',
        })
        const selectionReason = getSelectionFilterReason(
          chapterNumber,
          selectedRange,
          excludedChapters,
        )

        if (selectionReason) {
          extractedChapters.push({
            index: chapterNumber,
            title: chapterTitle,
            text: '',
            originalIndex: chapterNumber,
          })
          const filteredChapterLabel = styleText(
            formatChapterLabel(chapterNumber, totalChapters),
            {
              useColor,
              color: 'red',
            },
          )
          console.log(
            `${filteredChapterLabel} ${styleText('[filtered out]', { useColor, color: 'red' })} "${styledChapterTitle}" - ${selectionReason}`,
          )
          continue
        }

        try {
          // Get chapter content
          const chapterText = await getChapterText(epub, chapter.id)
          const cleanText = cleanHtmlText(chapterText)
          const sectionCharCount = cleanText.length
          const filterResult = shouldFilterContent(
            chapterNumber,
            chapterTitle,
            cleanText,
            titleMatchers,
            minChars,
            selectedRange,
            excludedChapters,
          )

          extractedChapters.push({
            index: chapterNumber,
            title: chapterTitle,
            text: cleanText,
            originalIndex: chapterNumber,
          })
          const charCountLabel = styleText(
            `${formatNumberGroups(sectionCharCount)} char`,
            {
              useColor,
              color: 'yellow',
            },
          )

          if (filterResult.shouldFilter) {
            const filteredChapterLabel = styleText(
              formatChapterLabel(chapterNumber, totalChapters),
              {
                useColor,
                color: 'red',
              },
            )
            console.log(
              `${filteredChapterLabel} ${styleText('[filtered out]', { useColor, color: 'red' })} "${styledChapterTitle}" ${charCountLabel} - ${filterResult.reason}`,
            )
          } else {
            const processedChapterLabel = styleText(
              formatChapterLabel(chapterNumber, totalChapters),
              {
                useColor,
                color: 'green',
              },
            )
            console.log(
              `${processedChapterLabel} ${styleText('Processing:', { useColor, color: 'green' })} ${styledChapterTitle} ${charCountLabel}`,
            )

            if (preview) {
              console.log(`  ${buildPreviewText(cleanText, previewChars)}`)
            }
          }
        } catch (chapterError) {
          console.warn(
            `Failed to extract chapter "${chapterTitle}": ${chapterError.message}`,
          )
          // Add empty chapter to maintain index consistency
          extractedChapters.push({
            index: chapterNumber,
            title: chapterTitle,
            text: '',
            originalIndex: chapterNumber,
            error: chapterError.message,
          })
        }
      }

      return {
        metadata: epub.metadata,
        chapters: extractedChapters,
        totalChapters: totalChapters,
      }
    } catch (error) {
      throw new Error(`Failed to parse EPUB: ${(error as Error).message}`)
    } finally {
      try {
        unlinkSync(tempFilePath)
      } catch {
        console.warn(`Could not clean up temporary file: ${tempFilePath}`)
      }
    }
  })()
}

/**
 * Transform EPUB result to match PDF output format
 */
export function transformEpubResult(
  epubData,
  originalFile,
  startChapter,
  endChapter,
  titleFilters = DEFAULT_EPUB_TITLE_FILTERS,
  minChars?,
  excludedChapters?: ReadonlySet<number>,
) {
  const { metadata, chapters, totalChapters } = epubData
  const selectedRange = resolveChapterRange(
    totalChapters,
    startChapter,
    endChapter,
  )

  const content: ContentChapter[] = []
  const filteredOut: FilteredChapter[] = []
  let contentNumber = 1

  const titleMatchers = buildTitleMatchers(titleFilters)

  // Process all chapters so out-of-range sections are counted as filtered.
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]
    const chapterNumber = i + 1

    if (!chapter) {
      console.warn(`Chapter at index ${i} not found`)
      continue
    }

    // Check if content should be filtered
    const filterResult = shouldFilterContent(
      chapterNumber,
      chapter.title,
      chapter.text,
      titleMatchers,
      minChars,
      selectedRange,
      excludedChapters,
    )

    if (filterResult.shouldFilter) {
      filteredOut.push({
        originalIndex: chapterNumber,
        title: chapter.title,
        reason: filterResult.reason,
      })
      continue
    }

    // Only add chapter if it has meaningful content
    if (chapter.text && chapter.text.trim().length > 0) {
      content.push({
        index: contentNumber,
        title: chapter.title,
        text: chapter.text,
        originalChapterIndex: chapterNumber,
      })
      contentNumber++
    } else {
      filteredOut.push({
        originalIndex: chapterNumber,
        title: chapter.title,
        reason: 'empty content',
      })
    }
  }

  // Build metadata to match PDF format
  const transformedMetadata = {
    title: metadata.title || originalFile.name.replace('.epub', ''),
    author: metadata.creator || 'Unknown Author',
    publisher: metadata.publisher || 'Unknown Publisher',
    date: metadata.date || 'Unknown Date',
    language: metadata.language || 'Unknown Language',
    isbn: metadata.ISBN || null,
    fileType: 'epub',
    totalPages: totalChapters, // For EPUB, chapters are equivalent to "pages"
    extractedPages: selectedRange.endIdx - selectedRange.startIdx + 1,
    extractedSections: content.length,
    filteredSections: filteredOut.length,
    extractedRange: `Chapters ${selectedRange.startIdx + 1}-${selectedRange.endIdx + 1}`,
    processingMethod: 'epub-library',
    hasIndex: true, // EPUB inherently has structured chapters
    indexChapters: totalChapters,
  }

  return {
    metadata: transformedMetadata,
    content: content,
  }
}

/**
 * Helper function to get chapter text (promisified)
 */
function getChapterText(epub, chapterId) {
  return epub.getChapter(chapterId)
}

function buildPreviewText(text: string, previewChars: number): string {
  const normalizedPreviewChars =
    Number.isInteger(previewChars) && previewChars > 0 ? previewChars : 120
  const normalizedText = text.replace(/\s+/g, ' ').trim()

  if (!normalizedText) {
    return '[empty]'
  }

  if (normalizedText.length <= normalizedPreviewChars) {
    return normalizedText
  }

  return `${normalizedText.slice(0, normalizedPreviewChars).trimEnd()}...`
}

/**
 * Helper function to clean HTML and extract plain text
 */
function cleanHtmlText(htmlContent) {
  if (!htmlContent) return ''

  // Remove HTML tags and decode entities
  const text = htmlContent
    .replace(/<script[^>]*>.*?<\/script>/gi, '') // Remove scripts
    .replace(/<style[^>]*>.*?<\/style>/gi, '') // Remove styles
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/&nbsp;/g, ' ') // Replace non-breaking spaces
    .replace(/&amp;/g, '&') // Replace HTML entities
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim()

  return text
}

/**
 * Function to check if content should be filtered out
 */
function buildTitleMatchers(filters) {
  const rules = filters ?? []
  const matchers: TitleMatcher[] = []

  for (const rule of rules) {
    if (!rule) continue

    if (rule.type === 'string' && typeof rule.value === 'string') {
      const normalized = rule.value.trim().toLowerCase()
      if (!normalized) continue
      matchers.push({
        reason: rule.value,
        test: titleLower => titleLower === normalized,
      })
    } else if (rule.type === 'regex' && typeof rule.pattern === 'string') {
      try {
        const regex = new RegExp(rule.pattern, rule.flags ?? 'i')
        matchers.push({
          reason: rule.pattern,
          test: titleLower => regex.test(titleLower),
        })
      } catch (error) {
        console.warn(
          `Skipping invalid EPUB title filter regex "${rule.pattern}": ${(error as Error).message}`,
        )
      }
    }
  }

  return matchers
}

function getSelectionFilterReason(
  chapterNumber: number,
  selectedRange: { startIdx: number; endIdx: number },
  excludedChapters?: ReadonlySet<number>,
): string | null {
  const rangeReason = getChapterRangeReason(chapterNumber, selectedRange)
  if (rangeReason) {
    return rangeReason
  }

  if (excludedChapters?.has(chapterNumber)) {
    return 'excluded by --exclude-sections'
  }

  return null
}

function shouldFilterContent(
  chapterNumber,
  title,
  text,
  titleMatchers,
  minChars?,
  selectedRange?,
  excludedChapters?: ReadonlySet<number>,
) {
  if (!selectedRange) {
    throw new Error('selectedRange is required for EPUB filtering')
  }

  const selectionReason = getSelectionFilterReason(
    chapterNumber,
    selectedRange,
    excludedChapters,
  )
  if (selectionReason) {
    return { shouldFilter: true, reason: selectionReason }
  }

  const textLength = text?.length ?? 0

  // Check if content is empty
  if (!text || text.trim().length === 0) {
    return { shouldFilter: true, reason: 'empty content' }
  }

  if (typeof minChars === 'number' && minChars > 0 && textLength < minChars) {
    return {
      shouldFilter: true,
      reason: `below minimum characters: ${formatNumberGroups(textLength)} < ${formatNumberGroups(minChars)}`,
    }
  }

  // Check if title matches filtering patterns (case insensitive)
  if (!title) return { shouldFilter: false }

  const titleLower = title.toLowerCase().trim()

  for (const matcher of titleMatchers) {
    if (matcher.test(titleLower)) {
      return {
        shouldFilter: true,
        reason: `matches filter pattern: ${matcher.reason}`,
      }
    }
  }

  return { shouldFilter: false }
}
