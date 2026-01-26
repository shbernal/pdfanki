#!/usr/bin/env node
import { promises as fs } from 'fs'
import { dirname, join, parse } from 'path'
import {
  convertMarkdownToAnkiDeck,
  type ConvertMarkdownToAnkiDeckOptions,
} from '@shbernal/mdanki'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import {
  convertFileFromPath,
  generateFlashcards,
  bookJsonToPlainText,
  type ConvertFileOptions,
  type SupportedProvider,
} from '@shbernal/pdfanki/server'
import { validateJsonStructure } from '@shbernal/pdfanki/client'
import { ensureConfig, loadPrompt, loadSettings } from './config.js'
import { readProviderApiKey } from './env.js'
import {
  parseFlashcardMarkdown,
  renderFlashcards,
  type Flashcard,
} from './flashcardValidation.js'

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

const rawArgs = hideBin(process.argv)

const cli = yargs(rawArgs)
  .scriptName('pdfanki')
  .usage('$0 [options]')
  .command(
    '$0',
    'Convert a PDF or EPUB to flashcards',
    y =>
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
        .option('index-create-template', {
          type: 'string',
          describe:
            'Write a template PDF chapter index JSON and exit. Path optional (dir or .json); defaults to ./index.json. Requires --index-count.',
        })
        .option('index-count', {
          type: 'number',
          describe:
            'Number of sections for --index-create-template (must be a positive integer).',
        })
        .option('provider', {
          type: 'string',
          choices: ['gemini', 'anthropic', 'openai'],
          describe:
            'AI provider (expects API key in PROVIDER_API_KEY env var). Defaults to settings.json.',
        })
        .option('prompt', {
          alias: 'p',
          type: 'string',
          describe: 'Prompt to load, e.g. "default" → prompts/default.md.',
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
    async args => {
      try {
        await ensureConfig()
        const settings = await loadSettings()
        const fromJsonPath = args.fromJson as string | undefined
        const fromMarkdownPath = args.fromMd as string | undefined
        const fromFilePath = args.fromFile as string | undefined
        const indexTemplatePathRaw = args.indexCreateTemplate as
          | string
          | undefined
        const indexTemplateCount = args.indexCount as number | undefined

        if (
          indexTemplatePathRaw !== undefined ||
          indexTemplateCount !== undefined
        ) {
          const count = indexTemplateCount
          if (
            typeof count !== 'number' ||
            !Number.isInteger(count) ||
            count <= 0
          ) {
            throw new Error(
              'Provide a positive integer via --index-count when using --index-create-template.',
            )
          }

          const resolvedIndexPath = (() => {
            const normalizedPath = normalizePathArg(indexTemplatePathRaw)
            if (!normalizedPath) {
              return join(process.cwd(), 'index.json')
            }
            const parsed = parse(normalizedPath)
            if (!parsed.ext) {
              return join(normalizedPath, 'index.json')
            }
            if (parsed.ext.toLowerCase() !== '.json') {
              throw new Error(
                '--index-create-template path must be a directory or end with .json',
              )
            }
            return normalizedPath
          })()

          const payload = JSON.stringify(buildIndexTemplate(count), null, 2)
          await fs.mkdir(dirname(resolvedIndexPath), { recursive: true })
          await fs.writeFile(resolvedIndexPath, payload, 'utf8')

          console.log(
            `✅ Created index template with ${count} section(s) at ${resolvedIndexPath}`,
          )
          console.log(
            'ℹ️ Use --index <path> with PDFs to apply this chapter map.',
          )
          return
        }

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
          const markdownSource = await fs.readFile(fromMarkdownPath, 'utf8')
          const headingMatch = markdownSource.match(/^#\s+(.+)\s*$/m)
          const deckTitle =
            deckTitleArg && deckTitleArg.length > 0
              ? deckTitleArg
              : headingMatch?.[1]?.trim() || parse(fromMarkdownPath).name
          const finalOutputPath =
            ankiOutputPath ??
            resolveOutputPath(undefined, outputBaseName, '.apkg')

          await fs.mkdir(dirname(finalOutputPath), { recursive: true })

          const deckConversionOptions: ConvertMarkdownToAnkiDeckOptions = {
            target: finalOutputPath,
            deckName: deckTitle,
          }

          await convertMarkdownToAnkiDeck(
            fromMarkdownPath,
            deckConversionOptions,
          )

          console.log(
            `✅ Generated Anki deck from markdown ${fromMarkdownPath} → ${finalOutputPath}`,
          )
          console.log(`ℹ️ Deck title: ${deckTitle}`)
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
          console.warn(
            `⚠️ Missing API key for provider "${provider}". Set ${apiKeyLookup.envVar} in your environment.`,
          )
        }

        const providerModelHints: Record<SupportedProvider, RegExp> = {
          gemini: /^gemini/i,
          anthropic: /^claude/i,
          openai: /^gpt/i,
        }

        const hint = providerModelHints[provider]
        if (model && hint && !hint.test(model)) {
          console.warn(
            `⚠️ Model "${model}" may not belong to provider "${provider}".`,
          )
        }

        const prompt = await loadPrompt(args.prompt as string | undefined)

        let result
        if (fromJsonPath) {
          const raw = await fs.readFile(fromJsonPath, 'utf8')
          const parsed = JSON.parse(raw)
          const validation = validateJsonStructure(parsed, {
            requireMetadata: false,
            requireTitles: false,
          })
          if (!validation.isValid) {
            throw new Error(`Invalid JSON input: ${validation.error}`)
          }
          result = {
            data: parsed,
            text: bookJsonToPlainText(parsed),
            fileType: 'json',
            sourcePath: fromJsonPath,
          }
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
            provider,
            model,
            epubFilters: extractVerbose ? { titles: [] } : settings.epubFilters,
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

          await fs.mkdir(dirname(toJsonPath), { recursive: true })
          await fs.writeFile(toJsonPath, checkpointPayload)
          console.log(
            `✅ Extracted content saved (no model call) from ${fromJsonPath ?? fromFilePath} → ${toJsonPath}`,
          )
          if (usedDefaultCheckpointOutput) {
            console.log(
              'ℹ️ Output path defaulted to current working directory.',
            )
          }
          console.log(`ℹ️ Using prompt "${prompt.name}" from ${prompt.path}`)
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

        console.log(
          `Generating flashcards in ${sections.length} section(s) (sequential)...`,
        )
        const totalSections = sections.length
        const aggregatedCards: Flashcard[] = []

        for (const [position, section] of sections.entries()) {
          const sectionTitle = section.title?.trim()
          const sectionText = section.text?.trim()
          const start = Date.now()
          const labelTitle = sectionTitle ? ` - ${sectionTitle}` : ''
          console.log(`→ Section ${position + 1}/${totalSections}${labelTitle}`)

          if (!sectionText) {
            const duration = ((Date.now() - start) / 1000).toFixed(2)
            console.error(
              `   status: fail | flashcards: 0 | time: ${duration}s`,
            )
            throw new Error(
              `Section ${position + 1} has no text to process for flashcards.`,
            )
          }

          let rawResponse: string | null = null
          try {
            rawResponse = await generateFlashcards({
              provider,
              model,
              apiKey: apiKeyLookup.apiKey,
              prompt: prompt.contents,
              content: sectionText,
            })

            const parsedCards = parseFlashcardMarkdown(rawResponse)
            aggregatedCards.push(...parsedCards)
            const duration = ((Date.now() - start) / 1000).toFixed(2)
            console.log(
              `   status: success | flashcards: ${parsedCards.length} | time: ${duration}s`,
            )
          } catch (error) {
            const duration = ((Date.now() - start) / 1000).toFixed(2)
            console.error(
              `   status: fail | flashcards: 0 | time: ${duration}s`,
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

            console.log(`ℹ️ Partial markdown saved to ${partialPath}`)
            console.log(
              `ℹ️ Failed section output saved to ${failedSectionPath} (section ${position + 1}${labelTitle})`,
            )

            throw new Error(
              `Section ${position + 1} failed: ${(error as Error).message}`,
            )
          }
        }

        if (aggregatedCards.length === 0) {
          throw new Error(
            'Flashcard generation produced no cards. Check the prompt or input content.',
          )
        }

        const flashcards = renderFlashcards(aggregatedCards)

        const markdownPayload = buildDeckMarkdown(deckTitle, flashcards)
        await fs.writeFile(markdownPath, markdownPayload, 'utf8')

        if (markdownOnly) {
          console.log(
            `✅ Generated markdown flashcards from ${fromJsonPath ?? fromFilePath} → ${markdownPath}`,
          )
          if (usedDefaultMarkdownPath) {
            console.log(
              'ℹ️ Output path defaulted to current working directory.',
            )
          }
          console.log(`ℹ️ Using prompt "${prompt.name}" from ${prompt.path}`)
          console.log(
            'To convert this markdown to Anki: pnpm i -g @shbernal/mdanki',
          )
          return
        }

        if (!ankiOutputPath) {
          throw new Error('No Anki output path resolved.')
        }

        const deckConversionOptions: ConvertMarkdownToAnkiDeckOptions = {
          target: ankiOutputPath,
          deckName: deckTitle,
        }

        await convertMarkdownToAnkiDeck(markdownPath, deckConversionOptions)

        console.log(
          `✅ Generated Anki deck from ${fromJsonPath ?? fromFilePath} (${result.fileType.toUpperCase()}) → ${ankiOutputPath}`,
        )
        if (usedDefaultAnkiPath) {
          console.log('ℹ️ Output path defaulted to current working directory.')
        }
        if (usedDefaultMarkdownPath) {
          console.log(
            'ℹ️ Deck markdown defaulted to current working directory.',
          )
        }
        console.log(`ℹ️ Deck markdown saved to ${markdownPath}`)
        console.log(`ℹ️ Using prompt "${prompt.name}" from ${prompt.path}`)
      } catch (error) {
        console.error('❌ Conversion failed:', (error as Error).message)
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
