import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const bookPath = fileURLToPath(
  new URL(
    '../../tests/books/public-domain/jekyll-hyde.pg43.epub',
    import.meta.url,
  ),
)
const fakeCodexPath = fileURLToPath(
  new URL('./bin/fake-codex.mjs', import.meta.url),
)

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

test('CLI writes JSON, markdown, and APKG outputs from a real EPUB with the codex provider faked', async () => {
  const tempParent = join(repoRoot, '.tmp', 'tests')
  await mkdir(tempParent, { recursive: true })
  const tempRoot = await mkdtemp(join(tempParent, 'pdfanki-codex-cli-'))
  const jsonPath = join(tempRoot, 'book.json')
  const settingsMarkdownPath = join(tempRoot, 'settings-cards.md')
  const markdownPath = join(tempRoot, 'cards.md')
  const apkgPath = join(tempRoot, 'deck.apkg')
  const configDir = join(tempRoot, 'config')
  const baseEnv = {
    XDG_CONFIG_HOME: configDir,
    NO_COLOR: '1',
  }
  await mkdir(join(configDir, 'pdfanki'), { recursive: true })
  await writeFile(
    join(configDir, 'pdfanki', 'settings.json'),
    JSON.stringify(
      {
        generation: {
          providers: {
            codex: {
              defaultModel: 'gpt-test',
              reasoningEffort: 'high',
              profile: 'settings_profile',
            },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  const jsonResult = await runCli(
    [
      'epub',
      'json',
      bookPath,
      '--start-section',
      '3',
      '--end-section',
      '3',
      '--min-char',
      '300',
      '--out',
      jsonPath,
      '--verbose',
      '--no-color',
    ],
    baseEnv,
  )
  assertSuccessfulCliResult(jsonResult, 'epub json')

  const settingsMarkdownResult = await runCli(
    [
      'epub',
      'md',
      bookPath,
      '--provider',
      'codex',
      '--start-section',
      '3',
      '--end-section',
      '3',
      '--min-char',
      '300',
      '--deck-title',
      'Codex Settings Fixture Deck',
      '--out',
      settingsMarkdownPath,
      '--verbose',
      '--no-color',
    ],
    {
      ...baseEnv,
      EXPECTED_CODEX_MODEL: 'gpt-test',
      EXPECTED_CODEX_PROFILE: 'settings_profile',
      EXPECTED_CODEX_REASONING_EFFORT: 'high',
      PDFANKI_CODEX_COMMAND: fakeCodexPath,
      PDFANKI_CODEX_TIMEOUT_MS: '5000',
    },
  )
  assertSuccessfulCliResult(settingsMarkdownResult, 'epub md from settings')

  const markdownResult = await runCli(
    [
      'epub',
      'md',
      bookPath,
      '--provider',
      'codex',
      '--model',
      'gpt-test',
      '--codex-reasoning-effort',
      'low',
      '--codex-profile',
      'flag-profile',
      '--start-section',
      '3',
      '--end-section',
      '3',
      '--min-char',
      '300',
      '--deck-title',
      'Codex Fixture Deck',
      '--out',
      markdownPath,
      '--verbose',
      '--no-color',
    ],
    {
      ...baseEnv,
      EXPECTED_CODEX_MODEL: 'gpt-test',
      EXPECTED_CODEX_PROFILE: 'flag-profile',
      EXPECTED_CODEX_REASONING_EFFORT: 'low',
      PDFANKI_CODEX_COMMAND: fakeCodexPath,
      PDFANKI_CODEX_TIMEOUT_MS: '5000',
    },
  )
  assertSuccessfulCliResult(markdownResult, 'epub md')

  const apkgResult = await runCli(
    [
      'epub',
      'anki',
      bookPath,
      '--provider',
      'codex',
      '--model',
      'gpt-test',
      '--codex-reasoning-effort',
      'low',
      '--codex-profile',
      'flag-profile',
      '--start-section',
      '3',
      '--end-section',
      '3',
      '--min-char',
      '300',
      '--deck-title',
      'Codex Fixture Deck',
      '--out',
      apkgPath,
      '--verbose',
      '--no-color',
    ],
    {
      ...baseEnv,
      EXPECTED_CODEX_MODEL: 'gpt-test',
      EXPECTED_CODEX_PROFILE: 'flag-profile',
      EXPECTED_CODEX_REASONING_EFFORT: 'low',
      PDFANKI_CODEX_COMMAND: fakeCodexPath,
      PDFANKI_CODEX_TIMEOUT_MS: '5000',
    },
  )
  assertSuccessfulCliResult(apkgResult, 'epub anki')

  const json = JSON.parse(await readFile(jsonPath, 'utf8'))
  assert.equal(json.content.length, 1)
  assert.match(json.content[0].text, /STORY OF THE DOOR/)

  const markdown = await readFile(markdownPath, 'utf8')
  assert.match(markdown, /^# Codex Fixture Deck/m)
  assert.match(markdown, /^## Codex provider fixture/m)
  assert.match(markdown, /^- Source marker: STORY OF THE DOOR/m)

  const apkgStats = await stat(apkgPath)
  assert.ok(apkgStats.size > 0)
  const apkgHeader = await readFile(apkgPath)
  assert.equal(apkgHeader.subarray(0, 2).toString('utf8'), 'PK')
})
