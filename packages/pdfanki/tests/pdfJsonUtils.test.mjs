import assert from 'node:assert/strict'
import test from 'node:test'

import { transformPdfParseResult } from '../dist/server.js'

const originalFile = { name: 'book.pdf' }

const parsed = (overrides = {}) => ({
  pageTexts: ['page one text', 'page two text', 'page three text'],
  numpages: 3,
  info: {},
  version: '1.7',
  ...overrides,
})

/** `console.warn` is used to report skipped chapters; capture it rather than let it leak. */
async function captureWarnings(action) {
  const warnings = []
  const original = console.warn
  console.warn = message => warnings.push(String(message))
  try {
    return { result: await action(), warnings }
  } finally {
    console.warn = original
  }
}

test('transformPdfParseResult joins every page into one section without an index', () => {
  const { content, metadata } = transformPdfParseResult(parsed(), originalFile)

  assert.equal(content.length, 1)
  assert.equal(content[0].index, 1)
  assert.equal(content[0].title, 'book')
  assert.equal(
    content[0].text,
    'page one text\n\npage two text\n\npage three text',
  )
  assert.equal(content[0].pageRange, '1-3')
  assert.equal(content[0].processedPages, 3)
  assert.equal(metadata.processingMethod, 'pdf-parse-single-text')
  assert.equal(metadata.extractedRange, 'All Pages')
  assert.equal(metadata.hasIndex, false)
})

test('transformPdfParseResult skips blank pages when concatenating', () => {
  const { content } = transformPdfParseResult(
    parsed({ pageTexts: ['first', '', '   ', null, 'last'], numpages: 5 }),
    originalFile,
  )

  assert.equal(content[0].text, 'first\n\nlast')
  assert.equal(content[0].processedPages, 2)
})

test('transformPdfParseResult splits into chapters when given an index', () => {
  const index = [
    { start: 1, end: 2, title: 'Opening' },
    { start: 3, end: 3, title: 'Closing' },
  ]
  const { content, metadata } = transformPdfParseResult(
    parsed(),
    originalFile,
    index,
  )

  assert.deepEqual(
    content.map(section => [section.index, section.title, section.pageRange]),
    [
      [1, 'Opening', '1-2'],
      [2, 'Closing', '3-3'],
    ],
  )
  assert.equal(content[0].text, 'page one text\n\npage two text')
  assert.equal(content[0].pageCount, 2)
  assert.equal(metadata.processingMethod, 'pdf-parse-with-index')
  assert.equal(metadata.extractedRange, 'Chapters 1-2')
  assert.equal(metadata.hasIndex, true)
  assert.equal(metadata.indexChapters, 2)
  assert.equal(metadata.extractedPages, 3)
})

test('transformPdfParseResult names untitled chapters by position', () => {
  const { content } = transformPdfParseResult(parsed(), originalFile, [
    { start: 1, end: 1 },
    { start: 2, end: 2, title: '   ' },
  ])

  assert.deepEqual(
    content.map(section => section.title),
    ['Section 1', 'Section 2'],
  )
})

test('transformPdfParseResult skips chapters whose page range is out of bounds', async () => {
  const { result, warnings } = await captureWarnings(() =>
    transformPdfParseResult(parsed(), originalFile, [
      { start: 1, end: 1, title: 'Kept' },
      { start: 3, end: 99, title: 'PastEnd' },
      { start: 0, end: 1, title: 'BeforeStart' },
      { start: 3, end: 2, title: 'Inverted' },
    ]),
  )

  assert.deepEqual(
    result.content.map(section => section.title),
    ['Kept'],
  )
  assert.equal(warnings.length, 3)
  for (const title of ['PastEnd', 'BeforeStart', 'Inverted']) {
    assert.ok(
      warnings.some(warning => warning.includes(title)),
      `expected a warning naming "${title}"`,
    )
  }
})

test('transformPdfParseResult warns about chapters with no extractable text', async () => {
  const { result, warnings } = await captureWarnings(() =>
    transformPdfParseResult(
      parsed({ pageTexts: ['   ', 'real text'], numpages: 2 }),
      originalFile,
      [
        { start: 1, end: 1, title: 'Empty' },
        { start: 2, end: 2, title: 'Full' },
      ],
    ),
  )

  assert.deepEqual(
    result.content.map(section => section.title),
    ['Full'],
  )
  assert.ok(warnings.some(warning => warning.includes('no extractable text')))
})

test('transformPdfParseResult falls back to raw text when nothing is extracted', () => {
  const { content, metadata } = transformPdfParseResult(
    parsed({ pageTexts: [], numpages: 0, rawTextContent: '  salvaged text  ' }),
    originalFile,
  )

  assert.equal(content.length, 1)
  assert.equal(content[0].title, 'book')
  assert.equal(content[0].text, 'salvaged text')
  assert.equal(metadata.extractedSections, 1)
})

test('transformPdfParseResult prefers embedded metadata over the filename', () => {
  const { metadata } = transformPdfParseResult(
    parsed({
      info: {
        Title: 'Real Title',
        Author: 'Real Author',
        Creator: 'Writer',
        Producer: 'Distiller',
        CreationDate: 'D:20240101',
        ModDate: 'D:20240202',
      },
    }),
    originalFile,
  )

  assert.equal(metadata.title, 'Real Title')
  assert.equal(metadata.author, 'Real Author')
  assert.equal(metadata.creator, 'Writer')
  assert.equal(metadata.producer, 'Distiller')
  assert.equal(metadata.creationDate, 'D:20240101')
  assert.equal(metadata.modificationDate, 'D:20240202')
  assert.equal(metadata.fileType, 'pdf')
  assert.equal(metadata.pdfVersion, '1.7')
})

test('transformPdfParseResult falls back through the metadata sources in order', () => {
  const lowercase = transformPdfParseResult(
    parsed({ info: { title: 'lower', author: 'lower author' } }),
    originalFile,
  )
  assert.equal(lowercase.metadata.title, 'lower')
  assert.equal(lowercase.metadata.author, 'lower author')

  const sidecar = transformPdfParseResult(
    parsed({ metadata: { title: 'sidecar', author: 'sidecar author' } }),
    originalFile,
  )
  assert.equal(sidecar.metadata.title, 'sidecar')
  assert.equal(sidecar.metadata.author, 'sidecar author')

  // An empty embedded title must still fall back to the filename.
  const empty = transformPdfParseResult(
    parsed({ info: { Title: '', Author: '' } }),
    originalFile,
  )
  assert.equal(empty.metadata.title, 'book')
  assert.equal(empty.metadata.author, 'Unknown Author')
})
