import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import {
  parseFlashcardMarkdown,
  renderFlashcards,
} from '../dist/flashcardValidation.js'

/*
 * The Flashcard Markdown conformance corpus, run in the **producer** direction.
 *
 * A consumer runs the corpus by parsing `input.md` and comparing against
 * `expected.json`. A producer runs it the other way and never opens `expected.json` at
 * all: given a canonical case, its serializer must reproduce the source byte for byte,
 * and every case under `invalid/` must be rejected loudly.
 *
 * One scoping note, because it decides what these tests can assert. pdfanki validates a
 * model's output for one section, which is cards and nothing else — the frontmatter and
 * the `# ` deck title are written by the CLI, around this. So the canonical round-trip
 * runs over each case's **card region**, from its first `## ` to the end, while the
 * rejection tests use whole files, which is what "a producer rejects it" means.
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

const rejects = markdown => {
  try {
    parseFlashcardMarkdown(markdown)
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
  test(`${entry.id} round-trips byte for byte — ${entry.description}`, () => {
    const region = cardRegion(input(entry.id))

    assert.equal(renderFlashcards(parseFlashcardMarkdown(region)), region)
  })
}

for (const entry of casesIn('invalid')) {
  test(`${entry.id} is rejected — ${entry.description}`, () => {
    assert.ok(
      rejects(input(entry.id)),
      'expected the producer to reject this file',
    )
  })
}

/*
 * The valid tier says: consumers MUST parse it, producers MUST NOT emit it. Only four of
 * the nine cases put their non-canonical construct inside the card region, so only those
 * four say anything about this producer — the rest are non-canonical in frontmatter,
 * which pdfanki does not write. Naming the four is more honest than looping over nine and
 * asserting something weak enough to hold for all of them.
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
  const rendered = renderFlashcards(parseFlashcardMarkdown(region))

  assert.notEqual(rendered, region)
  assert.equal(rendered, region.replace(/^(## .*)$/gm, '$1\n'))
})

test('valid/no-blank-lines-around-separator is refused rather than emitted', () => {
  const message = rejects(
    cardRegion(input('valid/no-blank-lines-around-separator')),
  )

  assert.match(message ?? '', /needs a blank line either side/)
})
