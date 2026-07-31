import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addToUndoStack,
  canUndo,
  deleteSection,
  removeFromUndoStack,
  undoDelete,
  validateJsonStructure,
} from '../dist/client.js'

const makeBook = () => ({
  metadata: { title: 'Book', extractedSections: 3, filteredSections: 0 },
  content: [
    { index: 1, title: 'One', text: 'first' },
    { index: 2, title: 'Two', text: 'second' },
    { index: 3, title: 'Three', text: 'third' },
  ],
})

test('deleteSection removes the section and re-indexes the rest', () => {
  const book = makeBook()
  const { updatedJsonData } = deleteSection(book, 2)

  assert.deepEqual(
    updatedJsonData.content.map(section => [section.index, section.title]),
    [
      [1, 'One'],
      [2, 'Three'],
    ],
  )
})

test('deleteSection updates the section counters in metadata', () => {
  const { updatedJsonData } = deleteSection(makeBook(), 1)

  assert.equal(updatedJsonData.metadata.extractedSections, 2)
  assert.equal(updatedJsonData.metadata.filteredSections, 1)
  assert.equal(updatedJsonData.metadata.title, 'Book')
})

test('deleteSection records what is needed to undo it', () => {
  const before = Date.now()
  const { deletedSection } = deleteSection(makeBook(), 3)

  assert.equal(deletedSection.section.title, 'Three')
  assert.equal(deletedSection.originalPosition, 2)
  assert.ok(deletedSection.timestamp >= before)
})

test('deleteSection does not mutate the input', () => {
  const book = makeBook()
  const snapshot = structuredClone(book)

  deleteSection(book, 2)

  assert.deepEqual(book, snapshot)
})

test('deleteSection rejects malformed data and unknown indexes', () => {
  assert.throws(() => deleteSection(null, 1), /Invalid JSON data structure/)
  assert.throws(() => deleteSection({}, 1), /Invalid JSON data structure/)
  assert.throws(
    () => deleteSection({ content: 'nope' }, 1),
    /Invalid JSON data structure/,
  )
  assert.throws(
    () => deleteSection(makeBook(), 99),
    /Section with index 99 not found/,
  )
})

test('undoDelete restores the section at its original position', () => {
  const book = makeBook()
  const { updatedJsonData, deletedSection } = deleteSection(book, 2)

  const restored = undoDelete(updatedJsonData, deletedSection)

  assert.deepEqual(
    restored.content.map(section => [section.index, section.title]),
    [
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three'],
    ],
  )
})

test('undoDelete rolls the filtered counter back', () => {
  const { updatedJsonData, deletedSection } = deleteSection(makeBook(), 2)
  const restored = undoDelete(updatedJsonData, deletedSection)

  assert.equal(restored.metadata.extractedSections, 3)
  assert.equal(restored.metadata.filteredSections, 0)
})

test('delete then undo round-trips back to the original book', () => {
  const book = makeBook()
  const { updatedJsonData, deletedSection } = deleteSection(book, 1)

  assert.deepEqual(undoDelete(updatedJsonData, deletedSection), book)
})

test('undoDelete rejects malformed data', () => {
  const { deletedSection } = deleteSection(makeBook(), 1)

  assert.throws(
    () => undoDelete(null, deletedSection),
    /Invalid JSON data structure/,
  )
  assert.throws(
    () => undoDelete(makeBook(), null),
    /Invalid deleted section data/,
  )
  assert.throws(
    () => undoDelete(makeBook(), {}),
    /Invalid deleted section data/,
  )
})

test('addToUndoStack appends and caps the stack', () => {
  assert.deepEqual(addToUndoStack([], 'a'), ['a'])
  assert.deepEqual(addToUndoStack(['a'], 'b'), ['a', 'b'])

  // Oldest entries fall off the front once the cap is reached.
  assert.deepEqual(addToUndoStack(['a', 'b'], 'c', 2), ['b', 'c'])
  assert.deepEqual(addToUndoStack(['a', 'b', 'c', 'd'], 'e', 3), [
    'c',
    'd',
    'e',
  ])
})

test('addToUndoStack does not mutate the stack it is given', () => {
  const stack = ['a']
  addToUndoStack(stack, 'b')
  assert.deepEqual(stack, ['a'])
})

test('removeFromUndoStack drops the most recent entry', () => {
  assert.deepEqual(removeFromUndoStack(['a', 'b', 'c']), ['a', 'b'])
  assert.deepEqual(removeFromUndoStack(['a']), [])
  assert.deepEqual(removeFromUndoStack([]), [])
  assert.deepEqual(removeFromUndoStack(null), [])
})

test('canUndo reflects whether the stack holds anything', () => {
  assert.equal(canUndo(['a']), true)
  assert.equal(Boolean(canUndo([])), false)
  assert.equal(Boolean(canUndo(null)), false)
  assert.equal(Boolean(canUndo(undefined)), false)
})

test('validateJsonStructure accepts a well-formed book', () => {
  assert.deepEqual(validateJsonStructure(makeBook()), { isValid: true })
})

test('validateJsonStructure rejects missing or malformed top-level data', () => {
  assert.deepEqual(validateJsonStructure(null), {
    isValid: false,
    error: 'JSON data is null or undefined',
  })
  assert.deepEqual(validateJsonStructure({ metadata: {} }), {
    isValid: false,
    error: 'JSON data must have a content array',
  })
  assert.deepEqual(validateJsonStructure({ content: {}, metadata: {} }), {
    isValid: false,
    error: 'JSON data must have a content array',
  })
  assert.deepEqual(validateJsonStructure({ content: [] }), {
    isValid: false,
    error: 'JSON data must have a metadata object',
  })
})

test('validateJsonStructure can waive the metadata requirement', () => {
  const result = validateJsonStructure(
    { content: [{ index: 1, title: 'One', text: 'x' }] },
    { requireMetadata: false },
  )
  assert.deepEqual(result, { isValid: true })
})

test('validateJsonStructure still type-checks optional metadata', () => {
  const result = validateJsonStructure(
    { content: [], metadata: 'nope' },
    { requireMetadata: false },
  )
  assert.deepEqual(result, {
    isValid: false,
    error: 'metadata must be an object if present',
  })
})

test('validateJsonStructure reports the first offending section', () => {
  const book = makeBook()
  book.content[1] = { index: 2, title: 'Two' }

  assert.deepEqual(validateJsonStructure(book), {
    isValid: false,
    error: 'Section 2 is missing required properties (index, title, or text)',
  })
})

test('validateJsonStructure requires a positive numeric index', () => {
  const book = makeBook()
  book.content[0].index = 0

  assert.equal(validateJsonStructure(book).isValid, false)
})

test('validateJsonStructure can waive the title requirement', () => {
  const book = makeBook()
  delete book.content[0].title

  assert.equal(validateJsonStructure(book).isValid, false)
  assert.deepEqual(validateJsonStructure(book, { requireTitles: false }), {
    isValid: true,
  })
})
