// utils/jsonSectionManagement.js

/**
 * Re-index sections to maintain sequential numbering (1, 2, 3...)
 */
export function reindexSections(sections) {
  return sections.map((section, index) => ({
    ...section,
    index: index + 1,
  }))
}

/**
 * Update metadata after sections are modified
 */
export function updateMetadata(jsonData, deletedCount = 0) {
  const currentSectionCount = jsonData.content?.length || 0

  return {
    ...jsonData.metadata,
    extractedSections: currentSectionCount,
    filteredSections: (jsonData.metadata?.filteredSections || 0) + deletedCount,
  }
}

/**
 * Delete a section from JSON data
 */
export function deleteSection(jsonData, sectionIndex) {
  if (!jsonData || !jsonData.content || !Array.isArray(jsonData.content)) {
    throw new Error('Invalid JSON data structure')
  }

  // Find the section to delete
  const sectionToDelete = jsonData.content.find(
    section => section.index === sectionIndex,
  )
  if (!sectionToDelete) {
    throw new Error(`Section with index ${sectionIndex} not found`)
  }

  // Remove the section
  const filteredContent = jsonData.content.filter(
    section => section.index !== sectionIndex,
  )

  // Re-index remaining sections
  const reindexedContent = reindexSections(filteredContent)

  // Update metadata
  const updatedMetadata = updateMetadata(
    {
      ...jsonData,
      content: reindexedContent,
    },
    1,
  )

  const updatedJsonData = {
    ...jsonData,
    content: reindexedContent,
    metadata: updatedMetadata,
  }

  // Return both the updated data and the deleted section info for undo
  return {
    updatedJsonData,
    deletedSection: {
      section: sectionToDelete,
      originalPosition: jsonData.content.findIndex(
        section => section.index === sectionIndex,
      ),
      timestamp: Date.now(),
    },
  }
}

/**
 * Restore a deleted section to its original position
 */
export function undoDelete(jsonData, deletedSection) {
  if (!jsonData || !jsonData.content || !Array.isArray(jsonData.content)) {
    throw new Error('Invalid JSON data structure')
  }

  if (!deletedSection || !deletedSection.section) {
    throw new Error('Invalid deleted section data')
  }

  // Insert the section back at its original position
  const newContent = [...jsonData.content]
  newContent.splice(deletedSection.originalPosition, 0, deletedSection.section)

  // Re-index all sections to maintain proper numbering
  const reindexedContent = reindexSections(newContent)

  // Update metadata (decrease filtered count)
  const updatedMetadata = updateMetadata(
    {
      ...jsonData,
      content: reindexedContent,
    },
    -1,
  )

  return {
    ...jsonData,
    content: reindexedContent,
    metadata: updatedMetadata,
  }
}

/**
 * Get the most recent deleted section from the undo stack
 */
export function getLastDeleted(deletedSections) {
  if (!deletedSections || deletedSections.length === 0) {
    return null
  }

  // Return the most recently deleted section
  return deletedSections[deletedSections.length - 1]
}

/**
 * Add a deleted section to the undo stack
 */
export function addToUndoStack(
  deletedSections,
  deletedSection,
  maxUndoCount = 10,
) {
  const newStack = [...deletedSections, deletedSection]

  // Limit the undo stack size
  if (newStack.length > maxUndoCount) {
    return newStack.slice(-maxUndoCount)
  }

  return newStack
}

/**
 * Remove the most recent deleted section from the undo stack
 */
export function removeFromUndoStack(deletedSections) {
  if (!deletedSections || deletedSections.length === 0) {
    return []
  }

  return deletedSections.slice(0, -1)
}

/**
 * Clear all deleted sections from the undo stack
 */
export function clearUndoStack() {
  return []
}

/**
 * Check if undo is available
 */
export function canUndo(deletedSections) {
  return deletedSections && deletedSections.length > 0
}

/**
 * Get summary of what can be undone
 */
export function getUndoSummary(deletedSections) {
  if (!canUndo(deletedSections)) {
    return null
  }

  const lastDeleted = getLastDeleted(deletedSections)
  return {
    sectionTitle: lastDeleted.section.title,
    timestamp: lastDeleted.timestamp,
    count: deletedSections.length,
  }
}

/**
 * Validate JSON data structure
 */
export function validateJsonStructure(
  jsonData,
  options = { requireMetadata: true, requireTitles: true },
) {
  const { requireMetadata = true, requireTitles = true } = options

  if (!jsonData) {
    return { isValid: false, error: 'JSON data is null or undefined' }
  }

  if (!jsonData.content || !Array.isArray(jsonData.content)) {
    return { isValid: false, error: 'JSON data must have a content array' }
  }

  if (requireMetadata) {
    if (!jsonData.metadata || typeof jsonData.metadata !== 'object') {
      return { isValid: false, error: 'JSON data must have a metadata object' }
    }
  } else if (jsonData.metadata && typeof jsonData.metadata !== 'object') {
    return { isValid: false, error: 'metadata must be an object if present' }
  }

  // Check if content sections have required properties
  for (let i = 0; i < jsonData.content.length; i++) {
    const section = jsonData.content[i]
    const hasTitle = section.title && typeof section.title === 'string'
    const titleRequirementMet = requireTitles ? hasTitle : true
    const hasIndex = typeof section.index === 'number' && section.index > 0
    if (!hasIndex || !titleRequirementMet || typeof section.text !== 'string') {
      return {
        isValid: false,
        error: `Section ${i + 1} is missing required properties (index,${requireTitles ? ' title,' : ''} or text)`,
      }
    }
  }

  return { isValid: true }
}
