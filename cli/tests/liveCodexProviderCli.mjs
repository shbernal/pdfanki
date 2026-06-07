import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const liveModel = process.env.PDFANKI_LIVE_CODEX_MODEL ?? 'gpt-5.4'
const liveReasoningEffort =
  process.env.PDFANKI_LIVE_CODEX_REASONING_EFFORT ?? 'medium'

const liveBooks = [
  {
    slug: 'jekyll-hyde',
    deckTitle: 'Jekyll and Hyde Live Codex',
    source: '../../tests/books/public-domain/jekyll-hyde.pg43.epub',
    startSection: '3',
    endSection: '3',
    marker: 'STORY OF THE DOOR',
  },
  {
    slug: 'yellow-wallpaper',
    deckTitle: 'Yellow Wallpaper Live Codex',
    source: '../../tests/books/public-domain/yellow-wallpaper.pg1952.epub',
    startSection: '2',
    endSection: '2',
    marker:
      'It is very seldom that mere ordinary people like John and myself secure ancestral halls',
  },
]

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('close', (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr })
    })
  })
}

function assertSuccessfulCliResult(result, label) {
  assert.equal(
    result.exitCode,
    0,
    `${label} stdout:\n${result.stdout}\n\n${label} stderr:\n${result.stderr}`,
  )
  assert.equal(result.signal, null)
}

async function createLiveRunDir() {
  const liveRoot = join(repoRoot, '.tmp', 'live-codex')
  await mkdir(liveRoot, { recursive: true })
  return mkdtemp(join(liveRoot, 'run-'))
}

test(
  'live Codex writes JSON, real markdown cards, and APKG outputs for public-domain books',
  { timeout: 1_200_000 },
  async () => {
    const runRoot = await createLiveRunDir()
    const manifest = {
      model: liveModel,
      reasoningEffort: liveReasoningEffort,
      runRoot,
      books: [],
    }

    for (const book of liveBooks) {
      const bookPath = fileURLToPath(new URL(book.source, import.meta.url))
      const outputDir = join(runRoot, book.slug)
      const jsonPath = join(outputDir, 'book.json')
      const markdownPath = join(outputDir, 'cards.md')
      const apkgPath = join(outputDir, 'deck.apkg')
      const configRoot = join(outputDir, 'config')
      await mkdir(outputDir, { recursive: true })

      const baseEnv = {
        XDG_CONFIG_HOME: configRoot,
        NO_COLOR: '1',
      }

      const jsonResult = await runCli(
        [
          'epub',
          'json',
          bookPath,
          '--start-section',
          book.startSection,
          '--end-section',
          book.endSection,
          '--min-char',
          '300',
          '--out',
          jsonPath,
          '--verbose',
          '--no-color',
        ],
        baseEnv,
      )
      assertSuccessfulCliResult(jsonResult, `${book.slug} epub json`)

      const markdownResult = await runCli(
        [
          'epub',
          'md',
          bookPath,
          '--provider',
          'codex',
          '--model',
          liveModel,
          '--codex-reasoning-effort',
          liveReasoningEffort,
          '--start-section',
          book.startSection,
          '--end-section',
          book.endSection,
          '--min-char',
          '300',
          '--deck-title',
          book.deckTitle,
          '--out',
          markdownPath,
          '--verbose',
          '--no-color',
        ],
        baseEnv,
      )
      assertSuccessfulCliResult(markdownResult, `${book.slug} epub md`)

      const apkgResult = await runCli(
        [
          'md',
          'anki',
          markdownPath,
          '--deck-title',
          book.deckTitle,
          '--out',
          apkgPath,
          '--verbose',
          '--no-color',
        ],
        baseEnv,
      )
      assertSuccessfulCliResult(apkgResult, `${book.slug} md anki`)

      const json = JSON.parse(await readFile(jsonPath, 'utf8'))
      assert.equal(json.content.length, 1)
      assert.match(json.content[0].text, new RegExp(book.marker))

      const markdown = await readFile(markdownPath, 'utf8')
      assert.match(markdown, new RegExp(`^# ${book.deckTitle}$`, 'm'))
      assert.match(markdown, /^## .+/m)
      assert.match(markdown, /^- .+/m)
      assert.doesNotMatch(markdown, /Fake Codex CLI/)

      const apkgStats = await stat(apkgPath)
      assert.ok(apkgStats.size > 0)
      const apkgHeader = await readFile(apkgPath)
      assert.equal(apkgHeader.subarray(0, 2).toString('utf8'), 'PK')

      manifest.books.push({
        slug: book.slug,
        source: bookPath,
        json: jsonPath,
        markdown: markdownPath,
        apkg: apkgPath,
      })
    }

    await writeFile(
      join(runRoot, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )

    console.log(`Live Codex outputs written to ${runRoot}`)
  },
)
