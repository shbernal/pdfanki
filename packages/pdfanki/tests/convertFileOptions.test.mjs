import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { convertFileFromPath } from '../dist/server.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const epubPath = join(
  repoRoot,
  'tests/books/public-domain/yellow-wallpaper.pg1952.epub',
)

/** `convertFileFromPath` narrates progress on stdout; keep the test output clean. */
async function convert(options) {
  const original = console.log
  console.log = () => {}
  try {
    return await convertFileFromPath(options)
  } finally {
    console.log = original
  }
}

const rejects = (options, pattern) =>
  assert.rejects(() => convert(options), pattern)

/**
 * Index handling is PDF-only and every index option is validated before
 * pdf-parse is ever handed the buffer, so a stub .pdf is enough to reach it.
 * The real PDF fixtures are gitignored, so CI has none to use.
 */
async function withStubPdf(action) {
  const dir = await mkdtemp(join(tmpdir(), 'pdfanki-options-'))
  try {
    const pdfPath = join(dir, 'stub.pdf')
    await writeFile(pdfPath, '%PDF-1.7\n')
    return await action(pdfPath, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('inputPath is required', async () => {
  await rejects({}, /inputPath is required/)
  await rejects({ inputPath: '' }, /inputPath is required/)
})

test('file type is inferred from the extension', async () => {
  const result = await convert({ inputPath: epubPath })
  assert.equal(result.fileType, 'epub')
  assert.equal(result.sourcePath, epubPath)
})

test('an explicit type is normalized, including the MIME spelling', async () => {
  for (const type of ['epub', 'EPUB', 'application/epub+zip']) {
    const result = await convert({ inputPath: epubPath, type })
    assert.equal(result.fileType, 'epub', type)
  }
})

test('an unrecognized type falls back to the file extension', async () => {
  // normalizeType returns undefined rather than throwing, so the extension wins.
  const result = await convert({ inputPath: epubPath, type: 'mobi' })
  assert.equal(result.fileType, 'epub')
})

test('a file type that cannot be inferred is rejected', async () => {
  await rejects(
    { inputPath: join(repoRoot, 'README.md') },
    /Unable to infer file type/,
  )
})

test('startChapter and endChapter must be positive integers', async () => {
  for (const startChapter of [0, -1, 1.5, Number.NaN]) {
    await rejects(
      { inputPath: epubPath, startChapter },
      /startChapter must be a positive integer/,
    )
  }
  for (const endChapter of [0, -1, 1.5]) {
    await rejects(
      { inputPath: epubPath, endChapter },
      /endChapter must be a positive integer/,
    )
  }
})

test('startChapter and endChapter select a slice and re-index it', async () => {
  const result = await convert({
    inputPath: epubPath,
    startChapter: 2,
    endChapter: 2,
  })

  assert.equal(result.data.content.length, 1)
  assert.equal(result.data.content[0].index, 1)
})

test('excludeChapters must be well formed', async () => {
  const cases = [
    ['', /excludeChapters must not be empty/],
    ['  ', /excludeChapters must not be empty/],
    ['1,,2', /segment 2 is empty/],
    ['1,bogus', /segment 2 must use "<chapter>" or "<start>-<end>" syntax/],
    ['5-3', /start chapter 5 greater than end chapter 3/],
  ]

  for (const [excludeChapters, pattern] of cases) {
    await rejects({ inputPath: epubPath, excludeChapters }, pattern)
  }
})

test('excludeChapters numbers refer to the source chapters, not the output', async () => {
  const all = await convert({ inputPath: epubPath })
  assert.deepEqual(
    all.data.content.map(section => section.title),
    ['Section 2', 'Section 3'],
  )

  // Chapter 1 was already dropped by the title filters, so excluding it is a no-op.
  const excludedOne = await convert({
    inputPath: epubPath,
    excludeChapters: '1',
  })
  assert.equal(excludedOne.data.content.length, 2)

  const excludedTwo = await convert({
    inputPath: epubPath,
    excludeChapters: '2',
  })
  assert.deepEqual(
    excludedTwo.data.content.map(section => [section.index, section.title]),
    [[1, 'Section 3']],
  )
})

test('excludeChapters accepts ranges as well as single chapters', async () => {
  const result = await convert({ inputPath: epubPath, excludeChapters: '2-3' })
  assert.equal(result.data.content.length, 0)
})

test('minChars filters short sections and counts them as filtered', async () => {
  const all = await convert({ inputPath: epubPath })
  const lengths = all.data.content.map(section => section.text.length)
  const shortest = Math.min(...lengths)

  const filtered = await convert({
    inputPath: epubPath,
    minChars: shortest + 1,
  })

  assert.equal(filtered.data.content.length, all.data.content.length - 1)
  assert.equal(
    filtered.data.metadata.extractedSections,
    filtered.data.content.length,
  )
  assert.ok(filtered.data.metadata.filteredSections > 0)
})

test('a non-positive minChars filters nothing', async () => {
  const all = await convert({ inputPath: epubPath })

  for (const minChars of [0, -10]) {
    const result = await convert({ inputPath: epubPath, minChars })
    assert.equal(result.data.content.length, all.data.content.length)
  }
})

test('the returned text is the flattened form of the retained sections', async () => {
  const result = await convert({
    inputPath: epubPath,
    startChapter: 2,
    endChapter: 2,
  })

  assert.equal(result.data.content.length, 1)
  const section = result.data.content[0]
  assert.ok(result.text.startsWith(`${section.index}. ${section.title}`))
  assert.ok(result.text.includes(section.text))
})

test('PDFs reject the EPUB-only section selection options', async () => {
  await withStubPdf(async pdfPath => {
    for (const options of [
      { startChapter: 1 },
      { endChapter: 1 },
      { excludeChapters: '1' },
    ]) {
      await rejects(
        { inputPath: pdfPath, ...options },
        /PDF extraction does not support section selection/,
      )
    }
  })
})

test('indexPath and indexRanges are mutually exclusive', async () => {
  await withStubPdf(pdfPath =>
    rejects(
      { inputPath: pdfPath, indexPath: 'index.json', indexRanges: '1-2' },
      /Use either indexPath or indexRanges, not both/,
    ),
  )
})

test('index ranges must be well formed', async () => {
  const cases = [
    ['', /Index ranges must not be empty/],
    ['   ', /Index ranges must not be empty/],
    ['1-2,,3-4', /segment 2 is empty/],
    ['1-2,bogus', /segment 2 must use "<start>-<end>" syntax/],
    ['5-3', /start page 5 greater than end page 3/],
    ['5-6,1-2', /must be sorted by start page in ascending order/],
    ['1-5,3-8', /entries 1 and 2 overlap on pages 3-5/],
  ]

  await withStubPdf(async pdfPath => {
    for (const [indexRanges, pattern] of cases) {
      await rejects({ inputPath: pdfPath, indexRanges }, pattern)
    }
  })
})

test('index ranges do not reject a zero start page, unlike an index file', async () => {
  // Documents current behavior, not desired behavior: parseIndexRanges has no
  // positive-integer check, so "0-2" gets through and the chapter is later
  // skipped with a warning. The index-file path rejects start: 0 outright.
  await withStubPdf(pdfPath =>
    assert.rejects(
      () => convert({ inputPath: pdfPath, indexRanges: '0-2' }),
      // Reaches the parser instead of failing validation.
      /Invalid PDF structure/,
    ),
  )
})

test('an index file must be a JSON array of valid chapter ranges', async () => {
  await withStubPdf(async (pdfPath, dir) => {
    const write = async contents => {
      const indexPath = join(dir, 'index.json')
      await writeFile(indexPath, contents)
      return indexPath
    }

    const cases = [
      ['{"not":"an array"}', /Index file must be a JSON array of chapters/],
      ['[]', /Index file must contain at least one range/],
      ['["nope"]', /entry 1 must be an object with "start" and "end" fields/],
      ['[null]', /entry 1 must be an object with "start" and "end" fields/],
      ['[[1,2]]', /entry 1 must be an object with "start" and "end" fields/],
      [
        '[{"start":1}]',
        /entry 1 has invalid "end"; expected a positive integer/,
      ],
      [
        '[{"start":1.5,"end":2}]',
        /entry 1 has invalid "start"; expected a positive integer/,
      ],
      [
        '[{"start":1,"end":2,"title":7}]',
        /entry 1 has invalid "title"; expected a string/,
      ],
    ]

    for (const [contents, pattern] of cases) {
      await rejects(
        { inputPath: pdfPath, indexPath: await write(contents) },
        pattern,
      )
    }
  })
})
