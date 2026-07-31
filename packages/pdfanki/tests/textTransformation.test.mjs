import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cleanExtractedText,
  cleanTransformedResult,
  formatFileSize,
} from '../dist/client.js'

test('cleanExtractedText returns an empty string for non-string input', () => {
  assert.equal(cleanExtractedText(''), '')
  assert.equal(cleanExtractedText(null), '')
  assert.equal(cleanExtractedText(undefined), '')
  assert.equal(cleanExtractedText(42), '')
  assert.equal(cleanExtractedText({}), '')
})

test('cleanExtractedText strips null characters and carriage returns', () => {
  assert.equal(cleanExtractedText('a\u0000b\r\nc'), 'ab c')
  assert.equal(cleanExtractedText('no\u0000nulls'), 'nonulls')
  assert.equal(cleanExtractedText('crlf\r\nline'), 'crlf line')
})

test('cleanExtractedText collapses newlines and runs of whitespace', () => {
  assert.equal(
    cleanExtractedText('first paragraph\n\nsecond\nthird    fourth'),
    'first paragraph second third fourth',
  )
})

test('cleanExtractedText trims the result', () => {
  assert.equal(cleanExtractedText('   \n padded \n  '), 'padded')
})

test('cleanExtractedText leaves already-clean text untouched', () => {
  const text = 'The quick brown fox jumps over the lazy dog.'
  assert.equal(cleanExtractedText(text), text)
})

test('cleanTransformedResult cleans every section without mutating the input', () => {
  const original = {
    metadata: { title: 'Book' },
    content: [
      { index: 1, title: 'One', text: 'line\nbreak' },
      { index: 2, title: 'Two', text: '  spaced   out  ' },
    ],
  }
  const snapshot = structuredClone(original)

  const cleaned = cleanTransformedResult(original)

  assert.deepEqual(original, snapshot, 'input must not be mutated')
  assert.equal(cleaned.content[0].text, 'line break')
  assert.equal(cleaned.content[1].text, 'spaced out')
  // Non-text fields are carried through untouched.
  assert.equal(cleaned.content[0].title, 'One')
  assert.deepEqual(cleaned.metadata, { title: 'Book' })
})

test('cleanTransformedResult passes through results without content', () => {
  assert.equal(cleanTransformedResult(null), null)
  assert.equal(cleanTransformedResult(undefined), undefined)

  const noContent = { metadata: { title: 'Book' } }
  assert.equal(cleanTransformedResult(noContent), noContent)
})

test('formatFileSize reports KB below one megabyte', () => {
  assert.equal(formatFileSize(0), '0.0 KB')
  assert.equal(formatFileSize(1024), '1.0 KB')
  assert.equal(formatFileSize(1024 * 512), '512.0 KB')
})

test('formatFileSize reports MB at one megabyte and above', () => {
  assert.equal(formatFileSize(1024 * 1024), '1.00 MB')
  assert.equal(formatFileSize(1024 * 1024 * 2.5), '2.50 MB')
})
