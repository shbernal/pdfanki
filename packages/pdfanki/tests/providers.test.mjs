import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_EPUB_TITLE_FILTERS,
  bookJsonToPlainText,
  generateFlashcards,
} from '../dist/server.js'

test('bookJsonToPlainText labels each section with its index and title', () => {
  const text = bookJsonToPlainText({
    content: [
      { index: 1, title: 'Opening', text: 'first body' },
      { index: 2, title: 'Closing', text: 'second body' },
    ],
  })

  assert.equal(text, '1. Opening\nfirst body\n\n2. Closing\nsecond body')
})

test('bookJsonToPlainText falls back to a positional label without a title', () => {
  const text = bookJsonToPlainText({
    content: [{ index: 3, text: 'body' }],
  })

  assert.equal(text, 'Section 3\nbody')
})

test('bookJsonToPlainText tolerates sections with no text', () => {
  const text = bookJsonToPlainText({
    content: [
      { index: 1, title: 'Empty' },
      { index: 2, title: 'Full', text: 'body' },
    ],
  })

  assert.equal(text, '1. Empty\n\n2. Full\nbody')
})

test('bookJsonToPlainText returns an empty string for an empty book', () => {
  assert.equal(bookJsonToPlainText({ content: [] }), '')
})

test('generateFlashcards requires an API key for every provider but codex', async () => {
  for (const provider of [
    'gemini',
    'anthropic',
    'openai',
    'deepseek',
    'openrouter',
  ]) {
    await assert.rejects(
      () =>
        generateFlashcards({
          provider,
          model: 'test-model',
          prompt: 'p',
          content: 'c',
        }),
      new RegExp(`Missing API key for provider "${provider}"`),
      provider,
    )
  }
})

test('generateFlashcards rejects an unknown provider', async () => {
  await assert.rejects(
    () =>
      generateFlashcards({
        provider: 'not-a-provider',
        model: 'test-model',
        apiKey: 'key',
        prompt: 'p',
        content: 'c',
      }),
    /Unsupported provider "not-a-provider"/,
  )
})

test('the default EPUB title filters are well-formed regexes', () => {
  assert.ok(DEFAULT_EPUB_TITLE_FILTERS.length > 0)

  for (const filter of DEFAULT_EPUB_TITLE_FILTERS) {
    assert.equal(filter.type, 'regex')
    assert.doesNotThrow(
      () => new RegExp(filter.pattern, filter.flags),
      `bad pattern: ${filter.pattern}`,
    )
    assert.equal(filter.flags, 'i', 'front matter matching is case-insensitive')
  }
})

test('the default EPUB title filters match the front matter they target', () => {
  const matches = title =>
    DEFAULT_EPUB_TITLE_FILTERS.some(filter =>
      new RegExp(filter.pattern, filter.flags).test(title),
    )

  const dropped = [
    'Contents',
    'CONTENTS',
    'Content',
    'Dedication',
    'About the Author',
    'Also by Jane Doe',
    'Index',
    'Credits',
    'Copyright',
    'Notes',
    'Notes on Sources',
    'Bibliography',
    'Acknowledgments',
    'Acknowledgements',
    'Frontispiece',
    'Welcome',
    'Title Page',
    'Table of Contents',
    'Newsletter',
    'Newsletters',
    'Praise of the Author',
    'A Note on the Author',
    "Author's Note",
    'Author’s Note',
    'Illustration Credits',
  ]
  for (const title of dropped) {
    assert.ok(matches(title), `expected "${title}" to be filtered out`)
  }

  const kept = [
    'Chapter 1',
    'The Yellow Wallpaper',
    'Notes from Underground',
    'Indexing Strategies',
    'On the Origin of Species',
  ]
  for (const title of kept) {
    assert.ok(!matches(title), `expected "${title}" to be kept`)
  }
})
