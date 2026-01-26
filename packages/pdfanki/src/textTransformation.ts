/**
 * Clean and normalize text content extracted from PDFs
 * @param {string} text - Raw text content to clean
 * @returns {string} - Cleaned text content
 */
export function cleanExtractedText(text) {
  if (!text || typeof text !== 'string') {
    return ''
  }

  let cleanedText = text

  // 1. Remove special characters like null characters and carriage returns
  cleanedText = cleanedText
    .replace(/\u0000/g, '') // Remove null characters
    .replace(/\r/g, '') // Remove carriage returns

  // 2. Handle newline sequences
  // First replace double newlines with single space
  cleanedText = cleanedText.replace(/\n\n/g, ' ')

  // Then replace remaining single newlines with space
  cleanedText = cleanedText.replace(/\n/g, ' ')

  // 3. Clean up multiple consecutive spaces
  cleanedText = cleanedText.replace(/\s+/g, ' ')

  // 4. Trim whitespace from start and end
  cleanedText = cleanedText.trim()

  return cleanedText
}

/**
 * Apply text cleaning to all content sections in a transformed result
 * @param {Object} transformedResult - The result from transformPdf2jsonResult
 * @returns {Object} - Transformed result with cleaned text content
 */
export function cleanTransformedResult(transformedResult) {
  if (!transformedResult || !transformedResult.content) {
    return transformedResult
  }

  // Create a copy to avoid mutating the original
  const cleanedResult = {
    ...transformedResult,
    content: transformedResult.content.map(section => ({
      ...section,
      text: cleanExtractedText(section.text),
    })),
  }

  return cleanedResult
}
