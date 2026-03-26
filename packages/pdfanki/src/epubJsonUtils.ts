// lib/epubJsonUtils.js
import EPub from 'epub'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_EPUB_TITLE_FILTERS } from './epubFilters.js'

const ANSI_BRIGHT_BLUE = '\u001b[94m'
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
    color?: 'blue' | 'red' | 'yellow'
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

/**
 * Parse EPUB using epub library and return a promise
 */
export function parseEpubWithEpubLib(
  fileBuffer,
  fileName,
  titleFilters = DEFAULT_EPUB_TITLE_FILTERS,
  minChars?,
) {
  return new Promise((resolve, reject) => {
    try {
      // Create a temporary file since epub library expects a file path
      const tempFilePath = join(tmpdir(), `temp_epub_${Date.now()}_${fileName}`)

      // Write buffer to temporary file
      writeFileSync(tempFilePath, fileBuffer)

      console.log(`Parsing EPUB file: ${fileName}`)
      const epub = new EPub(tempFilePath)

      epub.on('error', function (err) {
        // Clean up temp file
        try {
          unlinkSync(tempFilePath)
        } catch {
          console.warn(`Could not clean up temporary file: ${tempFilePath}`)
        }
        reject(new Error(`Failed to parse EPUB: ${err.message}`))
      })

      epub.on('end', async function () {
        try {
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

          const sectionsFoundMessage = `${totalChapters} content sections:`
          console.log(
            styleText(sectionsFoundMessage, {
              useColor,
              color: 'blue',
            }),
          )

          // Extract text from all chapters
          const extractedChapters = []
          for (let i = 0; i < chapters.length; i++) {
            const chapter = chapters[i]
            const chapterTitle = chapter.title || `Section ${i + 1}`

            try {
              // Get chapter content
              const chapterText = await getChapterText(epub, chapter.id)
              const cleanText = cleanHtmlText(chapterText)
              const sectionCharCount = cleanText.length
              const filterResult = shouldFilterContent(
                chapterTitle,
                cleanText,
                titleMatchers,
                minChars,
              )

              extractedChapters.push({
                index: i + 1,
                title: chapterTitle,
                text: cleanText,
                originalIndex: i + 1,
              })
              const charCountLabel = styleText(
                `${formatNumberGroups(sectionCharCount)} char`,
                {
                  useColor,
                  color: 'yellow',
                },
              )

              if (filterResult.shouldFilter) {
                console.log(
                  `${styleText('[filtered out]', { useColor, color: 'red' })} "${chapterTitle}" ${charCountLabel} - ${filterResult.reason}`,
                )
              } else {
                console.log(`Processing: ${chapterTitle} ${charCountLabel}`)
              }
            } catch (chapterError) {
              console.warn(
                `Failed to extract chapter "${chapterTitle}": ${chapterError.message}`,
              )
              // Add empty chapter to maintain index consistency
              extractedChapters.push({
                index: i + 1,
                title: chapterTitle,
                text: '',
                originalIndex: i + 1,
                error: chapterError.message,
              })
            }
          }

          const result = {
            metadata: epub.metadata,
            chapters: extractedChapters,
            totalChapters: totalChapters,
          }

          // Clean up temp file
          try {
            unlinkSync(tempFilePath)
          } catch {
            console.warn(`Could not clean up temporary file: ${tempFilePath}`)
          }

          resolve(result)
        } catch (error) {
          // Clean up temp file
          try {
            unlinkSync(tempFilePath)
          } catch {
            console.warn(`Could not clean up temporary file: ${tempFilePath}`)
          }
          reject(error)
        }
      })

      // Start parsing
      epub.parse()
    } catch (error) {
      reject(error)
    }
  })
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
) {
  const { metadata, chapters, totalChapters } = epubData

  // Determine which chapters to extract
  const startIdx = startChapter ? parseInt(startChapter, 10) - 1 : 0
  const endIdx = endChapter ? parseInt(endChapter, 10) - 1 : totalChapters - 1

  // Validate chapter range
  if (startIdx < 0 || startIdx >= totalChapters) {
    throw new Error(
      `Start chapter ${startChapter} is out of range (1-${totalChapters})`,
    )
  }
  if (endIdx < 0 || endIdx >= totalChapters) {
    throw new Error(
      `End chapter ${endChapter} is out of range (1-${totalChapters})`,
    )
  }
  if (startIdx > endIdx) {
    throw new Error('Start chapter cannot be greater than end chapter')
  }

  const content = []
  const filteredOut = []
  let contentNumber = 1

  const titleMatchers = buildTitleMatchers(titleFilters)

  // Process selected chapters
  for (let i = startIdx; i <= endIdx; i++) {
    const chapter = chapters[i]

    if (!chapter) {
      console.warn(`Chapter at index ${i} not found`)
      continue
    }

    // Check if content should be filtered
    const filterResult = shouldFilterContent(
      chapter.title,
      chapter.text,
      titleMatchers,
      minChars,
    )

    if (filterResult.shouldFilter) {
      filteredOut.push({
        originalIndex: i + 1,
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
        originalChapterIndex: i + 1,
      })
      contentNumber++
    } else {
      filteredOut.push({
        originalIndex: i + 1,
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
    extractedPages: endIdx - startIdx + 1,
    extractedSections: content.length,
    filteredSections: filteredOut.length,
    extractedRange: `Chapters ${startIdx + 1}-${endIdx + 1}`,
    processingMethod: 'epub-library',
    hasIndex: true, // EPUB inherently has structured chapters
    indexChapters: totalChapters,
  }

  console.log('EPUB transformation complete:', {
    extractedSections: content.length,
    filteredSections: filteredOut.length,
  })

  return {
    metadata: transformedMetadata,
    content: content,
  }
}

/**
 * Helper function to get chapter text (promisified)
 */
function getChapterText(epub, chapterId) {
  return new Promise((resolve, reject) => {
    epub.getChapter(chapterId, function (err, text) {
      if (err) {
        reject(err)
      } else {
        resolve(text)
      }
    })
  })
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
  const matchers = []

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

function shouldFilterContent(title, text, titleMatchers, minChars?) {
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
