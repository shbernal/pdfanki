import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  DEFAULT_EPUB_TITLE_FILTERS,
  type EpubTitleFilter,
  type SupportedProvider as ServerSupportedProvider,
} from './pdfankiRuntime.js'

export type SupportedProvider = ServerSupportedProvider

const CONFIG_DIRNAME = 'pdfanki'
const DEFAULT_PROMPT_NAME = 'default'
const DEFAULT_PROMPT_FILENAME = `${DEFAULT_PROMPT_NAME}.md`
const PROMPT_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/
const CODEX_PROFILE_PATTERN = /^[A-Za-z0-9_-]+$/
export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number]
const DEFAULT_PROMPT_CONTENT = `Create flashcards in Markdown using this exact format:

## <front of card text>
- Key point 1
- Key point 2
- Key point 3

**General Analysis Focus:**
- Core ideas, arguments, or concepts introduced or developed in the text
- Key facts, definitions, events, or mechanisms relevant to the topic
- Important relationships, contrasts, or cause-and-effect links
- Notable examples, names, terms, or data explicitly mentioned

**Content Priorities:**
- Group closely related ideas under a single main concept
- Each main question should represent a meaningful, reusable knowledge unit
- Sub-items should capture concrete supporting details only
- Prefer breadth of essential concepts over minor details
- Reflect the author’s main points, not interpretation or commentary

**Format Requirements:**
- Return only Markdown flashcards; do not include a deck title or extra commentary
- Each card front is a \`##\` heading; keep it concise and specific
- Each card back is a bullet list with 1–3 items starting with \`-\` (prefer 3 when the source allows)
- Bullet items are terse fragments (not sentences) that surface concrete facts/names
- One blank line between different flashcard groups
- Keep everything in Markdown with no other prose or wrappers

**Avoid:**
- Complete sentences or filler words
- Explanations, opinions, or meta-commentary
- Redundant points already covered elsewhere
- Trivial details that do not support a core concept
- Returning code fences unless they already exist in the source material
- Adding headings above \`##\` level (the deck title will be added separately)

Text to process:`

export const DEFAULT_SETTINGS: Settings = {
  output: {
    path: '.',
    paths: {},
  },
  generation: {
    defaultProvider: 'gemini',
    defaultPrompt: DEFAULT_PROMPT_NAME,
    providers: {
      gemini: {
        defaultModel: 'gemini-3-pro-preview',
      },
      anthropic: {
        defaultModel: 'claude-sonnet-4-5',
      },
      openai: {
        defaultModel: 'gpt-5.2-2025-12-11',
      },
      deepseek: {
        defaultModel: 'deepseek-chat',
      },
      openrouter: {
        defaultModel: 'z-ai/glm-5',
      },
      codex: {
        defaultModel: 'gpt-5.4',
        reasoningEffort: 'medium',
      },
    },
  },
  epub: {
    preview: false,
    previewChars: 120,
    filters: {
      titles: DEFAULT_EPUB_TITLE_FILTERS,
    },
  },
} as const

export interface ProviderSettings {
  defaultModel: string
  reasoningEffort?: string
  profile?: string
}

export interface Settings {
  output: {
    path: string
    paths: Partial<Record<'json' | 'md' | 'apkg', string>>
  }
  generation: {
    defaultProvider: SupportedProvider
    defaultPrompt: string
    providers: Record<SupportedProvider, ProviderSettings>
  }
  epub: {
    preview: boolean
    previewChars: number
    filters: {
      titles: EpubTitleFilter[]
    }
  }
}

export interface ConfigPaths {
  dir: string
  settings: string
  promptsDir: string
  defaultPrompt: string
}

function mergeUniqueTitleFilters(
  ...groups: (readonly EpubTitleFilter[] | undefined)[]
): EpubTitleFilter[] {
  const seen = new Set<string>()
  const merged: EpubTitleFilter[] = []

  for (const group of groups) {
    for (const filter of group ?? []) {
      const key = JSON.stringify(filter)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(filter)
    }
  }

  return merged
}

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg && xdg.trim().length > 0) {
    return join(xdg, CONFIG_DIRNAME)
  }

  return join(homedir(), `.${CONFIG_DIRNAME}`)
}

export function getConfigPaths(): ConfigPaths {
  const dir = getConfigDir()
  const promptsDir = join(dir, 'prompts')
  return {
    dir,
    settings: join(dir, 'settings.json'),
    promptsDir,
    defaultPrompt: join(promptsDir, DEFAULT_PROMPT_FILENAME),
  }
}

async function ensureFile(path: string, contents: string) {
  try {
    await fs.access(path)
  } catch {
    await fs.writeFile(path, contents, 'utf8')
  }
}

/**
 * Ensure the config directory and default files exist.
 * Does not overwrite existing files.
 */
export async function ensureConfig(): Promise<ConfigPaths> {
  const paths = getConfigPaths()
  await fs.mkdir(paths.dir, { recursive: true })
  await fs.mkdir(paths.promptsDir, { recursive: true })

  await ensureFile(
    paths.settings,
    JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n',
  )

  await ensureFile(paths.defaultPrompt, DEFAULT_PROMPT_CONTENT + '\n')

  return paths
}

/**
 * Delete the existing config directory (if any) and recreate defaults.
 */
export async function resetConfig(): Promise<ConfigPaths> {
  const paths = getConfigPaths()
  await fs.rm(paths.dir, { recursive: true, force: true })
  return ensureConfig()
}

export async function loadSettings(): Promise<Settings> {
  const paths = await ensureConfig()

  try {
    const raw = await fs.readFile(paths.settings, 'utf8')
    const parsed = JSON.parse(raw)
    const parsedProviders = {
      ...(parsed.providers ?? {}),
      ...(parsed.generation?.providers ?? {}),
    }
    const mergedProviders: Record<SupportedProvider, ProviderSettings> = {
      ...DEFAULT_SETTINGS.generation.providers,
      ...parsedProviders,
    }
    const mergedEpubFilters = {
      titles: mergeUniqueTitleFilters(
        DEFAULT_EPUB_TITLE_FILTERS,
        parsed.epub?.filters?.titles,
        parsed.epubFilters?.titles,
      ),
    }
    const preview =
      typeof parsed.epub?.preview === 'boolean'
        ? parsed.epub.preview
        : DEFAULT_SETTINGS.epub.preview
    const previewChars =
      typeof parsed.epub?.previewChars === 'number' &&
      Number.isInteger(parsed.epub.previewChars) &&
      parsed.epub.previewChars > 0
        ? parsed.epub.previewChars
        : DEFAULT_SETTINGS.epub.previewChars

    return {
      ...DEFAULT_SETTINGS,
      output: {
        ...DEFAULT_SETTINGS.output,
        ...(parsed.output ?? {}),
        path:
          parsed.output?.path ??
          parsed.outputPath ??
          DEFAULT_SETTINGS.output.path,
        paths: {
          ...DEFAULT_SETTINGS.output.paths,
          ...(parsed.output?.paths ?? {}),
        },
      },
      generation: {
        ...DEFAULT_SETTINGS.generation,
        ...(parsed.generation ?? {}),
        defaultProvider:
          parsed.generation?.defaultProvider ??
          parsed.defaultProvider ??
          DEFAULT_SETTINGS.generation.defaultProvider,
        defaultPrompt:
          parsed.generation?.defaultPrompt ??
          parsed.defaultPrompt ??
          DEFAULT_SETTINGS.generation.defaultPrompt,
        providers: mergedProviders,
      },
      epub: {
        ...DEFAULT_SETTINGS.epub,
        ...(parsed.epub ?? {}),
        preview,
        previewChars,
        filters: mergedEpubFilters,
      },
    }
  } catch {
    // Fall back to defaults if parsing fails.
    return DEFAULT_SETTINGS
  }
}

export function sanitizePromptName(rawName?: string): string {
  const name = (rawName ?? DEFAULT_PROMPT_NAME).replace(/\.md$/i, '')
  if (!PROMPT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid prompt name "${rawName}". Use alphanumeric characters, dots, underscores, or dashes.`,
    )
  }

  return name
}

export function normalizeCodexReasoningEffort(
  value: unknown,
  sourceLabel: string,
): CodexReasoningEffort | undefined {
  if (typeof value === 'undefined' || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(
      `${sourceLabel} must be one of: ${CODEX_REASONING_EFFORTS.join(', ')}.`,
    )
  }

  const normalized = value.trim().toLowerCase()
  if (CODEX_REASONING_EFFORTS.includes(normalized as CodexReasoningEffort)) {
    return normalized as CodexReasoningEffort
  }

  throw new Error(
    `${sourceLabel} must be one of: ${CODEX_REASONING_EFFORTS.join(', ')}.`,
  )
}

export function normalizeCodexProfile(
  value: unknown,
  sourceLabel: string,
): string | undefined {
  if (typeof value === 'undefined' || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(
      `${sourceLabel} must contain only letters, numbers, hyphens, or underscores.`,
    )
  }

  const normalized = value.trim()
  if (normalized.length === 0) return undefined
  if (CODEX_PROFILE_PATTERN.test(normalized)) return normalized

  throw new Error(
    `${sourceLabel} must contain only letters, numbers, hyphens, or underscores.`,
  )
}

export async function loadPrompt(rawName?: string): Promise<{
  name: string
  contents: string
  path: string
}> {
  const paths = await ensureConfig()
  const name = sanitizePromptName(rawName)
  const promptPath = join(paths.promptsDir, `${name}.md`)

  try {
    const contents = await fs.readFile(promptPath, 'utf8')
    return { name, contents, path: promptPath }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Prompt "${name}" not found. Expected at ${promptPath}. Create it under ${paths.promptsDir}.`,
      )
    }
    throw error
  }
}
