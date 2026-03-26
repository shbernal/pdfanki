#!/usr/bin/env node
import { promises as fs } from 'fs'
import { dirname, join, parse } from 'path'
import type { BookJson, ContentSection } from '@shbernal/pdfanki/server'
import {
  convertMarkdownToAnkiDeck,
  type ConvertMarkdownToAnkiDeckOptions,
} from '@shbernal/mdanki'
import yargs, { type Argv } from 'yargs'
import { hideBin } from 'yargs/helpers'
import {
  convertFileFromPath,
  generateFlashcards as generateFlashcardsFromServer,
  bookJsonToPlainText,
  type ConvertFileOptions,
} from '@shbernal/pdfanki/server'
import { validateJsonStructure } from '@shbernal/pdfanki/client'
import {
  ensureConfig,
  loadPrompt,
  loadSettings,
  resetConfig,
  type SupportedProvider,
} from './config.js'
import {
  installRemotePrompt,
  listLocalPrompts,
  listRemotePrompts,
} from './prompts.js'
import { readProviderApiKey } from './env.js'
import {
  parseFlashcardMarkdown,
  renderFlashcards,
  type Flashcard,
} from './flashcardValidation.js'
import { createLogger, type LogLevel } from './ui/logger.js'
import { createSpinner, type Spinner } from './ui/spinner.js'
import { createProgressBar, type ProgressBar } from './ui/progress.js'

function toKebabAlnum(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
  const collapsed = normalized.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return collapsed || 'deck'
}

function buildIndexTemplate(
  count: number,
): { title: string; start: number; end: number }[] {
  const items = []
  for (let i = 1; i <= count; i++) {
    const start = (i - 1) * 2 + 1
    const end = start + 1
    items.push({ title: `Section ${i}`, start, end })
  }
  return items
}

function buildDeckMarkdown(deckTitle: string, body: string): string {
  const cleanedTitle = deckTitle.trim() || 'Deck'
  const cleanedBody = body.trim()
  const lines = [`# ${cleanedTitle}`]
  if (cleanedBody) {
    lines.push('', cleanedBody)
  }
  return `${lines.join('\n')}\n`
}

function normalizePathArg(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function flagProvided(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  return true
}

function resolveOutputPath(
  target: string | undefined,
  fallbackBaseName: string,
  extension: string,
): string {
  if (target) {
    const parsed = parse(target)
    if (parsed.ext) {
      return target
    }
    if (parsed.dir || parsed.name) {
      const dir = parsed.dir || '.'
      const stem = parsed.name || fallbackBaseName
      return join(dir, `${stem}${extension}`)
    }
  }

  return join(process.cwd(), `${fallbackBaseName}${extension}`)
}

function resolveIndexTemplatePath(
  target: string | undefined,
  fromFilePath: string | undefined,
): string {
  const defaultBaseName = fromFilePath
    ? `${toKebabAlnum(parse(fromFilePath).name || 'index')}.index`
    : 'index'
  if (!target) {
    return join(process.cwd(), `${defaultBaseName}.json`)
  }

  const normalizedTarget = normalizePathArg(target)
  if (!normalizedTarget) {
    return join(process.cwd(), `${defaultBaseName}.json`)
  }

  const parsed = parse(normalizedTarget)
  if (!parsed.ext) {
    return join(normalizedTarget, 'index.json')
  }

  if (parsed.ext.toLowerCase() !== '.json') {
    throw new Error('Index template output must end with .json')
  }

  return normalizedTarget
}

function formatDuration(durationMs: number): string {
  const seconds = (durationMs / 1000).toFixed(2)
  return `${seconds}s`
}

const JSON_COLOR_ANSI = {
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  gray: '\u001b[90m',
  reset: '\u001b[0m',
} as const

function colorizeJson(payload: string, enabled: boolean): string {
  if (!enabled) return payload

  return payload.replace(
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(?::)?|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b)/g,
    token => {
      let color: keyof typeof JSON_COLOR_ANSI | null = null

      if (token.startsWith('"') && token.endsWith(':')) {
        color = 'cyan'
      } else if (token.startsWith('"')) {
        color = 'green'
      } else if (token === 'true' || token === 'false') {
        color = 'yellow'
      } else if (token === 'null') {
        color = 'gray'
      } else {
        color = 'yellow'
      }

      return `${JSON_COLOR_ANSI[color]}${token}${JSON_COLOR_ANSI.reset}`
    },
  )
}

function formatJsonOutput(value: unknown, useColor: boolean): string {
  const payload = JSON.stringify(value, null, 2)
  if (typeof payload !== 'string') {
    throw new Error('Unable to serialize JSON output.')
  }

  return `${colorizeJson(payload, useColor)}\n`
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function parsePageRange(
  pageRange?: string,
): { start: number; end: number } | null {
  if (!pageRange) return null
  const match = pageRange.match(/^(\d+)-(\d+)$/)
  if (!match) return null
  return {
    start: Number(match[1]),
    end: Number(match[2]),
  }
}

function formatOverlapRange(start: number, end: number): string {
  return start === end ? `page ${start}` : `pages ${start}-${end}`
}

function findPageOverlaps(sections: ContentSection[]): Array<{
  leftTitle: string
  leftRange: string
  rightTitle: string
  rightRange: string
  overlapStart: number
  overlapEnd: number
}> {
  const ranges = sections
    .map(section => {
      const parsed = parsePageRange(section.pageRange)
      if (!parsed) return null
      return {
        title: section.title?.trim() || `Section ${section.index}`,
        range: section.pageRange!,
        start: parsed.start,
        end: parsed.end,
      }
    })
    .filter(Boolean) as Array<{
    title: string
    range: string
    start: number
    end: number
  }>

  const overlaps: Array<{
    leftTitle: string
    leftRange: string
    rightTitle: string
    rightRange: string
    overlapStart: number
    overlapEnd: number
  }> = []

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const left = ranges[i]
      const right = ranges[j]
      const overlapStart = Math.max(left.start, right.start)
      const overlapEnd = Math.min(left.end, right.end)

      if (overlapStart <= overlapEnd) {
        overlaps.push({
          leftTitle: left.title,
          leftRange: left.range,
          rightTitle: right.title,
          rightRange: right.range,
          overlapStart,
          overlapEnd,
        })
      }
    }
  }

  return overlaps
}

function buildPdfSectionSummary(section: ContentSection): string {
  const title = section.title?.trim() || `Section ${section.index}`
  const pageRange = section.pageRange ? ` | pages: ${section.pageRange}` : ''
  const pageCount =
    typeof section.pageCount === 'number'
      ? ` (${formatCount(section.pageCount)} page${section.pageCount === 1 ? '' : 's'})`
      : ''
  const charCount = section.text?.length ?? 0
  return `- ${title}${pageRange}${pageCount} | chars: ${formatCount(charCount)}`
}

function logPdfExtractionSummary(options: {
  logger: CliUi['logger']
  sourcePath: string
  book: BookJson
  indexProvided: boolean
}) {
  const { logger, sourcePath, book, indexProvided } = options
  const fileName = parse(sourcePath).base
  const totalPages = book.metadata?.totalPages
  const sections = book.content

  logger.info(`Processing PDF: ${fileName}:`)
  if (typeof totalPages === 'number' && totalPages > 0) {
    logger.info(`- total pages: ${formatCount(totalPages)}`)
  }

  logger.info('Index:')
  if (!indexProvided) {
    logger.info('- no index provided')
  }

  if (sections.length === 0) {
    logger.info('- no sections extracted')
    return
  }

  for (const section of sections) {
    logger.info(buildPdfSectionSummary(section))
  }

  if (indexProvided) {
    for (const overlap of findPageOverlaps(sections)) {
      logger.warn(
        `Page overlap between "${overlap.leftTitle}" (${overlap.leftRange}) and "${overlap.rightTitle}" (${overlap.rightRange}) on ${formatOverlapRange(overlap.overlapStart, overlap.overlapEnd)}.`,
      )
    }
  }
}

const MAX_MARKDOWN_VALIDATION_ATTEMPTS = 3

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  return fallback
}

function isCI(): boolean {
  const ci = process.env.CI
  return typeof ci === 'string' && ci.length > 0 && ci !== '0'
}

type UiBuildArgs = {
  verbose?: unknown
  quiet?: unknown
  color?: unknown
  spinner?: unknown
}

type CliUi = {
  logger: ReturnType<typeof createLogger>
  spinner: Spinner
  progress: ProgressBar
  useColor: boolean
  animationsEnabled: boolean
  progressEnabled: boolean
}

function buildCliUi(args: UiBuildArgs): CliUi {
  const verbose = toBool(args.verbose, false)
  const quiet = toBool(args.quiet, false)

  if (verbose && quiet) {
    throw new Error('Use either --verbose or --quiet, not both.')
  }

  const level: LogLevel = verbose ? 'debug' : quiet ? 'warn' : 'info'
  const useColor =
    toBool(args.color, true) &&
    process.stdout.isTTY &&
    process.env.NO_COLOR !== '1'
  const animationsEnabled =
    toBool(args.spinner, true) && process.stdout.isTTY && !isCI()
  const progressEnabled = animationsEnabled && !verbose

  return {
    logger: createLogger({ level, useColor }),
    spinner: createSpinner({ enabled: animationsEnabled }),
    progress: createProgressBar({ enabled: progressEnabled, useColor }),
    useColor,
    animationsEnabled,
    progressEnabled,
  }
}

function withUiOptions<T>(y: Argv<T>): Argv<T> {
  return y
    .option('verbose', {
      type: 'boolean',
      default: false,
      describe: 'Show detailed execution logs.',
    })
    .option('quiet', {
      alias: 'q',
      type: 'boolean',
      default: false,
      describe: 'Show warnings and errors only.',
    })
    .option('color', {
      type: 'boolean',
      default: true,
      describe: 'Enable ANSI colors. Use --no-color to disable.',
    })
    .option('spinner', {
      type: 'boolean',
      default: true,
      describe: 'Enable loading animations. Use --no-spinner to disable.',
    })
}

async function runWithSpinner<T>(
  spinner: Spinner,
  text: string,
  action: () => Promise<T>,
): Promise<T> {
  spinner.start(text)
  try {
    return await action()
  } finally {
    spinner.stop()
  }
}

async function runWithProgressHeartbeat<T>(options: {
  progress: ProgressBar
  current: number
  label: string
  action: () => Promise<T>
  intervalMs?: number
  animateSpinner?: boolean
}): Promise<T> {
  const {
    progress,
    current,
    label,
    action,
    intervalMs = 1000,
    animateSpinner = false,
  } = options
  const spinnerFrames = ['|', '/', '-', '\\']
  let frameIndex = 0

  function renderHeartbeat() {
    const frame = animateSpinner
      ? spinnerFrames[frameIndex % spinnerFrames.length]
      : ''
    frameIndex += 1
    progress.update(current, label, frame)
  }

  renderHeartbeat()

  const timer = setInterval(() => {
    renderHeartbeat()
  }, intervalMs)
  timer.unref?.()

  try {
    return await action()
  } finally {
    clearInterval(timer)
  }
}

type GenerateFlashcardsRequest = {
  provider: SupportedProvider
  model: string
  apiKey: string
  prompt: string
  content: string
}

async function generateFlashcards(
  options: GenerateFlashcardsRequest,
): Promise<string> {
  return generateFlashcardsFromServer(options)
}

async function handleListLocalPrompts(args: UiBuildArgs): Promise<void> {
  let ui: CliUi | null = null
  try {
    ui = buildCliUi(args)
    const prompts = await runWithSpinner(
      ui.spinner,
      'Loading prompts...',
      async () => listLocalPrompts(),
    )

    for (const prompt of prompts) {
      process.stdout.write(`${prompt.name}\n`)
    }
  } catch (error) {
    ui?.spinner.stop()
    ;(ui?.logger ?? createLogger({ level: 'info', useColor: false })).error(
      `Failed to list prompts: ${(error as Error).message}`,
    )
    process.exitCode = 1
  }
}

async function handleListRemotePrompts(args: UiBuildArgs): Promise<void> {
  let ui: CliUi | null = null
  try {
    ui = buildCliUi(args)
    const prompts = await runWithSpinner(
      ui.spinner,
      'Loading remote prompts...',
      async () => listRemotePrompts(),
    )

    for (const prompt of prompts) {
      process.stdout.write(`${prompt.name}\n`)
    }
  } catch (error) {
    ui?.spinner.stop()
    ;(ui?.logger ?? createLogger({ level: 'info', useColor: false })).error(
      `Failed to list remote prompts: ${(error as Error).message}`,
    )
    process.exitCode = 1
  }
}

async function handleGetPrompt(
  args: UiBuildArgs & {
    name?: unknown
    force?: unknown
  },
): Promise<void> {
  let ui: CliUi | null = null
  try {
    ui = buildCliUi(args)
    const name = String(args.name ?? '').trim()
    if (name.length === 0) {
      throw new Error('Provide a prompt name to install.')
    }

    const result = await runWithSpinner(
      ui.spinner,
      `Installing prompt "${name}"...`,
      async () =>
        installRemotePrompt(name, {
          force: toBool(args.force, false),
        }),
    )

    const verb = result.overwritten ? 'Updated' : 'Installed'
    ui.logger.success(`${verb} prompt "${result.name}" at ${result.path}`)
  } catch (error) {
    ui?.spinner.stop()
    ;(ui?.logger ?? createLogger({ level: 'info', useColor: false })).error(
      `Failed to install prompt: ${(error as Error).message}`,
    )
    process.exitCode = 1
  }
}

async function handlePrintConfig(args: UiBuildArgs): Promise<void> {
  let ui: CliUi | null = null
  try {
    ui = buildCliUi(args)
    const settings = await runWithSpinner(
      ui.spinner,
      'Loading configuration...',
      async () => {
        const paths = await ensureConfig()
        const raw = await fs.readFile(paths.settings, 'utf8')
        return JSON.parse(raw)
      },
    )

    process.stdout.write(formatJsonOutput(settings, ui.useColor))
  } catch (error) {
    ui?.spinner.stop()
    ;(ui?.logger ?? createLogger({ level: 'info', useColor: false })).error(
      `Failed to print config: ${(error as Error).message}`,
    )
    process.exitCode = 1
  }
}

const rawArgs = hideBin(process.argv)

const cli = yargs(rawArgs)
  .scriptName('pdfanki')
  .usage('$0 [options]')
  .command(
    'reset-config',
    'Remove and recreate the pdfanki config directory with defaults.',
    y => withUiOptions(y),
    async args => {
      let ui: CliUi | null = null
      try {
        ui = buildCliUi(args)
        const paths = await runWithSpinner(
          ui.spinner,
          'Resetting configuration...',
          async () => resetConfig(),
        )
        ui.logger.success(
          `Config reset at ${paths.dir} (settings.json and prompts recreated).`,
        )
      } catch (error) {
        ui?.spinner.stop()
        ;(ui?.logger ?? createLogger({ level: 'info', useColor: false })).error(
          `Failed to reset config: ${(error as Error).message ?? error}`,
        )
        process.exitCode = 1
      }
    },
  )
  .command(
    'config',
    'Print the current settings.json configuration to stdout.',
    y => withUiOptions(y),
    async args => handlePrintConfig(args),
  )
  .command(
    'prompts <subcommand>',
    'List and install local or remote prompts.',
    y =>
      y
        .command(
          'list',
          'List prompt names available in the local pdfanki prompts directory.',
          commandY => withUiOptions(commandY),
          async args => handleListLocalPrompts(args),
        )
        .command(
          'list-remote',
          'List prompt names available in the GitHub prompt directory.',
          commandY => withUiOptions(commandY),
          async args => handleListRemotePrompts(args),
        )
        .command(
          'get <name>',
          'Download a prompt from GitHub into the local pdfanki prompts directory.',
          commandY =>
            withUiOptions(
              commandY
                .positional('name', {
                  type: 'string',
                  describe: 'Prompt name without the .md extension.',
                  demandOption: true,
                })
                .option('force', {
                  type: 'boolean',
                  default: false,
                  describe: 'Overwrite the local prompt if it already exists.',
                }),
            ),
          async args => handleGetPrompt(args),
        )
        .demandCommand(1, 'Choose a prompts subcommand.'),
    async () => {},
  )
  .command(
    'list-prompts',
    false,
    y => withUiOptions(y),
    async args => handleListLocalPrompts(args),
  )
  .command(
    'index-template <count> [out]',
    'Generate a blank index with <count> sections and exit.',
    y =>
      withUiOptions(
        y
          .positional('count', {
            type: 'number',
            describe: 'Number of sections in the template.',
            demandOption: true,
          })
          .positional('out', {
            type: 'string',
            describe:
              'Output path (directory or .json). Defaults to ./index.json or ./<input>.index.json when --from-file is provided.',
          })
          .option('from-file', {
            alias: 'f',
            type: 'string',
            describe:
              'Optional input PDF used to derive the default output name (<input>.index.json).',
          }),
      ),
    async args => {
      let ui: CliUi | null = null
      try {
        ui = buildCliUi(args)
        const count = args.count as number
        if (
          typeof count !== 'number' ||
          !Number.isInteger(count) ||
          count <= 0
        ) {
          throw new Error(
            'Provide a positive integer for <count> when creating an index template.',
          )
        }

        const fromFilePath = normalizePathArg(
          args.fromFile as string | undefined,
        )
        const outputPath = resolveIndexTemplatePath(
          normalizePathArg(args.out as string | undefined),
          fromFilePath,
        )

        await runWithSpinner(
          ui.spinner,
          'Creating index template...',
          async () => {
            const payload = JSON.stringify(buildIndexTemplate(count), null, 2)
            await fs.mkdir(dirname(outputPath), { recursive: true })
            await fs.writeFile(outputPath, payload, 'utf8')
          },
        )

        ui.logger.success(
          `Created index template with ${count} section(s) at ${outputPath}`,
        )
        ui.logger.info(
          'Use --index <path> with PDFs to apply this chapter map.',
        )
      } catch (error) {
        ui?.spinner.stop()
        ;(ui?.logger ?? createLogger({ level: 'info', useColor: false })).error(
          `Failed to create index template: ${(error as Error).message}`,
        )
        process.exitCode = 1
      }
    },
  )
  .command(
    '$0',
    'Convert a PDF or EPUB to flashcards',
    y =>
      withUiOptions(
        y
          .option('from-file', {
            alias: 'f',
            type: 'string',
            describe: 'Path to pdf/epub file',
          })
          .option('from-json', {
            type: 'string',
            describe:
              'Path to a JSON file (matching pdfanki extract shape) to skip PDF/EPUB parsing.',
          })
          .option('from-md', {
            type: 'string',
            describe:
              'Path to an existing markdown deck to convert to an Anki package.',
          })
          .option('to-json', {
            type: 'string',
            describe:
              'Write a minimal JSON (index/title/text only) to a path (defaults to ./<input>.json) and stop (no model call).',
          })
          .option('to-json-verbose', {
            type: 'string',
            describe:
              'Write a full-fidelity JSON (no metadata/content pruning, no EPUB regex filtering) to a path (defaults to ./<input>.json) and stop (no model call).',
          })
          .option('to-md', {
            type: 'string',
            describe:
              'Generate the markdown deck (path optional, defaults to ./<input>.md). Skips Anki unless --to-anki is also set.',
          })
          .option('to-anki', {
            type: 'string',
            describe:
              'Generate an Anki package (path optional, defaults to ./<input>.apkg). This is the default export if none is specified.',
          })
          .option('type', {
            alias: 't',
            type: 'string',
            choices: ['pdf', 'epub'],
            describe: 'Optional file type. Inferred from extension if omitted.',
          })
          .option('index', {
            type: 'string',
            describe:
              'Path to a JSON index for PDF chapter separation (ignored for EPUB).',
          })
          .option('start-chapter', {
            type: 'number',
            describe:
              'First EPUB chapter to extract (1-based, inclusive). Not supported for PDFs.',
          })
          .option('end-chapter', {
            type: 'number',
            describe:
              'Last EPUB chapter to extract (1-based, inclusive). Not supported for PDFs.',
          })
          .option('min-char', {
            type: 'number',
            describe:
              'Filter out sections with fewer than this many characters.',
          })
          .option('provider', {
            type: 'string',
            choices: [
              'gemini',
              'anthropic',
              'openai',
              'deepseek',
              'openrouter',
            ],
            describe:
              'AI provider (expects API key in PROVIDER_API_KEY env var). Defaults to settings.json.',
          })
          .option('prompt', {
            alias: 'p',
            type: 'string',
            describe: 'Prompt to load, e.g. "default" -> prompts/default.md.',
            default: 'default',
          })
          .option('model', {
            alias: 'm',
            type: 'string',
            describe: 'Model name for the chosen provider.',
          })
          .option('deck-title', {
            alias: 'd',
            type: 'string',
            describe: 'Anki Deck title. Defaults to the input filename.',
          })
          .option('debug', {
            type: 'boolean',
            default: false,
            describe: 'Enable verbose PDF parser warnings (pdf.js verbosity).',
          })
          .option('dry-run', {
            type: 'boolean',
            default: false,
            describe:
              'Run normally but skip writing JSON, markdown, .apkg, and failure artifact files.',
          }),
      ),
    async args => {
      const ui = buildCliUi(args)
      const { logger, spinner, progress } = ui
      let progressStarted = false

      try {
        const settings = await runWithSpinner(
          spinner,
          'Loading configuration...',
          async () => {
            await ensureConfig()
            return loadSettings()
          },
        )

        const fromJsonPath = args.fromJson as string | undefined
        const fromMarkdownPath = args.fromMd as string | undefined
        const fromFilePath = args.fromFile as string | undefined
        const dryRun = toBool(args.dryRun, false)

        const toJsonRaw = args.toJson
        const toJsonVerboseRaw = args.toJsonVerbose
        const toMarkdownRaw = args.toMd
        const toAnkiRaw = args.toAnki

        const toJsonRequested = flagProvided(toJsonRaw)
        const toJsonVerboseRequested = flagProvided(toJsonVerboseRaw)
        const toMarkdownRequested = flagProvided(toMarkdownRaw)
        let toAnkiRequested =
          flagProvided(toAnkiRaw) ||
          (!toJsonRequested && !toJsonVerboseRequested && !toMarkdownRequested)

        if (toJsonRequested && toJsonVerboseRequested) {
          throw new Error('Use --to-json or --to-json-verbose, not both.')
        }

        if (toMarkdownRequested && !flagProvided(toAnkiRaw)) {
          toAnkiRequested = false
        }

        const extractVerbose = toJsonVerboseRequested
        const checkpoint = toJsonRequested || toJsonVerboseRequested
        const markdownOnly = toMarkdownRequested && !toAnkiRequested

        if (!fromJsonPath && !fromFilePath && !fromMarkdownPath) {
          throw new Error(
            'Provide --from-file <file>, --from-json <json path>, or --from-md <markdown path>.',
          )
        }
        const minCharArg = args.minChar as number | undefined
        if (
          typeof minCharArg !== 'undefined' &&
          (!Number.isFinite(minCharArg) ||
            minCharArg < 0 ||
            !Number.isInteger(minCharArg))
        ) {
          throw new Error('--min-char must be a non-negative integer.')
        }
        const minChars = typeof minCharArg === 'number' ? minCharArg : undefined
        const startChapterArg = args.startChapter as number | undefined
        const endChapterArg = args.endChapter as number | undefined

        if (
          typeof startChapterArg !== 'undefined' &&
          (!Number.isFinite(startChapterArg) ||
            startChapterArg <= 0 ||
            !Number.isInteger(startChapterArg))
        ) {
          throw new Error('--start-chapter must be a positive integer.')
        }

        if (
          typeof endChapterArg !== 'undefined' &&
          (!Number.isFinite(endChapterArg) ||
            endChapterArg <= 0 ||
            !Number.isInteger(endChapterArg))
        ) {
          throw new Error('--end-chapter must be a positive integer.')
        }

        const deckTitleArg = (args.deckTitle as string | undefined)?.trim()
        const defaultBaseName = (() => {
          if (fromMarkdownPath) return parse(fromMarkdownPath).name
          if (fromJsonPath) return parse(fromJsonPath).name
          if (fromFilePath) return parse(fromFilePath).name
          return 'deck'
        })()
        const outputBaseName = toKebabAlnum(defaultBaseName || 'deck')

        const toJsonPath = checkpoint
          ? resolveOutputPath(
              normalizePathArg(
                (toJsonVerboseRaw ?? toJsonRaw) as string | undefined | boolean,
              ),
              outputBaseName,
              '.json',
            )
          : null
        const markdownPath =
          toMarkdownRequested || toAnkiRequested
            ? resolveOutputPath(
                normalizePathArg(toMarkdownRaw as string | undefined | boolean),
                outputBaseName,
                '.md',
              )
            : null
        const ankiOutputPath = toAnkiRequested
          ? resolveOutputPath(
              normalizePathArg(toAnkiRaw as string | undefined | boolean),
              outputBaseName,
              '.apkg',
            )
          : null

        if (fromMarkdownPath) {
          if (checkpoint) {
            throw new Error(
              'JSON export flags are not supported with --from-md.',
            )
          }

          const markdownSource = await runWithSpinner(
            spinner,
            'Reading markdown deck...',
            async () => fs.readFile(fromMarkdownPath, 'utf8'),
          )

          const headingMatch = markdownSource.match(/^#\s+(.+)\s*$/m)
          const deckTitle =
            deckTitleArg && deckTitleArg.length > 0
              ? deckTitleArg
              : headingMatch?.[1]?.trim() || parse(fromMarkdownPath).name
          const finalOutputPath =
            ankiOutputPath ??
            resolveOutputPath(undefined, outputBaseName, '.apkg')

          if (dryRun) {
            logger.info('- dry run: Anki package creation skipped')
            logger.info(`- would read markdown from ${fromMarkdownPath}`)
            logger.info(`- would build Anki package at ${finalOutputPath}`)
            logger.info(`Deck title: ${deckTitle}`)
            return
          }

          await runWithSpinner(spinner, 'Building Anki deck...', async () => {
            await fs.mkdir(dirname(finalOutputPath), { recursive: true })
            const deckConversionOptions: ConvertMarkdownToAnkiDeckOptions = {
              target: finalOutputPath,
              deckName: deckTitle,
            }
            await convertMarkdownToAnkiDeck(
              fromMarkdownPath,
              deckConversionOptions,
            )
          })

          logger.success(
            `Generated Anki deck from markdown ${fromMarkdownPath} -> ${finalOutputPath}`,
          )
          logger.info(`Deck title: ${deckTitle}`)
          return
        }

        const provider =
          (args.provider as SupportedProvider | undefined) ??
          settings.defaultProvider
        const providerSettings = settings.providers[provider]
        const defaultModel =
          providerSettings?.defaultModel ??
          settings.providers[settings.defaultProvider]?.defaultModel
        const model = (args.model as string | undefined) ?? defaultModel
        const apiKeyLookup = readProviderApiKey(provider)

        if (!apiKeyLookup.apiKey && !checkpoint) {
          logger.warn(
            `Missing API key for provider "${provider}". Set ${apiKeyLookup.envVar} in your environment.`,
          )
        }

        const providerModelHints: Record<SupportedProvider, RegExp> = {
          gemini: /^gemini/i,
          anthropic: /^claude/i,
          openai: /^gpt/i,
          deepseek: /^deepseek/i,
          openrouter:
            /^(?:openrouter\/)?[a-z0-9._-]+\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)?$/i,
        }

        const hint = providerModelHints[provider]
        if (model && hint && !hint.test(model)) {
          logger.warn(
            `Model "${model}" may not belong to provider "${provider}".`,
          )
        }

        logger.debug(`Provider: ${provider}`)
        logger.debug(`Model: ${model ?? '(none)'}`)

        let result: {
          data: { content: { index: number; title?: string; text?: string }[] }
          text: string
          fileType: string
          sourcePath: string
        }

        if (fromJsonPath) {
          result = await runWithSpinner(
            spinner,
            'Loading extracted JSON...',
            async () => {
              const raw = await fs.readFile(fromJsonPath, 'utf8')
              const parsed = JSON.parse(raw)
              const validation = validateJsonStructure(parsed, {
                requireMetadata: false,
                requireTitles: false,
              })
              if (!validation.isValid) {
                throw new Error(`Invalid JSON input: ${validation.error}`)
              }
              return {
                data: parsed,
                text: bookJsonToPlainText(parsed),
                fileType: 'json',
                sourcePath: fromJsonPath,
              }
            },
          )
        } else {
          if (!fromFilePath) {
            throw new Error(
              'Provide --from-file <file> when not using --from-json or --from-md.',
            )
          }
          const options: ConvertFileOptions = {
            inputPath: fromFilePath,
            type: args.type as string | undefined,
            indexPath: args.index as string | undefined,
            startChapter: startChapterArg,
            endChapter: endChapterArg,
            minChars,
            epubFilters: extractVerbose ? { titles: [] } : settings.epubFilters,
            debug: toBool(args.debug, false),
          }

          result = await convertFileFromPath(options)
        }

        if (checkpoint && fromFilePath && result.fileType === 'pdf') {
          logPdfExtractionSummary({
            logger,
            sourcePath: fromFilePath,
            book: result.data,
            indexProvided: Boolean(args.index),
          })
        }

        const basicExtractPayload = {
          content: result.data.content.map(section => ({
            index: section.index,
            title: section.title,
            text: section.text,
          })),
        }
        const checkpointPayload = JSON.stringify(
          extractVerbose ? result.data : basicExtractPayload,
          null,
          2,
        )

        const inputStem = fromFilePath ? parse(fromFilePath).name : ''
        const jsonStem = fromJsonPath ? parse(fromJsonPath).name : inputStem

        if (checkpoint) {
          if (!toJsonPath) {
            throw new Error('No output path resolved for JSON export.')
          }
          const usedDefaultCheckpointOutput = !normalizePathArg(
            (toJsonVerboseRaw ?? toJsonRaw) as string | undefined | boolean,
          )

          if (dryRun) {
            logger.info('- dry run: extracted JSON not written to disk')
            logger.info(`- would write JSON to ${toJsonPath}`)
            if (usedDefaultCheckpointOutput) {
              logger.info(`- output path defaulted to cwd: ${process.cwd()}`)
            }
            return
          }

          await runWithSpinner(
            spinner,
            'Writing extracted JSON...',
            async () => {
              await fs.mkdir(dirname(toJsonPath), { recursive: true })
              await fs.writeFile(toJsonPath, checkpointPayload)
            },
          )

          logger.success(`Saved extracted JSON to ${toJsonPath}`)
          if (usedDefaultCheckpointOutput) {
            logger.info(`- output path defaulted to cwd: ${process.cwd()}`)
          }
          return
        }

        if (!model) {
          throw new Error(
            'Model is required when invoking a provider. Set it via --model or settings.json.',
          )
        }

        if (!apiKeyLookup.apiKey) {
          throw new Error(
            `Missing API key for provider "${provider}". Set ${apiKeyLookup.envVar} in your environment.`,
          )
        }

        const prompt = await runWithSpinner(
          spinner,
          'Loading prompt...',
          async () => loadPrompt(args.prompt as string | undefined),
        )

        const deckTitle =
          deckTitleArg && deckTitleArg.length > 0
            ? deckTitleArg
            : fromJsonPath
              ? jsonStem
              : inputStem || defaultBaseName

        if (!markdownPath) {
          throw new Error('No markdown output path resolved.')
        }

        const usedDefaultMarkdownPath = !normalizePathArg(
          toMarkdownRaw as string | undefined | boolean,
        )
        const usedDefaultAnkiPath = !normalizePathArg(
          toAnkiRaw as string | undefined | boolean,
        )

        if (!dryRun) {
          await fs.mkdir(dirname(markdownPath), { recursive: true })
          if (ankiOutputPath && !markdownOnly) {
            await fs.mkdir(dirname(ankiOutputPath), { recursive: true })
          }
        }

        const sections = result.data?.content ?? []
        if (sections.length === 0) {
          throw new Error('No content sections found to generate flashcards.')
        }

        logger.info(
          `Generating flashcards in ${sections.length} section(s) (sequential).`,
        )
        const totalSections = sections.length
        const generationStart = Date.now()
        const aggregatedCards: Flashcard[] = []
        const showPerSectionLogs = logger.isDebugEnabled || !ui.progressEnabled

        if (ui.progressEnabled) {
          progress.start(totalSections, 'Starting generation')
          progressStarted = true
        }

        for (const [position, section] of sections.entries()) {
          const sectionTitle = section.title?.trim()
          const sectionText = section.text?.trim()
          const sectionStart = Date.now()
          const sectionPrefix = `Section ${position + 1}/${totalSections}`
          const sectionLabel = sectionTitle
            ? `${sectionPrefix} - ${sectionTitle}`
            : sectionPrefix
          const sectionProgressName = sectionTitle || sectionPrefix

          if (showPerSectionLogs) {
            logger.info(`-> ${sectionLabel}`)
          }

          if (!sectionText) {
            if (progressStarted) {
              progress.clear()
            }
            throw new Error(
              `Section ${position + 1} has no text to process for flashcards.`,
            )
          }

          let rawResponse: string | null = null
          try {
            let parsedCards: Flashcard[] | null = null

            for (
              let attempt = 1;
              attempt <= MAX_MARKDOWN_VALIDATION_ATTEMPTS;
              attempt++
            ) {
              const retrySuffix =
                attempt > 1
                  ? ` (retry ${attempt}/${MAX_MARKDOWN_VALIDATION_ATTEMPTS})`
                  : ''
              const response = progressStarted
                ? await runWithProgressHeartbeat({
                    progress,
                    current: position,
                    label: `${sectionProgressName} | Model reasoning...${retrySuffix}`,
                    intervalMs: 100,
                    animateSpinner: true,
                    action: () =>
                      generateFlashcards({
                        provider,
                        model,
                        apiKey: apiKeyLookup.apiKey,
                        prompt: prompt.contents,
                        content: sectionText,
                      }),
                  })
                : await generateFlashcards({
                    provider,
                    model,
                    apiKey: apiKeyLookup.apiKey,
                    prompt: prompt.contents,
                    content: sectionText,
                  })

              rawResponse = response
              try {
                parsedCards = parseFlashcardMarkdown(response)
                break
              } catch (validationError) {
                if (!(validationError instanceof Error)) {
                  throw validationError
                }

                if (attempt < MAX_MARKDOWN_VALIDATION_ATTEMPTS) {
                  if (showPerSectionLogs) {
                    logger.warn(
                      `   markdown validation failed on attempt ${attempt}/${MAX_MARKDOWN_VALIDATION_ATTEMPTS}; retrying model call for the same section.`,
                    )
                    logger.warn(validationError.message)
                  }
                  continue
                }

                throw new Error(
                  `Markdown formatting remained invalid after ${MAX_MARKDOWN_VALIDATION_ATTEMPTS} attempts.\n${validationError.message}`,
                )
              }
            }

            if (!parsedCards) {
              throw new Error(
                `No valid markdown response parsed after ${MAX_MARKDOWN_VALIDATION_ATTEMPTS} attempts.`,
              )
            }

            aggregatedCards.push(...parsedCards)
            const duration = formatDuration(Date.now() - sectionStart)

            if (showPerSectionLogs) {
              logger.info(
                `   status: success | flashcards: ${parsedCards.length} | time: ${duration}`,
              )
            }

            if (progressStarted) {
              progress.increment(sectionLabel)
            }
          } catch (error) {
            if (progressStarted) {
              progress.clear()
            }

            const duration = formatDuration(Date.now() - sectionStart)
            logger.error(
              `${sectionLabel} failed | flashcards: 0 | time: ${duration}`,
            )

            if (dryRun) {
              logger.warn(
                'Dry run enabled; partial markdown and failed section artifacts were not written.',
              )
            } else {
              const markdownDir = dirname(markdownPath)
              const partialPath = join(
                markdownDir,
                `${outputBaseName}-partial.md`,
              )
              const failedSectionPath = join(
                markdownDir,
                `${outputBaseName}-failed-section-${position + 1}.md`,
              )

              const partialBody =
                aggregatedCards.length > 0
                  ? renderFlashcards(aggregatedCards)
                  : ''
              const partialPayload = buildDeckMarkdown(deckTitle, partialBody)
              await fs.mkdir(dirname(partialPath), { recursive: true })
              await fs.writeFile(partialPath, partialPayload, 'utf8')

              const failedPayload =
                rawResponse && rawResponse.trim().length > 0
                  ? rawResponse
                  : 'No model response captured for this section.'
              await fs.mkdir(dirname(failedSectionPath), { recursive: true })
              await fs.writeFile(failedSectionPath, failedPayload, 'utf8')

              logger.warn(`Partial markdown saved to ${partialPath}`)
              logger.warn(
                `Failed section output saved to ${failedSectionPath} (${sectionLabel})`,
              )
            }

            throw new Error(
              `Section ${position + 1} failed: ${(error as Error).message}`,
            )
          }
        }

        if (progressStarted) {
          progress.stop()
          progressStarted = false
        }

        if (aggregatedCards.length === 0) {
          throw new Error(
            'Flashcard generation produced no cards. Check the prompt or input content.',
          )
        }

        const totalDuration = formatDuration(Date.now() - generationStart)
        logger.success(
          `Generated ${aggregatedCards.length} flashcards in ${totalDuration}.`,
        )

        const flashcards = renderFlashcards(aggregatedCards)
        const markdownPayload = buildDeckMarkdown(deckTitle, flashcards)

        if (dryRun) {
          logger.info('- dry run: markdown deck not written to disk')
          logger.info(`- would write markdown to ${markdownPath}`)
          if (usedDefaultMarkdownPath) {
            logger.info('Output path defaulted to current working directory.')
          }
          if (!markdownOnly && ankiOutputPath) {
            logger.info('- dry run: Anki package creation skipped')
            logger.info(`- would build Anki package at ${ankiOutputPath}`)
            if (usedDefaultAnkiPath) {
              logger.info('Output path defaulted to current working directory.')
            }
          }
          logger.info(`Using prompt "${prompt.name}" from ${prompt.path}`)
          return
        }

        await runWithSpinner(spinner, 'Writing markdown deck...', async () => {
          await fs.writeFile(markdownPath, markdownPayload, 'utf8')
        })

        if (markdownOnly) {
          logger.success(
            `Generated markdown flashcards from ${fromJsonPath ?? fromFilePath} -> ${markdownPath}`,
          )
          if (usedDefaultMarkdownPath) {
            logger.info('Output path defaulted to current working directory.')
          }
          logger.info(`Using prompt "${prompt.name}" from ${prompt.path}`)
          return
        }

        if (!ankiOutputPath) {
          throw new Error('No Anki output path resolved.')
        }

        await runWithSpinner(spinner, 'Building Anki package...', async () => {
          const deckConversionOptions: ConvertMarkdownToAnkiDeckOptions = {
            target: ankiOutputPath,
            deckName: deckTitle,
          }
          await convertMarkdownToAnkiDeck(markdownPath, deckConversionOptions)
        })

        logger.success(
          `Generated Anki deck from ${fromJsonPath ?? fromFilePath} (${result.fileType.toUpperCase()}) -> ${ankiOutputPath}`,
        )
        if (usedDefaultAnkiPath) {
          logger.info('Output path defaulted to current working directory.')
        }
        if (usedDefaultMarkdownPath) {
          logger.info('Deck markdown defaulted to current working directory.')
        }
        logger.info(`Deck markdown saved to ${markdownPath}`)
        logger.info(`Using prompt "${prompt.name}" from ${prompt.path}`)
      } catch (error) {
        spinner.stop()
        if (progressStarted) {
          progress.clear()
        }
        logger.error(`Conversion failed: ${(error as Error).message}`)
        process.exitCode = 1
      }
    },
  )
  .strict()
  .help()
  .alias('h', 'help')
  .alias('v', 'version')

if (rawArgs.length === 0) {
  cli.showHelp()
  process.exit(0)
}

cli.parse()
