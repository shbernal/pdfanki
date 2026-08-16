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
  const cards = parseFlashcardMarkdown('## Front\n\n- one\n- two')

  assert.deepEqual(cards, [{ front: 'Front', body: '- one\n- two' }])
})

test('parseFlashcardMarkdown reads several cards', () => {
  const cards = parseFlashcardMarkdown(
    ['## First', '', '- a', '', '## Second', '', '- b', '- c'].join('\n'),
  )

  assert.deepEqual(cards, [
    { front: 'First', body: '- a' },
    { front: 'Second', body: '- b\n- c' },
  ])
})

test('parseFlashcardMarkdown reads cards written without blank lines', () => {
  const cards = parseFlashcardMarkdown(
    ['## First', '- a', '## Second', '- b'].join('\n'),
  )

  assert.deepEqual(cards, [
    { front: 'First', body: '- a' },
    { front: 'Second', body: '- b' },
  ])
})

test('parseFlashcardMarkdown does not end a card at a blank line', () => {
  const cards = parseFlashcardMarkdown(
    ['## Front', '', '- a', '', '- b'].join('\n'),
  )

  assert.deepEqual(cards, [{ front: 'Front', body: '- a\n\n- b' }])
})

test('parseFlashcardMarkdown trims surrounding whitespace and CRLF endings', () => {
  const cards = parseFlashcardMarkdown('\n\n## Front  \r\n\r\n- spaced\r\n\n')

  assert.deepEqual(cards, [{ front: 'Front', body: '- spaced' }])
})

// The bug this replaces: the old scanner recognized nothing but `## ` and `- `, so every
// one of these lines fell through an ignore branch and vanished from a deck pdfanki had
// just generated.
test('parseFlashcardMarkdown keeps nested bullets', () => {
  const body = ['- Separate chaining', '  - Each bucket holds a list'].join(
    '\n',
  )
  const cards = parseFlashcardMarkdown(`## Collisions\n\n${body}`)

  assert.deepEqual(cards, [{ front: 'Collisions', body }])
})

test('parseFlashcardMarkdown keeps a ### heading as body content', () => {
  const body = ['### Sequence', '', '- SYN', '- SYN-ACK'].join('\n')
  const cards = parseFlashcardMarkdown(`## Handshake\n\n${body}`)

  assert.deepEqual(cards, [{ front: 'Handshake', body }])
})

test('parseFlashcardMarkdown keeps prose and thematic breaks in the body', () => {
  const body = ['- a', '', '---', '', '- b'].join('\n')
  const cards = parseFlashcardMarkdown(`## Front\n\n${body}`)

  assert.deepEqual(cards, [{ front: 'Front', body }])
})

test('parseFlashcardMarkdown does not open a card inside a code fence', () => {
  const body = ['```md', '## not a card', '```', '', '- a'].join('\n')
  const cards = parseFlashcardMarkdown(`## Front\n\n${body}`)

  assert.deepEqual(cards, [{ front: 'Front', body }])
})

test('parseFlashcardMarkdown rejects markdown with no cards', () => {
  const message = parseError('just some prose\nand more prose')

  assert.match(message, /Markdown validation failed:/)
  assert.match(message, /No flashcards detected/)
  assert.match(message, /Content found before the first card front/)
})

test('parseFlashcardMarkdown rejects a card with no bullets', () => {
  const message = parseError('## Lonely')

  assert.match(message, /Card "Lonely" is missing bullet items/)
  assert.match(message, /lines 1/)
})

test('parseFlashcardMarkdown rejects a body with no bullet at the top level', () => {
  const message = parseError('## Front\n\nJust a paragraph.')

  assert.match(message, /Card "Front" is missing bullet items/)
})

test('parseFlashcardMarkdown rejects an empty card front', () => {
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

test('parseFlashcardMarkdown rejects content before the first card front', () => {
  const message = parseError('- orphan\n## Front\n- a')

  assert.match(message, /Content found before the first card front/)
  assert.match(message, /lines 1/)
})

// The CLI writes the deck title itself, around this output. A `#` from the model would
// either duplicate it or end a card.
test('parseFlashcardMarkdown rejects a # heading', () => {
  const message = parseError(
    ['## Front', '- a', '# Section', '## Other', '- b'].join('\n'),
  )

  assert.match(message, /A "#" heading belongs to the deck, not to a card/)
  assert.match(message, /lines 3/)
})

// Valid, but not canonical, and a producer must not emit merely-valid output.
test('parseFlashcardMarkdown rejects a *** without blank lines around it', () => {
  const message = parseError(['## Front', 'Ask.', '***', '- Answer'].join('\n'))

  assert.match(message, /needs a blank line either side/)
})

test('parseFlashcardMarkdown accepts a *** with blank lines around it', () => {
  const cards = parseFlashcardMarkdown(
    ['## Front', '', 'Ask.', '', '***', '', '- Answer'].join('\n'),
  )

  assert.deepEqual(cards, [{ front: 'Front', body: 'Ask.\n\n***\n\n- Answer' }])
})

test('parseFlashcardMarkdown ignores a *** inside a code fence', () => {
  const body = ['```markdown', '***', '```', '', '- a'].join('\n')
  const cards = parseFlashcardMarkdown(`## Front\n\n${body}`)

  assert.deepEqual(cards, [{ front: 'Front', body }])
})

// Duplicate fronts are valid input that a consumer must keep. Refusing to *write* them
// is producer policy: two identical fronts are the model repeating itself, and a
// reviewer cannot tell the two cards apart.
test('parseFlashcardMarkdown rejects a duplicate card front', () => {
  const message = parseError(
    [
      '## bank',
      '- the side of a river',
      '',
      '## bank',
      '- a financial institution',
    ].join('\n'),
  )

  assert.match(message, /Duplicate card front "bank"/)
})

test('parseFlashcardMarkdown reports every issue at once', () => {
  const message = parseError(['## First', '', '## Second'].join('\n'))

  assert.match(message, /1\. Card "First" is missing bullet items/)
  assert.match(message, /2\. Card "Second" is missing bullet items/)
})

test('parseFlashcardMarkdown collapses reported line numbers into ranges', () => {
  const message = parseError(['## Front', 'prose', 'more', 'still'].join('\n'))

  assert.match(message, /lines 2-4/)
})

test('renderFlashcards writes the canonical blank line after the heading', () => {
  const markdown = [
    '## First',
    '',
    '- a',
    '- b',
    '',
    '## Second',
    '',
    '- c',
  ].join('\n')

  assert.equal(renderFlashcards(parseFlashcardMarkdown(markdown)), markdown)
})

test('renderFlashcards normalizes a missing blank line after the heading', () => {
  const cards = parseFlashcardMarkdown('## First\n- a')

  assert.equal(renderFlashcards(cards), '## First\n\n- a')
})

test('renderFlashcards emits an empty string for no cards', () => {
  assert.equal(renderFlashcards([]), '')
})
