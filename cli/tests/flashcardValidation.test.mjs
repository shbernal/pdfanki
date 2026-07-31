import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseFlashcardMarkdown,
  renderFlashcards,
} from '../dist/flashcardValidation.js'

const parseError = markdown => {
  try {
    parseFlashcardMarkdown(markdown)
  } catch (error) {
    return error.message
  }
  return assert.fail('expected parseFlashcardMarkdown to throw')
}

test('parseFlashcardMarkdown reads a single card', () => {
  const cards = parseFlashcardMarkdown('## Front\n- one\n- two')

  assert.deepEqual(cards, [{ front: 'Front', bullets: ['one', 'two'] }])
})

test('parseFlashcardMarkdown reads several cards separated by blank lines', () => {
  const cards = parseFlashcardMarkdown(
    ['## First', '- a', '', '## Second', '- b', '- c'].join('\n'),
  )

  assert.deepEqual(cards, [
    { front: 'First', bullets: ['a'] },
    { front: 'Second', bullets: ['b', 'c'] },
  ])
})

test('parseFlashcardMarkdown reads cards that are not blank-line separated', () => {
  const cards = parseFlashcardMarkdown(
    ['## First', '- a', '## Second', '- b'].join('\n'),
  )

  assert.deepEqual(cards, [
    { front: 'First', bullets: ['a'] },
    { front: 'Second', bullets: ['b'] },
  ])
})

test('parseFlashcardMarkdown trims surrounding whitespace and CRLF endings', () => {
  const cards = parseFlashcardMarkdown('\n\n## Front  \r\n-   spaced   \r\n\n')

  assert.deepEqual(cards, [{ front: 'Front', bullets: ['spaced'] }])
})

test('parseFlashcardMarkdown ignores non-heading, non-bullet lines', () => {
  const cards = parseFlashcardMarkdown(
    ['## Front', '- a', '---', '- b'].join('\n'),
  )

  assert.deepEqual(cards, [{ front: 'Front', bullets: ['a', 'b'] }])
})

test('parseFlashcardMarkdown allows blank lines before the first bullet', () => {
  const cards = parseFlashcardMarkdown('## Front\n\n- a')

  assert.deepEqual(cards, [{ front: 'Front', bullets: ['a'] }])
})

test('parseFlashcardMarkdown rejects markdown with no cards', () => {
  const message = parseError('just some prose\nand more prose')

  assert.match(message, /Markdown validation failed:/)
  assert.match(message, /No flashcards detected/)
  // Both non-empty lines are reported as a single range.
  assert.match(message, /lines 1-2/)
})

test('parseFlashcardMarkdown rejects a card with no bullets', () => {
  const message = parseError('## Lonely')

  assert.match(message, /Card "Lonely" is missing bullet items/)
  assert.match(message, /lines 1/)
})

test('parseFlashcardMarkdown rejects an empty card front', () => {
  // `rawLine.trimEnd()` runs before the prefix check, so "## " arrives as a
  // bare "##" and must still be recognized as a heading marker.
  const message = parseError(['## Front', '- a', '## ', '- b'].join('\n'))

  assert.match(message, /Empty card front after "## "/)
  assert.match(message, /lines 3/)
})

test('parseFlashcardMarkdown rejects an empty bullet item', () => {
  const message = parseError('## Front\n- a\n-  \n- b')

  assert.match(message, /Empty bullet item/)
  assert.match(message, /lines 3/)
})

test('parseFlashcardMarkdown reports an empty front once, not twice', () => {
  const message = parseError('## \n- a')

  assert.match(message, /1\. Empty card front after "## "/)
  assert.doesNotMatch(message, /2\./)
})

test('parseFlashcardMarkdown labels an empty front in the missing-bullets issue', () => {
  const message = parseError('## ')

  assert.match(message, /Card "\(empty front\)" is missing bullet items/)
})

test('parseFlashcardMarkdown rejects a bullet before any card front', () => {
  const message = parseError('- orphan\n## Front\n- a')

  assert.match(message, /Bullet item found before any card front/)
  assert.match(message, /lines 1/)
})

test('parseFlashcardMarkdown reports every issue at once', () => {
  const message = parseError(['## First', '', '## Second'].join('\n'))

  assert.match(message, /1\. Card "First" is missing bullet items/)
  assert.match(message, /2\. Card "Second" is missing bullet items/)
})

test('parseFlashcardMarkdown collapses reported line numbers into ranges', () => {
  // A card spanning lines 1-4 with no bullets reports one contiguous range.
  const message = parseError(['## Front', 'prose', 'more', 'still'].join('\n'))

  assert.match(message, /lines 1-4/)
})

test('renderFlashcards round-trips parsed cards', () => {
  const markdown = ['## First', '- a', '- b', '', '## Second', '- c'].join('\n')

  assert.equal(renderFlashcards(parseFlashcardMarkdown(markdown)), markdown)
})

test('renderFlashcards emits an empty string for no cards', () => {
  assert.equal(renderFlashcards([]), '')
})
