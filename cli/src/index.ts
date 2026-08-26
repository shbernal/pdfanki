#!/usr/bin/env node
import { promises as fs } from 'fs'
import { dirname, join, parse } from 'path'
import {
  localMedia,
  parseMarkdown,
  renderMarkdown,
  writeApkg,
  type Card,
  type Deck,
} from '@ankimd/core'
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
  CODEX_REASONING_EFFORTS,
  ensureConfig,
  loadPrompt,
  loadSettings,
  normalizeCodexProfile,
  normalizeCodexReasoningEffort,
  resetConfig,
  type CodexReasoningEffort,
  type SupportedProvider,
} from './config.js'
import {
  installRemotePrompt,
  listLocalPrompts,
  listRemotePrompts,
} from './prompts.js'
import { providerRequiresApiKey, readProviderApiKey } from './env.js'
import { parseSectionCards } from './flashcardPolicy.js'
import { createLogger, type Logger, type LogLevel } from './ui/logger.js'
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

interface IndexTemplateEntry {
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

/**
 * The deck the generated cards belong to.
 *
 * The `# ` title is written here rather than by the model, which is why the model's
 * output is validated as a card region and a `#` in it is an error.
 */
function buildDeck(deckTitle: string, cards: readonly Card[]): Deck {
  return {
    title: deckTitle.trim() || 'Deck',
    titleSource: 'heading',
    frontmatter: {},
    fileTags: [],
    preamble: null,
    cards,
  }
}

function normalizePathArg(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizePreviewCliArgs(args: string[]): string[] {
  const normalizedArgs: string[] = []

  for (let index = 0; index < args.length; index++) {
    const current = args[index]
    if (current === '--preview') {
      const next = args[index + 1]
      if (typeof next === 'string' && /^\d+$/.test(next)) {
        normalizedArgs.push('--preview', '--preview-chars', next)
        index++
        continue
      }
    }

    if (current.startsWith('--preview=')) {
      const previewValue = current.slice('--preview='.length).trim()
      if (/^\d+$/.test(previewValue)) {
        normalizedArgs.push('--preview', '--preview-chars', previewValue)
        continue
      }
    }

    normalizedArgs.push(current)
  }

  return normalizedArgs
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
  defaultDir?: string,
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

  const outputDir =
    defaultDir && defaultDir !== '.' ? defaultDir : process.cwd()
  return join(outputDir, `${fallbackBaseName}${extension}`)
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
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  gray: '\u001b[90m',
  lightGray: '\u001b[37m',
  reset: '\u001b[0m',
} as const

const ANSI_UNDERLINE = '\u001b[4m'

function colorizeText(
  text: string,
  color: keyof typeof JSON_COLOR_ANSI,
  enabled: boolean,
): string {
  if (!enabled || color === 'reset') return text
  return `${JSON_COLOR_ANSI[color]}${text}${JSON_COLOR_ANSI.reset}`
}

function formatSectionHeading(text: string, enabled: boolean): string {
  if (!enabled) return text
  return `${ANSI_UNDERLINE}${JSON_COLOR_ANSI.blue}${text}${JSON_COLOR_ANSI.reset}`
}

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

function formatCheckStatus(ok: boolean, useColor: boolean): string {
  return colorizeText(ok ? 'OK' : 'Failed', ok ? 'green' : 'red', useColor)
}

function parsePageRange(
  pageRange?: string,
): { start: number; end: number } | null {
  if (!pageRange) return null
  const match = /^(\d+)-(\d+)$/.exec(pageRange)
  if (!match) return null
  return {
    start: Number(match[1]),
    end: Number(match[2]),
  }
}

function formatOverlapRange(start: number, end: number): string {
  return start === end ? `page ${start}` : `pages ${start}-${end}`
}

function findPageOverlaps(sections: ContentSection[]): {
  leftTitle: string
  leftRange: string
  rightTitle: string
  rightRange: string
  overlapStart: number
  overlapEnd: number
}[] {
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
    .filter(Boolean) as {
    title: string
    range: string
    start: number
    end: number
  }[]

  const overlaps: {
    leftTitle: string
    leftRange: string
    rightTitle: string
    rightRange: string
    overlapStart: number
    overlapEnd: number
  }[] = []

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

interface UiBuildArgs {
  verbose?: unknown
  quiet?: unknown
  color?: unknown
  spinner?: unknown
}

interface CliUi {
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

interface GenerateFlashcardsRequest {
  provider: SupportedProvider
  model: string
  apiKey?: string
  prompt: string
  content: string
  codex?: {
    reasoningEffort?: CodexReasoningEffort
    profile?: string
  }
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
    name?: string
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
type OutputArtifactKind = 'json' | 'md' | 'apkg'
type StructuredSourceKind = Exclude<WorkflowSourceKind, 'md'>

type WorkflowCommandArgs = UiBuildArgs & {
  input?: unknown
  out?: unknown
  fullFidelity?: unknown
  index?: unknown
  indexRanges?: unknown
  startSection?: unknown
  endSection?: unknown
  excludeSections?: unknown
  minChar?: unknown
  preview?: unknown
  previewChars?: unknown
  provider?: unknown
  prompt?: unknown
  model?: unknown
  codexReasoningEffort?: unknown
  codexProfile?: unknown
  deckTitle?: unknown
  debug?: unknown
  dryRun?: unknown
}

interface StructuredSourceResult {
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
  codex: /^(?:gpt|o\d|codex)/i,
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

// Handler for group commands that only register subcommands. yargs requires a
// handler in this positional form, but `.demandCommand()` in the builder
// rejects before it can run.
const requireSubcommand = async (): Promise<void> => {
  // intentionally empty
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
    .option('start-section', {
      type: 'number',
      describe: 'First EPUB section to extract (1-based, inclusive).',
    })
    .option('end-section', {
      type: 'number',
      describe: 'Last EPUB section to extract (1-based, inclusive).',
    })
    .option('exclude-sections', {
      type: 'string',
      describe:
        'Skip specific EPUB sections using comma-separated section numbers or ranges, e.g. "3,7,19,25-27".',
    })
    .option('min-char', {
      type: 'number',
      describe: 'Filter out sections with fewer than this many characters.',
    })
    .option('preview', {
      type: 'boolean',
      default: false,
      describe:
        'Show a text preview under each EPUB section while parsing. You can also pass --preview <chars>.',
    })
    .option('preview-chars', {
      type: 'number',
      describe:
        'Number of characters to print in EPUB section previews. Implies --preview when provided.',
    })
}

function getPreviewFlagMode(args: string[]): 'enabled' | 'disabled' | 'unset' {
  for (const arg of args) {
    if (arg === '--no-preview' || arg === '--preview=false') {
      return 'disabled'
    }

    if (arg === '--preview' || arg.startsWith('--preview=')) {
      return 'enabled'
    }
  }

  return 'unset'
}

function withGenerationOptions<T>(y: Argv<T>): Argv<T> {
  return y
    .option('provider', {
      type: 'string',
      choices: [
        'gemini',
        'anthropic',
        'openai',
        'deepseek',
        'openrouter',
        'codex',
      ],
      describe:
        'AI provider. API providers expect PROVIDER_API_KEY; experimental codex uses the local Codex CLI login. Defaults to settings.json.',
    })
    .option('prompt', {
      alias: 'p',
      type: 'string',
      describe:
        'Prompt to load, e.g. "default" -> prompts/default.md. Defaults to settings.json.',
    })
    .option('model', {
      alias: 'm',
      type: 'string',
      describe: 'Model name for the chosen provider.',
    })
    .option('codex-reasoning-effort', {
      type: 'string',
      choices: [...CODEX_REASONING_EFFORTS],
      describe:
        'Codex-only model_reasoning_effort override. Overrides Codex config.toml for this run.',
    })
    .option('codex-profile', {
      type: 'string',
      describe:
        'Codex-only config profile passed to codex exec --profile. The pdfanki --model/defaultModel still takes precedence for model selection.',
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
  excludeChapters?: string
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
    excludeChapters,
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
    excludeChapters,
    minChars,
    preview: settings.epub.preview,
    previewChars: settings.epub.previewChars,
    epubFilters: fullFidelity ? { titles: [] } : settings.epub.filters,
    debug,
  }

  return convertFileFromPath(convertOptions)
}

/**
 * Writes the package, reporting whatever the conversion had to say.
 *
 * §3.3 of the format: a deck that lost something on the way out says so. A silent
 * success over skipped cards is a conformance bug rather than a tidy UI.
 */
async function buildAnkiPackage(options: {
  deck: Deck
  outputPath: string
  deckTitle: string
  logger: Logger
  mediaDir?: string
}): Promise<void> {
  const { deck, outputPath, deckTitle, logger, mediaDir } = options
  const diagnostics = await writeApkg(deck, outputPath, {
    deckName: deckTitle,
    ...(mediaDir ? { resolveMedia: localMedia(mediaDir) } : {}),
  })

  for (const item of diagnostics) {
    logger.warn(`${item.code}: ${item.message}`)
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
    const outputArtifactKind = outputExtension.slice(1) as OutputArtifactKind
    const defaultOutputDir = normalizePathArg(
      settings.output.paths[outputArtifactKind] ?? settings.output.path,
    )
    const explicitOutputPath = normalizePathArg(args.out)
    const outputPath = resolveOutputPath(
      explicitOutputPath,
      outputBaseName,
      outputExtension,
      defaultOutputDir,
    )
    const usedDefaultOutputPath = !explicitOutputPath
    const deckTitleArg = normalizePathArg(args.deckTitle)
    const dryRun = toBool(args.dryRun, false)
    const debug = toBool(args.debug, false)
    const fullFidelity = toBool(args.fullFidelity, false)
    const artifactBaseName = parse(outputPath).name || outputBaseName

    const indexPath = normalizePathArg(args.index)
    const indexRanges = normalizePathArg(args.indexRanges)
    const excludeChapters = normalizePathArg(args.excludeSections)
    if (
      flagProvided(args.indexRanges) &&
      typeof args.indexRanges === 'string' &&
      !indexRanges
    ) {
      throw new Error('--index-ranges must not be empty.')
    }
    if (
      flagProvided(args.excludeSections) &&
      typeof args.excludeSections === 'string' &&
      !excludeChapters
    ) {
      throw new Error('--exclude-sections must not be empty.')
    }
    if (indexPath && indexRanges) {
      throw new Error(
        'Use --index <path> or --index-ranges "<start-end,...>", not both.',
      )
    }

    const minChars = normalizeIntegerOption(args.minChar, '--min-char', 0)
    const previewChars = normalizeIntegerOption(
      args.previewChars,
      '--preview-chars',
      1,
    )
    const previewFlagMode = getPreviewFlagMode(rawArgs)
    const startChapter = normalizeIntegerOption(
      args.startSection,
      '--start-section',
      1,
    )
    const endChapter = normalizeIntegerOption(
      args.endSection,
      '--end-section',
      1,
    )

    if (
      typeof startChapter === 'number' &&
      typeof endChapter === 'number' &&
      startChapter > endChapter
    ) {
      throw new Error(
        '--start-section must be less than or equal to --end-section.',
      )
    }

    if (sourceKind === 'md') {
      const markdownSource = await runWithSpinner(
        spinner,
        'Reading markdown deck...',
        async () => fs.readFile(inputPath, 'utf8'),
      )

      /* The consumer half of the format, not the producer half: this is the user's
         own deck rather than something pdfanki just generated, so anything unreadable
         is reported and the rest of the file still converts (§3.1). */
      const { deck, diagnostics } = parseMarkdown(markdownSource)
      const deckTitle =
        deckTitleArg && deckTitleArg.length > 0
          ? deckTitleArg
          : deck.title?.trim() || parse(inputPath).name

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

      for (const item of diagnostics) {
        logger.warn(`${item.code}: ${item.message}`)
      }

      await runWithSpinner(spinner, 'Building Anki deck...', async () => {
        await buildAnkiPackage({
          deck,
          outputPath,
          deckTitle,
          logger,
          /* Images are resolved beside the deck that names them, which is where a
             relative reference in someone's vault points. Remote ones are left as
             written: downloading needs a timeout and a policy on whether to touch the
             network at all, and `ankimd build` is the command that has both. */
          mediaDir: dirname(inputPath),
        })
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
      settings: {
        ...settings,
        epub: {
          ...settings.epub,
          preview:
            previewFlagMode === 'enabled'
              ? true
              : previewFlagMode === 'disabled'
                ? false
                : typeof previewChars === 'number'
                  ? true
                  : settings.epub.preview,
          previewChars: previewChars ?? settings.epub.previewChars ?? 120,
        },
      },
      indexPath,
      indexRanges,
      startChapter,
      endChapter,
      excludeChapters,
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
      settings.generation.defaultProvider
    const providerSettings = settings.generation.providers[provider]
    const defaultModel =
      providerSettings?.defaultModel ??
      settings.generation.providers[settings.generation.defaultProvider]
        ?.defaultModel
    const model = (args.model as string | undefined) ?? defaultModel
    const requiresApiKey = providerRequiresApiKey(provider)
    const apiKeyLookup = requiresApiKey ? readProviderApiKey(provider) : null
    const hasCodexReasoningEffortFlag =
      typeof args.codexReasoningEffort !== 'undefined'
    const hasCodexProfileFlag = typeof args.codexProfile !== 'undefined'

    if (
      provider !== 'codex' &&
      (hasCodexReasoningEffortFlag || hasCodexProfileFlag)
    ) {
      throw new Error(
        '--codex-reasoning-effort and --codex-profile can only be used with provider "codex".',
      )
    }

    const codexReasoningEffort =
      provider === 'codex'
        ? normalizeCodexReasoningEffort(
            hasCodexReasoningEffortFlag
              ? args.codexReasoningEffort
              : providerSettings?.reasoningEffort,
            hasCodexReasoningEffortFlag
              ? '--codex-reasoning-effort'
              : 'settings.generation.providers.codex.reasoningEffort',
          )
        : undefined
    const codexProfile =
      provider === 'codex'
        ? normalizeCodexProfile(
            hasCodexProfileFlag ? args.codexProfile : providerSettings?.profile,
            hasCodexProfileFlag
              ? '--codex-profile'
              : 'settings.generation.providers.codex.profile',
          )
        : undefined
    const codexOptions =
      provider === 'codex'
        ? {
            reasoningEffort: codexReasoningEffort,
            profile: codexProfile,
          }
        : undefined

    if (!model) {
      throw new Error(
        'Model is required when invoking a provider. Set it via --model or settings.json.',
      )
    }

    const hint = PROVIDER_MODEL_HINTS[provider]
    if (model && hint && !hint.test(model)) {
      logger.warn(`Model "${model}" may not belong to provider "${provider}".`)
    }

    logger.debug(`Provider: ${provider}`)
    logger.debug(`Model: ${model}`)
    if (provider === 'codex') {
      logger.debug(
        `Codex reasoning effort: ${codexOptions?.reasoningEffort ?? 'inherited from Codex config'}`,
      )
      logger.debug(
        `Codex profile: ${codexOptions?.profile ?? 'inherited from Codex config'}`,
      )
    }

    const prompt = await runWithSpinner(
      spinner,
      'Loading prompt...',
      async () =>
        loadPrompt(
          (args.prompt as string | undefined) ??
            settings.generation.defaultPrompt,
        ),
    )

    const deckTitle =
      deckTitleArg && deckTitleArg.length > 0
        ? deckTitleArg
        : parse(inputPath).name || outputBaseName

    const sections = structured.data.content ?? []
    if (sections.length === 0) {
      throw new Error('No content sections found to generate flashcards.')
    }

    if (targetKind === 'md' && dryRun) {
      const apiCheckOk = !requiresApiKey || Boolean(apiKeyLookup?.apiKey)
      const apiCheckDetail = requiresApiKey
        ? apiCheckOk
          ? apiKeyLookup!.envVar
          : `missing env var ${apiKeyLookup!.envVar}`
        : 'uses local Codex CLI auth; no PROVIDER_API_KEY required'
      console.log('')
      process.stdout.write(
        `${formatSectionHeading('Dry Run Summary', ui.useColor)}\n`,
      )
      logger.info(`AI provider: ${colorizeText(provider, 'blue', ui.useColor)}`)
      logger.info(`Model: ${colorizeText(model, 'blue', ui.useColor)}`)
      if (provider === 'codex') {
        logger.info(
          `Codex reasoning effort: ${colorizeText(codexOptions?.reasoningEffort ?? 'inherited', 'blue', ui.useColor)}`,
        )
        logger.info(
          `Codex profile: ${colorizeText(codexOptions?.profile ?? 'inherited', 'blue', ui.useColor)}`,
        )
      }
      logger.info(
        `API check: ${formatCheckStatus(apiCheckOk, ui.useColor)} ${colorizeText(`(${apiCheckDetail})`, 'lightGray', ui.useColor)}`,
      )
      logger.info(
        `Prompt: ${colorizeText(prompt.name, 'blue', ui.useColor)} ${colorizeText(`(${prompt.path})`, 'lightGray', ui.useColor)}`,
      )
      logger.info(
        `Sections: ${colorizeText(formatCount(sections.length), 'blue', ui.useColor)}`,
      )
      logger.info(
        usedDefaultOutputPath
          ? `Output path: ${colorizeText(
              defaultOutputDir && defaultOutputDir !== '.'
                ? defaultOutputDir
                : 'cwd',
              'blue',
              ui.useColor,
            )} ${colorizeText(`(${outputPath})`, 'lightGray', ui.useColor)}`
          : `Output path: ${colorizeText(outputPath, 'blue', ui.useColor)}`,
      )
      return
    }

    if (requiresApiKey && !apiKeyLookup?.apiKey) {
      throw new Error(
        `Missing API key for provider "${provider}". Set ${apiKeyLookup!.envVar} in your environment.`,
      )
    }

    logger.info(
      `Generating flashcards in ${sections.length} section${sections.length === 1 ? '' : 's'}.`,
    )

    const generationStart = Date.now()
    const totalSections = sections.length
    const aggregatedCards: Card[] = []
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
        let parsedCards: Card[] | null = null

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
                    apiKey: apiKeyLookup?.apiKey,
                    prompt: prompt.contents,
                    content: sectionText,
                    codex: codexOptions,
                  }),
              })
            : await generateFlashcards({
                provider,
                model,
                apiKey: apiKeyLookup?.apiKey,
                prompt: prompt.contents,
                content: sectionText,
                codex: codexOptions,
              })

          rawResponse = response

          try {
            parsedCards = parseSectionCards(response)
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
          const partialPayload = renderMarkdown(
            buildDeck(deckTitle, aggregatedCards),
          )
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

    const deck = buildDeck(deckTitle, aggregatedCards)
    const markdownPayload = renderMarkdown(deck)

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
        await buildAnkiPackage({ deck, outputPath, deckTitle, logger })
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

const rawArgs = normalizePreviewCliArgs(hideBin(process.argv))

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
    requireSubcommand,
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
    requireSubcommand,
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
    requireSubcommand,
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
    requireSubcommand,
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
    requireSubcommand,
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
    requireSubcommand,
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
