#!/usr/bin/env node
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, parse } from 'path'
import {
  convertMarkdownToAnkiDeck,
  type ConvertMarkdownToAnkiDeckOptions,
} from '@shbernal/mdanki'
import yargs, { type Argv } from 'yargs'
import { hideBin } from 'yargs/helpers'
import {
  convertFileFromPath,
  generateFlashcards as generateFlashcardsFromServer,
  validateJsonStructure,
  type BookJson,
  type ContentSection,
  type ConvertFileOptions,
} from './pdfankiRuntime.js'
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

const callerCwd = process.env.PDFANKI_CALLER_CWD
if (callerCwd && callerCwd !== process.cwd()) {
  process.chdir(callerCwd)
}

function toKebabAlnum(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
  const collapsed = normalized.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return collapsed || 'deck'
}

type IndexTemplateEntry = {
  start: number
  end: number
  title?: string
}

function buildIndexTemplate(count: number): IndexTemplateEntry[] {
  const items: IndexTemplateEntry[] = []
  for (let i = 1; i <= count; i++) {
    const start = (i - 1) * 2 + 1
    const end = start + 1
    items.push({ start, end, title: `Section ${i}` })
  }
  return items
}

function formatIndexTemplate(entries: IndexTemplateEntry[]): string {
  if (entries.length === 0) {
    return '[]\n'
  }

  const lines = entries.map(entry => {
    const parts = [`"start": ${entry.start}`, `"end": ${entry.end}`]
    if (entry.title?.trim()) {
      parts.push(`"title": ${JSON.stringify(entry.title)}`)
    }
    return `  { ${parts.join(', ')} }`
  })

  return `[\n${lines.join(',\n')}\n]\n`
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

async function handleResetConfig(args: UiBuildArgs): Promise<void> {
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
}

type CliSettings = Awaited<ReturnType<typeof loadSettings>>
type WorkflowSourceKind = 'pdf' | 'epub' | 'json' | 'md'
type WorkflowTargetKind = 'json' | 'md' | 'anki'
type StructuredSourceKind = Exclude<WorkflowSourceKind, 'md'>

type WorkflowCommandArgs = UiBuildArgs & {
  input?: unknown
  out?: unknown
  fullFidelity?: unknown
  index?: unknown
  indexRanges?: unknown
  startChapter?: unknown
  endChapter?: unknown
  minChar?: unknown
  provider?: unknown
  prompt?: unknown
  model?: unknown
  deckTitle?: unknown
  debug?: unknown
  dryRun?: unknown
}

type StructuredSourceResult = {
  data: BookJson
  fileType: StructuredSourceKind
  sourcePath: string
}

const PROVIDER_MODEL_HINTS: Record<SupportedProvider, RegExp> = {
  gemini: /^gemini/i,
  anthropic: /^claude/i,
  openai: /^gpt/i,
  deepseek: /^deepseek/i,
  openrouter:
    /^(?:openrouter\/)?[a-z0-9._-]+\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)?$/i,
}

function normalizeRequiredInputPath(value: unknown): string {
  const normalized = normalizePathArg(value)
  if (!normalized) {
    throw new Error('Provide an <input> path.')
  }
  return normalized
}

function normalizeIntegerOption(
  value: unknown,
  flagName: string,
  minimum: number,
): number | undefined {
  if (typeof value === 'undefined') return undefined
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < minimum
  ) {
    const expectation =
      minimum === 0 ? 'a non-negative integer' : 'a positive integer'
    throw new Error(`${flagName} must be ${expectation}.`)
  }
  return value
}

function buildBasicExtractPayload(book: BookJson): {
  content: { index: number; title?: string; text?: string }[]
} {
  return {
    content: book.content.map(section => ({
      index: section.index,
      title: section.title,
      text: section.text,
    })),
  }
}

function withSubcommandHelp<T>(y: Argv<T>): Argv<T> {
  return y.updateStrings({ 'Commands:': 'Subcommands:' })
}

function withInputPositional<T>(y: Argv<T>, description: string): Argv<T> {
  return y.positional('input', {
    type: 'string',
    describe: description,
    demandOption: true,
  })
}

function withOutputOption<T>(y: Argv<T>, description: string): Argv<T> {
  return y.option('out', {
    alias: 'o',
    type: 'string',
    describe: description,
  })
}

function withDryRunOption<T>(y: Argv<T>): Argv<T> {
  return y.option('dry-run', {
    type: 'boolean',
    default: false,
    describe:
      'Run normally but skip writing the requested output and failure artifact files.',
  })
}

function withDeckTitleOption<T>(y: Argv<T>): Argv<T> {
  return y.option('deck-title', {
    alias: 'd',
    type: 'string',
    describe: 'Anki deck title. Defaults to the input filename or markdown H1.',
  })
}

function withDebugOption<T>(y: Argv<T>): Argv<T> {
  return y.option('debug', {
    type: 'boolean',
    default: false,
    describe: 'Enable verbose PDF parser warnings (pdf.js verbosity).',
  })
}

function withPdfSourceOptions<T>(y: Argv<T>): Argv<T> {
  return y
    .option('index', {
      type: 'string',
      describe: 'Path to a JSON index for PDF chapter separation.',
    })
    .option('index-ranges', {
      type: 'string',
      describe: 'Inline PDF page ranges like "12-53,54-92,93-118".',
    })
}

function withEpubSourceOptions<T>(y: Argv<T>): Argv<T> {
  return y
    .option('start-chapter', {
      type: 'number',
      describe: 'First EPUB chapter to extract (1-based, inclusive).',
    })
    .option('end-chapter', {
      type: 'number',
      describe: 'Last EPUB chapter to extract (1-based, inclusive).',
    })
    .option('min-char', {
      type: 'number',
      describe: 'Filter out sections with fewer than this many characters.',
    })
}

function withGenerationOptions<T>(y: Argv<T>): Argv<T> {
  return y
    .option('provider', {
      type: 'string',
      choices: ['gemini', 'anthropic', 'openai', 'deepseek', 'openrouter'],
      describe:
        'AI provider (expects API key in PROVIDER_API_KEY env var). Defaults to settings.json.',
    })
    .option('prompt', {
      alias: 'p',
      type: 'string',
      default: 'default',
      describe: 'Prompt to load, e.g. "default" -> prompts/default.md.',
    })
    .option('model', {
      alias: 'm',
      type: 'string',
      describe: 'Model name for the chosen provider.',
    })
}

async function handleIndexTemplate(
  args: UiBuildArgs & {
    count?: unknown
    out?: unknown
    fromFile?: unknown
  },
): Promise<void> {
  let ui: CliUi | null = null
  try {
    ui = buildCliUi(args)
    const count = args.count as number
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
      throw new Error(
        'Provide a positive integer for <count> when creating an index template.',
      )
    }

    const fromFilePath = normalizePathArg(args.fromFile)
    const outputPath = resolveIndexTemplatePath(
      normalizePathArg(args.out),
      fromFilePath,
    )

    await runWithSpinner(ui.spinner, 'Creating index template...', async () => {
      const payload = formatIndexTemplate(buildIndexTemplate(count))
      await fs.mkdir(dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, payload, 'utf8')
    })

    ui.logger.success(
      `Created index template with ${count} section(s) at ${outputPath}`,
    )
    ui.logger.info(
      'Use --index <path> with PDF conversions, or --index-ranges "<start-end,...>" for quick inline ranges.',
    )
  } catch (error) {
    ui?.spinner.stop()
    ;(ui?.logger ?? createLogger({ level: 'info', useColor: false })).error(
      `Failed to create index template: ${(error as Error).message}`,
    )
    process.exitCode = 1
  }
}

async function loadCliSettings(ui: CliUi): Promise<CliSettings> {
  return runWithSpinner(ui.spinner, 'Loading configuration...', async () => {
    await ensureConfig()
    return loadSettings()
  })
}

async function loadStructuredSource(options: {
  sourceKind: StructuredSourceKind
  inputPath: string
  ui: CliUi
  settings: CliSettings
  indexPath?: string
  indexRanges?: string
  startChapter?: number
  endChapter?: number
  minChars?: number
  debug: boolean
  fullFidelity: boolean
}): Promise<StructuredSourceResult> {
  const {
    sourceKind,
    inputPath,
    ui,
    settings,
    indexPath,
    indexRanges,
    startChapter,
    endChapter,
    minChars,
    debug,
    fullFidelity,
  } = options

  if (sourceKind === 'json') {
    return runWithSpinner(ui.spinner, 'Loading extracted JSON...', async () => {
      const raw = await fs.readFile(inputPath, 'utf8')
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
        fileType: 'json',
        sourcePath: inputPath,
      }
    })
  }

  const convertOptions: ConvertFileOptions = {
    inputPath,
    type: sourceKind,
    indexPath,
    indexRanges,
    startChapter,
    endChapter,
    minChars,
    epubFilters: fullFidelity ? { titles: [] } : settings.epubFilters,
    debug,
  }

  return convertFileFromPath(convertOptions)
}

async function buildAnkiPackageFromMarkdownPayload(options: {
  markdownPayload: string
  outputPath: string
  deckTitle: string
}): Promise<void> {
  const { markdownPayload, outputPath, deckTitle } = options
  const tempDir = await fs.mkdtemp(join(tmpdir(), 'pdfanki-anki-'))
  const markdownPath = join(tempDir, 'deck.md')

  try {
    await fs.writeFile(markdownPath, markdownPayload, 'utf8')
    const deckConversionOptions: ConvertMarkdownToAnkiDeckOptions = {
      target: outputPath,
      deckName: deckTitle,
    }
    await convertMarkdownToAnkiDeck(markdownPath, deckConversionOptions)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

async function runWorkflowCommand(
  sourceKind: WorkflowSourceKind,
  targetKind: WorkflowTargetKind,
  args: WorkflowCommandArgs,
): Promise<void> {
  let ui: CliUi | null = null
  let progressStarted = false

  try {
    ui = buildCliUi(args)
    const { logger, spinner, progress } = ui
    const settings = await loadCliSettings(ui)
    const inputPath = normalizeRequiredInputPath(args.input)
    const outputBaseName = toKebabAlnum(parse(inputPath).name || 'deck')
    const outputExtension =
      targetKind === 'json' ? '.json' : targetKind === 'md' ? '.md' : '.apkg'
    const explicitOutputPath = normalizePathArg(args.out)
    const outputPath = resolveOutputPath(
      explicitOutputPath,
      outputBaseName,
      outputExtension,
    )
    const usedDefaultOutputPath = !explicitOutputPath
    const deckTitleArg = normalizePathArg(args.deckTitle)
    const dryRun = toBool(args.dryRun, false)
    const debug = toBool(args.debug, false)
    const fullFidelity = toBool(args.fullFidelity, false)
    const artifactBaseName = parse(outputPath).name || outputBaseName

    const indexPath = normalizePathArg(args.index)
    const indexRanges = normalizePathArg(args.indexRanges)
    if (
      flagProvided(args.indexRanges) &&
      typeof args.indexRanges === 'string' &&
      !indexRanges
    ) {
      throw new Error('--index-ranges must not be empty.')
    }
    if (indexPath && indexRanges) {
      throw new Error(
        'Use --index <path> or --index-ranges "<start-end,...>", not both.',
      )
    }

    const minChars = normalizeIntegerOption(args.minChar, '--min-char', 0)
    const startChapter = normalizeIntegerOption(
      args.startChapter,
      '--start-chapter',
      1,
    )
    const endChapter = normalizeIntegerOption(
      args.endChapter,
      '--end-chapter',
      1,
    )

    if (
      typeof startChapter === 'number' &&
      typeof endChapter === 'number' &&
      startChapter > endChapter
    ) {
      throw new Error(
        '--start-chapter must be less than or equal to --end-chapter.',
      )
    }

    if (sourceKind === 'md') {
      const markdownSource = await runWithSpinner(
        spinner,
        'Reading markdown deck...',
        async () => fs.readFile(inputPath, 'utf8'),
      )

      const headingMatch = markdownSource.match(/^#\s+(.+)\s*$/m)
      const deckTitle =
        deckTitleArg && deckTitleArg.length > 0
          ? deckTitleArg
          : headingMatch?.[1]?.trim() || parse(inputPath).name

      if (dryRun) {
        logger.info('- dry run: Anki package creation skipped')
        logger.info(`- would read markdown from ${inputPath}`)
        logger.info(`- would build Anki package at ${outputPath}`)
        if (usedDefaultOutputPath) {
          logger.info('Output path defaulted to current working directory.')
        }
        logger.info(`Deck title: ${deckTitle}`)
        return
      }

      await runWithSpinner(spinner, 'Building Anki deck...', async () => {
        await fs.mkdir(dirname(outputPath), { recursive: true })
        const deckConversionOptions: ConvertMarkdownToAnkiDeckOptions = {
          target: outputPath,
          deckName: deckTitle,
        }
        await convertMarkdownToAnkiDeck(inputPath, deckConversionOptions)
      })

      logger.success(
        `Generated Anki deck from markdown ${inputPath} -> ${outputPath}`,
      )
      if (usedDefaultOutputPath) {
        logger.info('Output path defaulted to current working directory.')
      }
      logger.info(`Deck title: ${deckTitle}`)
      return
    }

    const structured = await loadStructuredSource({
      sourceKind,
      inputPath,
      ui,
      settings,
      indexPath,
      indexRanges,
      startChapter,
      endChapter,
      minChars,
      debug,
      fullFidelity: targetKind === 'json' && fullFidelity,
    })

    if (targetKind === 'json') {
      if (structured.fileType === 'pdf') {
        logPdfExtractionSummary({
          logger,
          sourcePath: inputPath,
          book: structured.data,
          indexProvided: Boolean(indexPath || indexRanges),
        })
      }

      const payload = JSON.stringify(
        fullFidelity
          ? structured.data
          : buildBasicExtractPayload(structured.data),
        null,
        2,
      )

      if (dryRun) {
        logger.info('- dry run: extracted JSON not written to disk')
        logger.info(`- would write JSON to ${outputPath}`)
        if (usedDefaultOutputPath) {
          logger.info('Output path defaulted to current working directory.')
        }
        return
      }

      await runWithSpinner(spinner, 'Writing extracted JSON...', async () => {
        await fs.mkdir(dirname(outputPath), { recursive: true })
        await fs.writeFile(outputPath, payload, 'utf8')
      })

      logger.success(`Saved extracted JSON to ${outputPath}`)
      if (usedDefaultOutputPath) {
        logger.info('Output path defaulted to current working directory.')
      }
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

    const hint = PROVIDER_MODEL_HINTS[provider]
    if (model && hint && !hint.test(model)) {
      logger.warn(`Model "${model}" may not belong to provider "${provider}".`)
    }

    logger.debug(`Provider: ${provider}`)
    logger.debug(`Model: ${model}`)

    const prompt = await runWithSpinner(
      spinner,
      'Loading prompt...',
      async () => loadPrompt(args.prompt as string | undefined),
    )

    const deckTitle =
      deckTitleArg && deckTitleArg.length > 0
        ? deckTitleArg
        : parse(inputPath).name || outputBaseName

    const sections = structured.data.content ?? []
    if (sections.length === 0) {
      throw new Error('No content sections found to generate flashcards.')
    }

    logger.info(
      `Generating flashcards in ${sections.length} section(s) (sequential).`,
    )

    const generationStart = Date.now()
    const totalSections = sections.length
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
                    apiKey: apiKeyLookup.apiKey!,
                    prompt: prompt.contents,
                    content: sectionText,
                  }),
              })
            : await generateFlashcards({
                provider,
                model,
                apiKey: apiKeyLookup.apiKey!,
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
          const artifactDir = dirname(outputPath)
          const partialPath = join(
            artifactDir,
            `${artifactBaseName}-partial.md`,
          )
          const failedSectionPath = join(
            artifactDir,
            `${artifactBaseName}-failed-section-${position + 1}.md`,
          )
          const partialBody =
            aggregatedCards.length > 0 ? renderFlashcards(aggregatedCards) : ''
          const partialPayload = buildDeckMarkdown(deckTitle, partialBody)
          await fs.mkdir(artifactDir, { recursive: true })
          await fs.writeFile(partialPath, partialPayload, 'utf8')

          const failedPayload =
            rawResponse && rawResponse.trim().length > 0
              ? rawResponse
              : 'No model response captured for this section.'
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
      if (targetKind === 'md') {
        logger.info('- dry run: markdown deck not written to disk')
        logger.info(`- would write markdown to ${outputPath}`)
      } else {
        logger.info('- dry run: Anki package creation skipped')
        logger.info(`- would build Anki package at ${outputPath}`)
      }
      if (usedDefaultOutputPath) {
        logger.info('Output path defaulted to current working directory.')
      }
      logger.info(`Using prompt "${prompt.name}" from ${prompt.path}`)
      return
    }

    await fs.mkdir(dirname(outputPath), { recursive: true })

    if (targetKind === 'md') {
      await runWithSpinner(spinner, 'Writing markdown deck...', async () => {
        await fs.writeFile(outputPath, markdownPayload, 'utf8')
      })

      logger.success(
        `Generated markdown flashcards from ${inputPath} (${structured.fileType.toUpperCase()}) -> ${outputPath}`,
      )
    } else {
      await runWithSpinner(spinner, 'Building Anki package...', async () => {
        await buildAnkiPackageFromMarkdownPayload({
          markdownPayload,
          outputPath,
          deckTitle,
        })
      })

      logger.success(
        `Generated Anki deck from ${inputPath} (${structured.fileType.toUpperCase()}) -> ${outputPath}`,
      )
    }

    if (usedDefaultOutputPath) {
      logger.info('Output path defaulted to current working directory.')
    }
    logger.info(`Using prompt "${prompt.name}" from ${prompt.path}`)
  } catch (error) {
    ui?.spinner.stop()
    if (progressStarted) {
      ui?.progress.clear()
    }
    ;(ui?.logger ?? createLogger({ level: 'info', useColor: false })).error(
      `Conversion failed: ${(error as Error).message}`,
    )
    process.exitCode = 1
  }
}

const rawArgs = hideBin(process.argv)

const cli = yargs(rawArgs)
  .scriptName('pdfanki')
  .usage('Usage:\n  $0 <command> <subcommand> [flags]')
  .updateStrings({ 'Commands:': 'Core commands:' })
  .command(
    'pdf',
    'Convert from PDF inputs.',
    y =>
      withSubcommandHelp(y)
        .command(
          'json <input>',
          'Extract structured JSON from a PDF.',
          commandY =>
            withUiOptions(
              withDryRunOption(
                withOutputOption(
                  withPdfSourceOptions(
                    withDebugOption(
                      withInputPositional(commandY, 'Path to the source PDF.'),
                    ),
                  ),
                  'Output path for extracted JSON. Defaults to ./<input>.json.',
                ),
              ).option('full-fidelity', {
                type: 'boolean',
                default: false,
                describe:
                  'Write full-fidelity extraction JSON instead of the minimal section-only shape.',
              }),
            ),
          async args => runWorkflowCommand('pdf', 'json', args),
        )
        .command(
          'md <input>',
          'Generate markdown flashcards directly from a PDF.',
          commandY =>
            withUiOptions(
              withDryRunOption(
                withDeckTitleOption(
                  withGenerationOptions(
                    withOutputOption(
                      withPdfSourceOptions(
                        withDebugOption(
                          withInputPositional(
                            commandY,
                            'Path to the source PDF.',
                          ),
                        ),
                      ),
                      'Output path for markdown flashcards. Defaults to ./<input>.md.',
                    ),
                  ),
                ),
              ),
            ),
          async args => runWorkflowCommand('pdf', 'md', args),
        )
        .command(
          'anki <input>',
          'Generate an Anki package directly from a PDF.',
          commandY =>
            withUiOptions(
              withDryRunOption(
                withDeckTitleOption(
                  withGenerationOptions(
                    withOutputOption(
                      withPdfSourceOptions(
                        withDebugOption(
                          withInputPositional(
                            commandY,
                            'Path to the source PDF.',
                          ),
                        ),
                      ),
                      'Output path for the Anki package. Defaults to ./<input>.apkg.',
                    ),
                  ),
                ),
              ),
            ),
          async args => runWorkflowCommand('pdf', 'anki', args),
        )
        .demandCommand(1, 'Choose a pdf subcommand.'),
    async () => {},
  )
  .command(
    'epub',
    'Convert from EPUB inputs.',
    y =>
      withSubcommandHelp(y)
        .command(
          'json <input>',
          'Extract structured JSON from an EPUB.',
          commandY =>
            withUiOptions(
              withDryRunOption(
                withOutputOption(
                  withEpubSourceOptions(
                    withDebugOption(
                      withInputPositional(commandY, 'Path to the source EPUB.'),
                    ),
                  ),
                  'Output path for extracted JSON. Defaults to ./<input>.json.',
                ),
              ).option('full-fidelity', {
                type: 'boolean',
                default: false,
                describe:
                  'Write full-fidelity JSON and disable configured EPUB title filtering.',
              }),
            ),
          async args => runWorkflowCommand('epub', 'json', args),
        )
        .command(
          'md <input>',
          'Generate markdown flashcards directly from an EPUB.',
          commandY =>
            withUiOptions(
              withDryRunOption(
                withDeckTitleOption(
                  withGenerationOptions(
                    withOutputOption(
                      withEpubSourceOptions(
                        withDebugOption(
                          withInputPositional(
                            commandY,
                            'Path to the source EPUB.',
                          ),
                        ),
                      ),
                      'Output path for markdown flashcards. Defaults to ./<input>.md.',
                    ),
                  ),
                ),
              ),
            ),
          async args => runWorkflowCommand('epub', 'md', args),
        )
        .command(
          'anki <input>',
          'Generate an Anki package directly from an EPUB.',
          commandY =>
            withUiOptions(
              withDryRunOption(
                withDeckTitleOption(
                  withGenerationOptions(
                    withOutputOption(
                      withEpubSourceOptions(
                        withDebugOption(
                          withInputPositional(
                            commandY,
                            'Path to the source EPUB.',
                          ),
                        ),
                      ),
                      'Output path for the Anki package. Defaults to ./<input>.apkg.',
                    ),
                  ),
                ),
              ),
            ),
          async args => runWorkflowCommand('epub', 'anki', args),
        )
        .demandCommand(1, 'Choose an epub subcommand.'),
    async () => {},
  )
  .command(
    'json',
    'Convert from extracted JSON inputs.',
    y =>
      withSubcommandHelp(y)
        .command(
          'md <input>',
          'Generate markdown flashcards from extracted JSON.',
          commandY =>
            withUiOptions(
              withDryRunOption(
                withDeckTitleOption(
                  withGenerationOptions(
                    withOutputOption(
                      withInputPositional(
                        commandY,
                        'Path to the extracted JSON file.',
                      ),
                      'Output path for markdown flashcards. Defaults to ./<input>.md.',
                    ),
                  ),
                ),
              ),
            ),
          async args => runWorkflowCommand('json', 'md', args),
        )
        .command(
          'anki <input>',
          'Generate an Anki package from extracted JSON.',
          commandY =>
            withUiOptions(
              withDryRunOption(
                withDeckTitleOption(
                  withGenerationOptions(
                    withOutputOption(
                      withInputPositional(
                        commandY,
                        'Path to the extracted JSON file.',
                      ),
                      'Output path for the Anki package. Defaults to ./<input>.apkg.',
                    ),
                  ),
                ),
              ),
            ),
          async args => runWorkflowCommand('json', 'anki', args),
        )
        .demandCommand(1, 'Choose a json subcommand.'),
    async () => {},
  )
  .command(
    'md',
    'Convert from markdown flashcard inputs.',
    y =>
      withSubcommandHelp(y)
        .command(
          'anki <input>',
          'Build an Anki package from markdown flashcards.',
          commandY =>
            withUiOptions(
              withDryRunOption(
                withDeckTitleOption(
                  withOutputOption(
                    withInputPositional(
                      commandY,
                      'Path to the markdown flashcard file.',
                    ),
                    'Output path for the Anki package. Defaults to ./<input>.apkg.',
                  ),
                ),
              ),
            ),
          async args => runWorkflowCommand('md', 'anki', args),
        )
        .demandCommand(1, 'Choose an md subcommand.'),
    async () => {},
  )
  .command(
    'config',
    'Manage pdfanki configuration.',
    y =>
      withSubcommandHelp(withUiOptions(y))
        .command(
          'reset',
          'Remove and recreate the pdfanki config directory with defaults.',
          commandY => withUiOptions(commandY),
          async args => handleResetConfig(args),
        )
        .middleware(argv => {
          if (argv._.length > 1 && argv._[1] !== 'reset') {
            throw new Error(
              `Unknown config subcommand "${String(argv._[1])}". Try "pdfanki config --help".`,
            )
          }
        }),
    async args => handlePrintConfig(args),
  )
  .command(
    'prompts',
    'Manage local and remote prompts.',
    y =>
      withSubcommandHelp(y)
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
    'index',
    'Work with PDF index templates and helpers.',
    y =>
      withSubcommandHelp(y)
        .command(
          'template <count> [out]',
          'Generate a blank JSON index template.',
          commandY =>
            withUiOptions(
              commandY
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
          async args => handleIndexTemplate(args),
        )
        .demandCommand(1, 'Choose an index subcommand.'),
    async () => {},
  )
  .command(
    'reset-config',
    false,
    y => withUiOptions(y),
    async args => handleResetConfig(args),
  )
  .command(
    'list-prompts',
    false,
    y => withUiOptions(y),
    async args => handleListLocalPrompts(args),
  )
  .command(
    'index-template <count> [out]',
    false,
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
    async args => handleIndexTemplate(args),
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
