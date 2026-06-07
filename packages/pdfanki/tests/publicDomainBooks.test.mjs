import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { convertFileFromPath } from '../dist/server.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const bookRoot = new URL('tests/books/public-domain/', `file://${repoRoot}/`)

const books = [
  {
    file: 'scientific-management.pg6435.epub',
    title: 'The Principles of Scientific Management',
    author: 'Frederick Winslow Taylor',
    startChapter: 2,
    endChapter: 2,
    textMarker: 'In the past the man has been first',
  },
  {
    file: 'yellow-wallpaper.pg1952.epub',
    title: 'The Yellow Wallpaper',
    author: 'Charlotte Perkins Gilman',
    startChapter: 2,
    endChapter: 2,
    textMarker:
      'It is very seldom that mere ordinary people like John and myself secure ancestral halls',
  },
  {
    file: 'jekyll-hyde.pg43.epub',
    title: 'The strange case of Dr. Jekyll and Mr. Hyde',
    author: 'Robert Louis Stevenson',
    startChapter: 3,
    endChapter: 3,
    textMarker: 'STORY OF THE DOOR',
  },
]

async function sha256(path) {
  const buffer = await readFile(path)
  return createHash('sha256').update(buffer).digest('hex')
}

async function withMutedConsole(action) {
  const originalLog = console.log
  try {
    console.log = () => {}
    return await action()
  } finally {
    console.log = originalLog
  }
}

test('public-domain EPUB inputs keep source sidecars with matching SHA-256', async () => {
  for (const book of books) {
    const bookUrl = new URL(book.file, bookRoot)
    const sidecarUrl = new URL(`${book.file}.source.md`, bookRoot)
    const sidecar = await readFile(sidecarUrl, 'utf8')
    const digest = await sha256(bookUrl)

    assert.match(sidecar, /Source landing page: https:\/\/www\.gutenberg\.org/)
    assert.match(
      sidecar,
      /Source copyright\/status: Public domain in the USA\./,
    )
    assert.match(sidecar, /Redistribution notes: Official Project Gutenberg/)
    assert.match(sidecar, new RegExp(`SHA-256: ${digest}\\b`))
  }
})

test('public-domain EPUB inputs extract deterministic metadata and text markers', async () => {
  for (const book of books) {
    const inputPath = fileURLToPath(new URL(book.file, bookRoot))
    const result = await withMutedConsole(() =>
      convertFileFromPath({
        inputPath,
        startChapter: book.startChapter,
        endChapter: book.endChapter,
        minChars: 300,
      }),
    )

    assert.equal(result.fileType, 'epub', basename(inputPath))
    assert.equal(result.data.metadata?.title, book.title)
    assert.equal(result.data.metadata?.author, book.author)
    assert.equal(result.data.metadata?.fileType, 'epub')
    assert.equal(result.data.metadata?.processingMethod, 'epub-library')
    assert.equal(result.data.metadata?.extractedSections, 1)
    assert.equal(result.data.content.length, 1)
    assert.match(result.data.content[0].text ?? '', new RegExp(book.textMarker))
    assert.match(result.text, new RegExp(book.textMarker))
  }
})
