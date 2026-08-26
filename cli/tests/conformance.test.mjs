import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import { renderCard } from '@ankimd/core'

import { parseSectionCards } from '../dist/flashcardPolicy.js'

/*
 * The Flashcard Markdown conformance corpus, run in the **producer** direction.
 *
 * A consumer runs the corpus by parsing `input.md` and comparing against
 * `expected.json`; `@ankimd/core` does that, in its own suite. What is left to assert
 * here is that pdfanki still conforms as a producer now that the format itself lives
 * one package away: given a canonical case, what it writes reproduces the source byte
 * for byte, and every case under `invalid/` is refused rather than turned into a deck.
 *
 * One scoping note, because it decides what these tests can assert. pdfanki validates a
 * model's output for one section, which is cards and nothing else: the frontmatter and
 * the `# ` deck title are written by the CLI, around this. So the round trip runs over
 * each case's **card region**, from its first `## ` to the end, while the rejection
 * tests use whole files, which is what "a producer rejects it" means.
 */

const require = createRequire(import.meta.url)
const FIXTURES = path.dirname(
  require.resolve('flashcard-md-spec/manifest.json'),
)

/** The spec version this suite conforms to, pinned rather than tracked. */
const SPEC_VERSION = '1.0'

const manifest = JSON.parse(
  readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'),
)

const input = id => readFileSync(path.join(FIXTURES, id, 'input.md'), 'utf8')

const casesIn = tier => manifest.cases.filter(entry => entry.tier === tier)

/** Everything from the first card heading on: the region pdfanki's output covers. */
const cardRegion = markdown => {
  const lines = markdown.split('\n')
  const first = lines.findIndex(line => line.startsWith('## '))
  assert.notEqual(first, -1, 'fixture has no card heading')
  return lines.slice(first).join('\n').trim()
}

/** What pdfanki would write for these cards, which is always canonical form. */
const written = markdown =>
  parseSectionCards(markdown).map(renderCard).join('\n\n')

const rejects = markdown => {
  try {
    parseSectionCards(markdown)
  } catch (error) {
    return error.message
  }
  return null
}

test('the suite pins a spec version rather than tracking what is installed', () => {
  assert.equal(manifest.specVersion, SPEC_VERSION)
})

test('the corpus has cases in every tier', () => {
  for (const tier of ['canonical', 'valid', 'invalid']) {
    assert.ok(casesIn(tier).length > 0, `no ${tier} cases`)
  }
})

for (const entry of casesIn('canonical')) {
  test(`${entry.id} round-trips byte for byte: ${entry.description}`, () => {
    const region = cardRegion(input(entry.id))

    assert.equal(written(region), region)
  })
}

/*
 * One invalid case is not about the text. `invalid/unresolved-image` names an image with
 * no file beside the deck, which nothing reading the source can see: the format reports
 * it when the image is resolved, and pdfanki resolves images only for a deck a user
 * brought, never for one a model wrote. So it is excluded here by name and with a
 * reason, rather than by an assertion weak enough to hold for it.
 */
const NOT_IN_THE_TEXT = new Set(['invalid/unresolved-image'])

for (const entry of casesIn('invalid').filter(
  one => !NOT_IN_THE_TEXT.has(one.id),
)) {
  test(`${entry.id} is rejected: ${entry.description}`, () => {
    assert.ok(
      rejects(input(entry.id)),
      'expected the producer to reject this file',
    )
  })
}

/*
 * The valid tier says: consumers MUST parse it, producers MUST NOT emit it. Only four of
 * the nine cases put their non-canonical construct inside the card region, so only those
 * four say anything about this producer. They divide in two. Two are things a producer
 * MAY refuse and pdfanki does, because they are its own model repeating itself or losing
 * a section. Two are whitespace, and pdfanki emits them canonically rather than asking
 * the model again for a difference it does not control.
 */

test('valid/card-with-no-body is refused rather than emitted', () => {
  const message = rejects(cardRegion(input('valid/card-with-no-body')))

  assert.match(message ?? '', /is missing bullet items/)
})

test('valid/duplicate-fronts is refused rather than emitted', () => {
  const message = rejects(cardRegion(input('valid/duplicate-fronts')))

  assert.match(message ?? '', /Duplicate card front/)
})

test('valid/no-blank-line-after-heading comes back out canonical', () => {
  const region = cardRegion(input('valid/no-blank-line-after-heading'))
  const output = written(region)

  assert.notEqual(output, region)
  assert.equal(output, region.replace(/^(## .*)$/gm, '$1\n'))
})

test('valid/no-blank-lines-around-separator comes back out canonical', () => {
  const region = cardRegion(input('valid/no-blank-lines-around-separator'))
  const output = written(region)

  assert.notEqual(output, region)
  assert.match(output, /\n\n\*\*\*\n\n/)
})
