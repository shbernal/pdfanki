#!/usr/bin/env node
import { promises as fs } from 'fs'
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
  bookJsonToPlainText,
  type ConvertFileOptions,
  type SupportedProvider as ServerSupportedProvider,
} from '@shbernal/pdfanki/server'
import { validateJsonStructure } from '@shbernal/pdfanki/client'
import {
  ensureConfig,
  loadPrompt,
  loadSettings,
  resetConfig,
  type SupportedProvider,
} from './config.js'
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

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'

type GenerateFlashcardsRequest = {
  provider: SupportedProvider
  model: string
  apiKey: string
  prompt: string
  content: string
}

type DeepSeekChatCompletion = {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string
            text?: string
          }>
    }
  }>
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function extractDeepSeekText(payload: DeepSeekChatCompletion): string | null {
  const content = payload.choices?.[0]?.message?.content
  if (typeof content === 'string' && content.trim().length > 0) {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return null
  }

  const text = content
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n')

  return text.length > 0 ? text : null
}

async function callDeepSeek(
  options: GenerateFlashcardsRequest,
): Promise<string> {
  const { prompt, content, apiKey, model } = options
  const baseUrl = normalizeBaseUrl(
    process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL,
  )
  const endpoint = `${baseUrl}/chat/completions`

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content },
      ],
      temperature: 0.3,
    }),
  })

  if (!response.ok) {
    const details = (await response.text()).trim()
    const detailSuffix = details ? ` ${details.slice(0, 500)}` : ''
    throw new Error(
      `DeepSeek request failed (${response.status} ${response.statusText}).${detailSuffix}`,
    )
  }

  const payload = (await response.json()) as DeepSeekChatCompletion
  const text = extractDeepSeekText(payload)
  if (!text) {
    throw new Error('DeepSeek returned no text content.')
  }

  return text
}

async function generateFlashcards(
  options: GenerateFlashcardsRequest,
): Promise<string> {
  if (options.provider === 'deepseek') {
    return callDeepSeek(options)
  }

  return generateFlashcardsFromServer({
    ...options,
    provider: options.provider as ServerSupportedProvider,
  })
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
          .option('min-char', {
            type: 'number',
            describe:
              'Filter out sections with fewer than this many characters.',
          })
          .option('provider', {
            type: 'string',
            choices: ['gemini', 'anthropic', 'openai', 'deepseek'],
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
            minChars,
            epubFilters: extractVerbose ? { titles: [] } : settings.epubFilters,
            debug: toBool(args.debug, false),
          }

          result = await convertFileFromPath(options)
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

          await runWithSpinner(
            spinner,
            'Writing extracted JSON...',
            async () => {
              await fs.mkdir(dirname(toJsonPath), { recursive: true })
              await fs.writeFile(toJsonPath, checkpointPayload)
            },
          )

          const checkpointSavedMessage = usedDefaultCheckpointOutput
            ? `Extracted content saved -> ${toJsonPath} | Output path defaulted to cwd: ${process.cwd()}`
            : `Extracted content saved -> ${toJsonPath}`
          logger.success(checkpointSavedMessage)
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

        await fs.mkdir(dirname(markdownPath), { recursive: true })
        if (ankiOutputPath && !markdownOnly) {
          await fs.mkdir(dirname(ankiOutputPath), { recursive: true })
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

        await runWithSpinner(spinner, 'Writing markdown deck...', async () => {
          const markdownPayload = buildDeckMarkdown(deckTitle, flashcards)
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
