import assert from 'node:assert/strict'
import test from 'node:test'

import { parseSectionCards } from '../dist/flashcardPolicy.js'

/*
 * pdfanki's producer policy, which is what is left once `@ankimd/core` owns the format.
 *
 * The grammar is tested in that package, against the spec's conformance corpus. What is
 * tested here is the set §5.5 hands to the producer, plus the two departures pdfanki
 * chooses to normalize rather than retry the model over.
 */

const parseError = markdown => {
  try {
    parseSectionCards(markdown)
  } catch (error) {
    return error.message
  }
  return assert.fail('expected parseSectionCards to throw')
}

test('parseSectionCards reads a single card', () => {
  const cards = parseSectionCards('## Front\n\n- one\n- two')

  assert.equal(cards.length, 1)
  assert.equal(cards[0].headingText, 'Front')
  assert.equal(cards[0].back, '- one\n- two')
})

test('parseSectionCards reads several cards', () => {
  const cards = parseSectionCards(
    ['## First', '', '- a', '', '## Second', '', '- b'].join('\n'),
  )

  assert.deepEqual(
    cards.map(card => card.headingText),
    ['First', 'Second'],
  )
})

test('parseSectionCards keeps a body verbatim', () => {
  const body = ['- outer', '  - nested', '', '### Detail', '', '- more'].join(
    '\n',
  )
  const cards = parseSectionCards(`## Collisions\n\n${body}`)

  assert.equal(cards[0].back, body)
})

test('parseSectionCards splits the front from the back at a separator', () => {
  const cards = parseSectionCards(
    ['## Front', '', 'Ask.', '', '***', '', '- Answer'].join('\n'),
  )

  assert.equal(cards[0].frontBody, 'Ask.')
  assert.equal(cards[0].back, '- Answer')
  assert.equal(cards[0].hasSeparator, true)
})

test('parseSectionCards does not open a card inside a code fence', () => {
  const body = [
    '```markdown',
    '## Not a card',
    '',
    '***',
    '```',
    '',
    '- a',
  ].join('\n')
  const cards = parseSectionCards(`## Front\n\n${body}`)

  assert.equal(cards.length, 1)
  assert.equal(cards[0].back, body)
})

test('parseSectionCards rejects markdown with no cards', () => {
  const message = parseError('just some prose\nand more prose')

  assert.match(message, /Markdown validation failed:/)
  assert.match(message, /No flashcards detected/)
  assert.match(message, /Content found before the first card front/)
})

test('parseSectionCards rejects a card with no bullets', () => {
  assert.match(parseError('## Lonely'), /Card "Lonely" is missing bullet items/)
})

test('parseSectionCards rejects a body with no bullet at the top level', () => {
  assert.match(
    parseError('## Front\n\nJust a paragraph.'),
    /Card "Front" is missing bullet items/,
  )
})

test('parseSectionCards does not count a bullet inside a code fence', () => {
  const body = ['```yaml', '- not an answer', '```'].join('\n')

  assert.match(
    parseError(`## Front\n\n${body}`),
    /Card "Front" is missing bullet items/,
  )
})

test('parseSectionCards rejects an empty card front', () => {
  const message = parseError(
    ['## Front', '', '- a', '', '## ', '', '- b'].join('\n'),
  )

  assert.match(message, /malformed-card-skipped/)
})

test('parseSectionCards rejects an empty bullet item', () => {
  const message = parseError('## Front\n\n- a\n-  \n- b')

  assert.match(message, /Empty bullet item/)
  assert.match(message, /lines 4/)
})

test('parseSectionCards rejects content before the first card front', () => {
  assert.match(
    parseError('- orphan\n\n## Front\n\n- a'),
    /Content found before the first card front/,
  )
})

// The CLI writes the deck title itself, around this output. A `#` from the model would
// either duplicate it or end a card.
test('parseSectionCards rejects a # heading', () => {
  const message = parseError(
    ['## Front', '', '- a', '', '# Section', '', '## Other', '', '- b'].join(
      '\n',
    ),
  )

  assert.match(message, /stray-h1/)
})

// Duplicate fronts are valid input that a consumer must keep. Refusing to *write* them
// is producer policy: two identical fronts are the model repeating itself, and a
// reviewer cannot tell the two cards apart.
test('parseSectionCards rejects a duplicate card front', () => {
  const message = parseError(
    [
      '## bank',
      '',
      '- the side of a river',
      '',
      '## bank',
      '',
      '- a financial institution',
    ].join('\n'),
  )

  assert.match(message, /Duplicate card front "bank"/)
})

test('parseSectionCards reports every issue at once', () => {
  const message = parseError(['## First', '', '## Second'].join('\n'))

  assert.match(message, /1\. Card "First" is missing bullet items/)
  assert.match(message, /2\. Card "Second" is missing bullet items/)
})

/*
 * Both of these are valid but not canonical, and both are fixed by the renderer rather
 * than by asking the model again. The deck pdfanki writes is still canonical, which is
 * what the format obliges a producer to emit.
 */

test('parseSectionCards accepts a missing blank line after the heading', () => {
  const cards = parseSectionCards('## First\n- a')

  assert.equal(cards[0].back, '- a')
})

test('parseSectionCards accepts a separator written tight against its neighbours', () => {
  const cards = parseSectionCards(
    ['## Front', 'Ask.', '***', '- Answer'].join('\n'),
  )

  assert.equal(cards[0].frontBody, 'Ask.')
  assert.equal(cards[0].back, '- Answer')
})
