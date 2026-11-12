import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isNotFoundError } from "./errors.js";
import {
  DEFAULT_EPUB_TITLE_FILTERS,
  type EpubTitleFilter,
  type SupportedProvider as ServerSupportedProvider,
} from "./pdfankiRuntime.js";

export type SupportedProvider = ServerSupportedProvider;

const CONFIG_DIRNAME = "pdfanki";
const DEFAULT_PROMPT_NAME = "default";
const DEFAULT_PROMPT_FILENAME = `${DEFAULT_PROMPT_NAME}.md`;
const PROMPT_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const CODEX_PROFILE_PATTERN = /^[A-Za-z0-9_-]+$/;
export const CODEX_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/**
 * Every provider the CLI accepts, in one place: `--provider`'s `choices`, the
 * narrowing behind it and the settings reader below all use this list, so none
 * of the three can name one the others do not.
 */
export const SUPPORTED_PROVIDERS = [
  "gemini",
  "anthropic",
  "openai",
  "deepseek",
  "openrouter",
  "codex",
] as const satisfies readonly SupportedProvider[];

/** The three files a workflow can end at, which are also `output.paths`' keys. */
export const OUTPUT_ARTIFACT_KINDS = ["json", "md", "apkg"] as const;
export type OutputArtifactKind = (typeof OUTPUT_ARTIFACT_KINDS)[number];
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

Text to process:`;

export const DEFAULT_SETTINGS: Settings = {
  output: {
    path: ".",
    paths: {},
  },
  generation: {
    defaultProvider: "gemini",
    defaultPrompt: DEFAULT_PROMPT_NAME,
    providers: {
      gemini: {
        defaultModel: "gemini-3.8-flash",
      },
      anthropic: {
        defaultModel: "claude-sonnet-5-5",
      },
      openai: {
        defaultModel: "gpt-5.2-2025-12-11",
      },
      deepseek: {
        defaultModel: "deepseek-chat",
      },
      openrouter: {
        defaultModel: "z-ai/glm-5",
      },
      codex: {
        defaultModel: "gpt-5.4",
        reasoningEffort: "medium",
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
} as const;

export interface ProviderSettings {
  defaultModel: string;
  reasoningEffort?: string;
  profile?: string;
}

/**
 * The settings a run was started with. Readonly throughout: `loadSettings`
 * builds one out of the defaults and the file, and everything downstream reads
 * it. A command that wants different settings passes different flags.
 */
export interface Settings {
  readonly output: {
    readonly path: string;
    readonly paths: Readonly<Partial<Record<OutputArtifactKind, string>>>;
  };
  readonly generation: {
    readonly defaultProvider: SupportedProvider;
    readonly defaultPrompt: string;
    readonly providers: Readonly<Record<SupportedProvider, Readonly<ProviderSettings>>>;
  };
  readonly epub: {
    readonly preview: boolean;
    readonly previewChars: number;
    readonly filters: {
      readonly titles: readonly EpubTitleFilter[];
    };
  };
}

export interface ConfigPaths {
  dir: string;
  settings: string;
  promptsDir: string;
  defaultPrompt: string;
}

function mergeUniqueTitleFilters(
  ...groups: readonly (readonly EpubTitleFilter[] | undefined)[]
): EpubTitleFilter[] {
  const seen = new Set<string>();
  const merged: EpubTitleFilter[] = [];

  for (const group of groups) {
    for (const filter of group ?? []) {
      const key = JSON.stringify(filter);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(filter);
    }
  }

  return merged;
}

/*
 * settings.json, read field by field.
 *
 * `JSON.parse` hands back `any`, and this file used to spread that straight into
 * the defaults: every value the CLI went on to use was whatever the user had
 * typed, unchecked. `previewChars: "twelve"` reached the EPUB extractor, and an
 * uncompilable `pattern` reached `new RegExp` in the title filter, both far from
 * the file that caused them.
 *
 * So each field is read off `unknown` by the reader for its type, and anything
 * that is not what `Settings` says falls back to the default. One bad key costs
 * the user that key rather than the whole file. The other half of that trade is
 * that unknown keys no longer reach the returned `Settings`: the merge used to
 * carry them through, and nothing downstream ever wanted them.
 */

/** A JSON object, which is as much as a reader can tell before looking inside. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readField(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

function readString(source: unknown, key: string): string | undefined {
  const value = readField(source, key);
  return typeof value === "string" ? value : undefined;
}

function readBoolean(source: unknown, key: string): boolean | undefined {
  const value = readField(source, key);
  return typeof value === "boolean" ? value : undefined;
}

function readPositiveInteger(source: unknown, key: string): number | undefined {
  const value = readField(source, key);
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function readArray(source: unknown, key: string): unknown[] | undefined {
  const value = readField(source, key);
  return Array.isArray(value) ? value : undefined;
}

/**
 * Whether a pattern and flags survive `new RegExp`.
 *
 * The EPUB title filters are compiled from settings.json at the point they are
 * applied, deep inside the extractor. A filter that cannot compile is worth
 * dropping here, where the file it came from is still in view.
 */
function isCompilableRegex(pattern: string, flags: string | undefined): boolean {
  try {
    void new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

function readEpubTitleFilter(value: unknown): EpubTitleFilter | undefined {
  const type = readString(value, "type");

  if (type === "string") {
    const literal = readString(value, "value");
    return literal === undefined ? undefined : { type, value: literal };
  }

  if (type !== "regex") {
    return undefined;
  }

  const pattern = readString(value, "pattern");
  if (pattern === undefined) {
    return undefined;
  }

  const rawFlags = readField(value, "flags");
  if (rawFlags !== undefined && typeof rawFlags !== "string") {
    return undefined;
  }
  if (!isCompilableRegex(pattern, rawFlags)) {
    return undefined;
  }

  return rawFlags === undefined ? { type, pattern } : { type, pattern, flags: rawFlags };
}

/** The filters a `titles` array carries, with the unreadable entries dropped. */
function readEpubTitleFilters(source: unknown, key: string): EpubTitleFilter[] | undefined {
  const entries = readArray(source, key);
  if (entries === undefined) {
    return undefined;
  }

  const filters: EpubTitleFilter[] = [];
  for (const entry of entries) {
    const filter = readEpubTitleFilter(entry);
    if (filter !== undefined) {
      filters.push(filter);
    }
  }

  return filters;
}

/**
 * A value `--reasoning-effort` or `--profile` would accept, or the default.
 *
 * The same rule, read through the same function, with a different answer to a
 * failure. Those flags throw because someone just typed the value and can retype
 * it; a bad value in settings.json is dropped, since throwing would cost the user
 * every other setting in the file over one key.
 */
function normalizedOrDefault(
  normalize: (value: unknown, sourceLabel: string) => string | undefined,
  value: unknown,
  fallback: string | undefined,
): string | undefined {
  try {
    return normalize(value, "settings.json") ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * One provider's settings, on top of that provider's defaults.
 *
 * Field by field rather than whole-entry: the spread this replaced let
 * `"gemini": {}` overwrite the default entry outright, leaving a
 * `ProviderSettings` with no `defaultModel` at all, which its own type forbids.
 */
function readProviderSettings(
  source: unknown,
  fallback: Readonly<ProviderSettings>,
): ProviderSettings {
  const settings: ProviderSettings = {
    defaultModel: readString(source, "defaultModel") ?? fallback.defaultModel,
  };

  const effort = normalizedOrDefault(
    normalizeCodexReasoningEffort,
    readField(source, "reasoningEffort"),
    fallback.reasoningEffort,
  );
  if (effort !== undefined) {
    settings.reasoningEffort = effort;
  }

  const profile = normalizedOrDefault(
    normalizeCodexProfile,
    readField(source, "profile"),
    fallback.profile,
  );
  if (profile !== undefined) {
    settings.profile = profile;
  }

  return settings;
}

/**
 * Every provider, from the nested block or the flat legacy one.
 *
 * Built by overwriting a copy of the defaults, so the result is a full record
 * without asserting that it is one.
 */
function readProviders(
  nested: unknown,
  legacy: unknown,
): Record<SupportedProvider, ProviderSettings> {
  const providers: Record<SupportedProvider, ProviderSettings> = {
    ...DEFAULT_SETTINGS.generation.providers,
  };

  for (const provider of SUPPORTED_PROVIDERS) {
    providers[provider] = readProviderSettings(
      readField(nested, provider) ?? readField(legacy, provider),
      DEFAULT_SETTINGS.generation.providers[provider],
    );
  }

  return providers;
}

function readOutputPaths(source: unknown): Partial<Record<OutputArtifactKind, string>> {
  const paths: Partial<Record<OutputArtifactKind, string>> = {};

  for (const kind of OUTPUT_ARTIFACT_KINDS) {
    const path = readString(source, kind);
    if (path !== undefined) {
      paths[kind] = path;
    }
  }

  return paths;
}

function readProvider(source: unknown, key: string): SupportedProvider | undefined {
  const value = readField(source, key);
  return SUPPORTED_PROVIDERS.find((provider) => provider === value);
}

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim().length > 0) {
    return join(xdg, CONFIG_DIRNAME);
  }

  return join(homedir(), `.${CONFIG_DIRNAME}`);
}

export function getConfigPaths(): ConfigPaths {
  const dir = getConfigDir();
  const promptsDir = join(dir, "prompts");
  return {
    dir,
    settings: join(dir, "settings.json"),
    promptsDir,
    defaultPrompt: join(promptsDir, DEFAULT_PROMPT_FILENAME),
  };
}

async function ensureFile(path: string, contents: string) {
  try {
    await fs.access(path);
  } catch {
    await fs.writeFile(path, contents, "utf8");
  }
}

/**
 * Ensure the config directory and default files exist.
 * Does not overwrite existing files.
 */
export async function ensureConfig(): Promise<ConfigPaths> {
  const paths = getConfigPaths();
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.mkdir(paths.promptsDir, { recursive: true });

  await ensureFile(paths.settings, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);

  await ensureFile(paths.defaultPrompt, `${DEFAULT_PROMPT_CONTENT}\n`);

  return paths;
}

/**
 * Delete the existing config directory (if any) and recreate defaults.
 */
export async function resetConfig(): Promise<ConfigPaths> {
  const paths = getConfigPaths();
  await fs.rm(paths.dir, { recursive: true, force: true });
  return ensureConfig();
}

/**
 * The settings file's contents, or `undefined` if it is missing or will not parse.
 *
 * Undefined rather than a throw, because every reader below already answers
 * `undefined` with the default. A file that will not parse then needs no path of
 * its own: it produces the defaults the same way a file with no keys in it does.
 */
async function readSettingsFile(path: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    return parsed;
  } catch {
    return undefined;
  }
}

export async function loadSettings(): Promise<Settings> {
  const paths = await ensureConfig();
  const parsed = await readSettingsFile(paths.settings);

  /* Each field twice where the flat legacy spelling exists, nested first. Both
     shapes have always been read and both keep working. */
  const output = readField(parsed, "output");
  const generation = readField(parsed, "generation");
  const epub = readField(parsed, "epub");

  return {
    output: {
      path:
        readString(output, "path") ??
        readString(parsed, "outputPath") ??
        DEFAULT_SETTINGS.output.path,
      paths: readOutputPaths(readField(output, "paths")),
    },
    generation: {
      defaultProvider:
        readProvider(generation, "defaultProvider") ??
        readProvider(parsed, "defaultProvider") ??
        DEFAULT_SETTINGS.generation.defaultProvider,
      defaultPrompt:
        readString(generation, "defaultPrompt") ??
        readString(parsed, "defaultPrompt") ??
        DEFAULT_SETTINGS.generation.defaultPrompt,
      providers: readProviders(readField(generation, "providers"), readField(parsed, "providers")),
    },
    epub: {
      preview: readBoolean(epub, "preview") ?? DEFAULT_SETTINGS.epub.preview,
      previewChars: readPositiveInteger(epub, "previewChars") ?? DEFAULT_SETTINGS.epub.previewChars,
      filters: {
        titles: mergeUniqueTitleFilters(
          DEFAULT_EPUB_TITLE_FILTERS,
          readEpubTitleFilters(readField(epub, "filters"), "titles"),
          readEpubTitleFilters(readField(parsed, "epubFilters"), "titles"),
        ),
      },
    },
  };
}

export function sanitizePromptName(rawName?: string): string {
  const name = (rawName ?? DEFAULT_PROMPT_NAME).replace(/\.md$/i, "");
  if (!PROMPT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid prompt name "${rawName}". Use alphanumeric characters, dots, underscores, or dashes.`,
    );
  }

  return name;
}

function isCodexReasoningEffort(value: string): value is CodexReasoningEffort {
  return CODEX_REASONING_EFFORTS.some((effort) => effort === value);
}

export function normalizeCodexReasoningEffort(
  value: unknown,
  sourceLabel: string,
): CodexReasoningEffort | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${sourceLabel} must be one of: ${CODEX_REASONING_EFFORTS.join(", ")}.`);
  }

  const normalized = value.trim().toLowerCase();
  if (isCodexReasoningEffort(normalized)) {
    return normalized;
  }

  throw new Error(`${sourceLabel} must be one of: ${CODEX_REASONING_EFFORTS.join(", ")}.`);
}

export function normalizeCodexProfile(value: unknown, sourceLabel: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `${sourceLabel} must contain only letters, numbers, hyphens, or underscores.`,
    );
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (CODEX_PROFILE_PATTERN.test(normalized)) {
    return normalized;
  }

  throw new Error(`${sourceLabel} must contain only letters, numbers, hyphens, or underscores.`);
}

export async function loadPrompt(rawName?: string): Promise<{
  name: string;
  contents: string;
  path: string;
}> {
  const paths = await ensureConfig();
  const name = sanitizePromptName(rawName);
  const promptPath = join(paths.promptsDir, `${name}.md`);

  try {
    const contents = await fs.readFile(promptPath, "utf8");
    return { name, contents, path: promptPath };
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(
        `Prompt "${name}" not found. Expected at ${promptPath}. Create it under ${paths.promptsDir}.`,
        { cause: error },
      );
    }
    throw error;
  }
}
