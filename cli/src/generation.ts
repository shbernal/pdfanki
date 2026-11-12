import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { renderMarkdown, type Card, type Deck } from "@ankimd/core";

import { optionalProviderArg, optionalStringArg, type ParsedArgs } from "./args.js";
import {
  normalizeCodexProfile,
  normalizeCodexReasoningEffort,
  type CodexReasoningEffort,
  type ProviderSettings,
  type Settings,
  type SupportedProvider,
} from "./config.js";
import { providerRequiresApiKey, readProviderApiKey, type ApiKeyLookup } from "./env.js";
import { describeError } from "./errors.js";
import { parseSectionCards } from "./flashcardPolicy.js";
import { generateFlashcards, type ReadonlyContentSection } from "./pdfankiRuntime.js";
import { runWithProgressHeartbeat, type CliUi } from "./ui/cliUi.js";
import {
  colorizeText,
  formatCheckStatus,
  formatCount,
  formatDuration,
  formatSectionHeading,
} from "./ui/format.js";
import type { Logger } from "./ui/logger.js";

/**
 * Asking a model for cards, one content section at a time.
 *
 * The other half of a workflow reads a document and writes a file; this half is
 * the only part that talks to a provider, and the only part that can fail
 * halfway through with something worth keeping.
 */

const MAX_MARKDOWN_VALIDATION_ATTEMPTS = 3;

const PROVIDER_MODEL_HINTS: Record<SupportedProvider, RegExp> = {
  gemini: /^gemini/i,
  anthropic: /^claude/i,
  openai: /^gpt/i,
  deepseek: /^deepseek/i,
  openrouter: /^(?:openrouter\/)?[a-z0-9._-]+\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)?$/i,
  codex: /^(?:gpt|o\d|codex)/i,
};

export interface GenerationArgs extends ParsedArgs {
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly codexReasoningEffort?: unknown;
  readonly codexProfile?: unknown;
}

interface CodexOptions {
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly profile?: string;
}

/** Which provider answers, as which model, with which credential. */
export interface GenerationPlan {
  readonly provider: SupportedProvider;
  readonly model: string;
  readonly requiresApiKey: boolean;
  readonly apiKeyLookup: ApiKeyLookup | null;
  readonly codexOptions: CodexOptions | undefined;
}

interface GenerateFlashcardsRequest {
  readonly provider: SupportedProvider;
  readonly model: string;
  readonly apiKey?: string;
  readonly prompt: string;
  readonly content: string;
  readonly codex?: {
    readonly reasoningEffort?: CodexReasoningEffort;
    readonly profile?: string;
  };
}

/**
 * The deck the generated cards belong to.
 *
 * The `# ` title is written here rather than by the model, which is why the model's
 * output is validated as a card region and a `#` in it is an error.
 */
export function buildDeck(deckTitle: string, cards: readonly Card[]): Deck {
  return {
    title: deckTitle.trim() || "Deck",
    titleSource: "heading",
    frontmatter: {},
    fileTags: [],
    preamble: null,
    cards,
  };
}

function resolveCodexOptions(
  args: GenerationArgs,
  provider: SupportedProvider,
  providerSettings: Readonly<ProviderSettings> | undefined,
): CodexOptions | undefined {
  const hasCodexReasoningEffortFlag = args.codexReasoningEffort !== undefined;
  const hasCodexProfileFlag = args.codexProfile !== undefined;

  if (provider !== "codex" && (hasCodexReasoningEffortFlag || hasCodexProfileFlag)) {
    throw new Error(
      '--codex-reasoning-effort and --codex-profile can only be used with provider "codex".',
    );
  }

  if (provider !== "codex") {
    return undefined;
  }

  const codexReasoningEffort = normalizeCodexReasoningEffort(
    hasCodexReasoningEffortFlag ? args.codexReasoningEffort : providerSettings?.reasoningEffort,
    hasCodexReasoningEffortFlag
      ? "--codex-reasoning-effort"
      : "settings.generation.providers.codex.reasoningEffort",
  );
  const codexProfile = normalizeCodexProfile(
    hasCodexProfileFlag ? args.codexProfile : providerSettings?.profile,
    hasCodexProfileFlag ? "--codex-profile" : "settings.generation.providers.codex.profile",
  );

  return {
    ...(codexReasoningEffort === undefined ? {} : { reasoningEffort: codexReasoningEffort }),
    ...(codexProfile === undefined ? {} : { profile: codexProfile }),
  };
}

export function resolveGenerationPlan(
  args: GenerationArgs,
  generation: Settings["generation"],
  logger: Logger,
): GenerationPlan {
  const provider = optionalProviderArg(args.provider) ?? generation.defaultProvider;
  const providerSettings = generation.providers[provider];
  const defaultModel =
    providerSettings?.defaultModel ??
    generation.providers[generation.defaultProvider]?.defaultModel;
  const model = optionalStringArg(args.model) ?? defaultModel;
  const requiresApiKey = providerRequiresApiKey(provider);
  const apiKeyLookup = requiresApiKey ? readProviderApiKey(provider) : null;
  const codexOptions = resolveCodexOptions(args, provider, providerSettings);

  if (!model) {
    throw new Error(
      "Model is required when invoking a provider. Set it via --model or settings.json.",
    );
  }

  const hint = PROVIDER_MODEL_HINTS[provider];
  if (!hint.test(model)) {
    logger.warn(`Model "${model}" may not belong to provider "${provider}".`);
  }

  logger.debug(`Provider: ${provider}`);
  logger.debug(`Model: ${model}`);
  if (provider === "codex") {
    logger.debug(
      `Codex reasoning effort: ${codexOptions?.reasoningEffort ?? "inherited from Codex config"}`,
    );
    logger.debug(`Codex profile: ${codexOptions?.profile ?? "inherited from Codex config"}`);
  }

  return { provider, model, requiresApiKey, apiKeyLookup, codexOptions };
}

export function logDryRunSummary(
  options: Readonly<{
    ui: CliUi;
    plan: GenerationPlan;
    prompt: Readonly<{ name: string; path: string }>;
    sectionCount: number;
    outputPath: string;
    defaultOutputDir: string | undefined;
    usedDefaultOutputPath: boolean;
  }>,
): void {
  const { ui, plan, prompt, sectionCount, outputPath, defaultOutputDir, usedDefaultOutputPath } =
    options;
  const { logger, useColor } = ui;
  const { provider, model, requiresApiKey, apiKeyLookup, codexOptions } = plan;

  const apiCheckOk = !requiresApiKey || Boolean(apiKeyLookup?.apiKey);
  const apiCheckDetail = requiresApiKey
    ? apiCheckOk
      ? apiKeyLookup!.envVar
      : `missing env var ${apiKeyLookup!.envVar}`
    : "uses local Codex CLI auth; no PROVIDER_API_KEY required";
  console.log("");
  process.stdout.write(`${formatSectionHeading("Dry Run Summary", useColor)}\n`);
  logger.info(`AI provider: ${colorizeText(provider, "blue", useColor)}`);
  logger.info(`Model: ${colorizeText(model, "blue", useColor)}`);
  if (provider === "codex") {
    logger.info(
      `Codex reasoning effort: ${colorizeText(codexOptions?.reasoningEffort ?? "inherited", "blue", useColor)}`,
    );
    logger.info(
      `Codex profile: ${colorizeText(codexOptions?.profile ?? "inherited", "blue", useColor)}`,
    );
  }
  logger.info(
    `API check: ${formatCheckStatus(apiCheckOk, useColor)} ${colorizeText(`(${apiCheckDetail})`, "lightGray", useColor)}`,
  );
  logger.info(
    `Prompt: ${colorizeText(prompt.name, "blue", useColor)} ${colorizeText(`(${prompt.path})`, "lightGray", useColor)}`,
  );
  logger.info(`Sections: ${colorizeText(formatCount(sectionCount), "blue", useColor)}`);
  logger.info(
    usedDefaultOutputPath
      ? `Output path: ${colorizeText(
          defaultOutputDir && defaultOutputDir !== "." ? defaultOutputDir : "cwd",
          "blue",
          useColor,
        )} ${colorizeText(`(${outputPath})`, "lightGray", useColor)}`
      : `Output path: ${colorizeText(outputPath, "blue", useColor)}`,
  );
}

/** The last thing the model said, kept so a failure can be written out verbatim. */
interface ResponseCapture {
  rawResponse: string | null;
}

/**
 * One section's cards, retrying the model when what came back is not markdown
 * this package will accept.
 *
 * `capture` is written on every attempt rather than returned, because the caller
 * needs the last response most when this throws - that is what gets written
 * beside the partial deck.
 */
async function generateSectionCards(
  options: Readonly<{
    request: GenerateFlashcardsRequest;
    progressLabel: string | null;
    position: number;
    ui: CliUi;
    capture: ResponseCapture;
    reportRetry: ((headline: string, detail: string) => void) | null;
  }>,
): Promise<Card[]> {
  const { request, progressLabel, position, ui, capture, reportRetry } = options;

  for (let attempt = 1; attempt <= MAX_MARKDOWN_VALIDATION_ATTEMPTS; attempt++) {
    const retrySuffix =
      attempt > 1 ? ` (retry ${attempt}/${MAX_MARKDOWN_VALIDATION_ATTEMPTS})` : "";
    const response =
      progressLabel === null
        ? await generateFlashcards(request)
        : await runWithProgressHeartbeat({
            progress: ui.progress,
            current: position,
            label: `${progressLabel} | Model reasoning...${retrySuffix}`,
            intervalMs: 100,
            animateSpinner: true,
            action: () => generateFlashcards(request),
          });

    capture.rawResponse = response;

    try {
      return parseSectionCards(response);
    } catch (validationError) {
      if (!(validationError instanceof Error)) {
        throw validationError;
      }

      if (attempt >= MAX_MARKDOWN_VALIDATION_ATTEMPTS) {
        throw new Error(
          `Markdown formatting remained invalid after ${MAX_MARKDOWN_VALIDATION_ATTEMPTS} attempts.\n${validationError.message}`,
          { cause: validationError },
        );
      }

      reportRetry?.(
        `   markdown validation failed on attempt ${attempt}/${MAX_MARKDOWN_VALIDATION_ATTEMPTS}; retrying model call for the same section.`,
        validationError.message,
      );
    }
  }

  throw new Error(
    `No valid markdown response parsed after ${MAX_MARKDOWN_VALIDATION_ATTEMPTS} attempts.`,
  );
}

/**
 * What a failed section leaves behind: the cards that did make it, and the model
 * response that did not. Both go beside the output the run was aiming for.
 */
async function writeSectionFailureArtifacts(
  options: Readonly<{
    logger: Logger;
    outputPath: string;
    artifactBaseName: string;
    deckTitle: string;
    cards: readonly Card[];
    rawResponse: string | null;
    position: number;
    sectionLabel: string;
  }>,
): Promise<void> {
  const {
    logger,
    outputPath,
    artifactBaseName,
    deckTitle,
    cards,
    rawResponse,
    position,
    sectionLabel,
  } = options;

  const artifactDir = dirname(outputPath);
  const partialPath = join(artifactDir, `${artifactBaseName}-partial.md`);
  const failedSectionPath = join(
    artifactDir,
    `${artifactBaseName}-failed-section-${position + 1}.md`,
  );
  const partialPayload = renderMarkdown(buildDeck(deckTitle, cards));
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(partialPath, partialPayload, "utf8");

  const failedPayload =
    rawResponse && rawResponse.trim().length > 0
      ? rawResponse
      : "No model response captured for this section.";
  await fs.writeFile(failedSectionPath, failedPayload, "utf8");

  logger.warn(`Partial markdown saved to ${partialPath}`);
  logger.warn(`Failed section output saved to ${failedSectionPath} (${sectionLabel})`);
}

export interface GenerateAllCardsOptions {
  readonly sections: readonly ReadonlyContentSection[];
  readonly plan: GenerationPlan;
  readonly promptContents: string;
  readonly ui: CliUi;
  readonly deckTitle: string;
  readonly outputPath: string;
  readonly artifactBaseName: string;
  readonly dryRun: boolean;
}

/**
 * What a failed section reports before the run gives up: the timing line, and
 * either the artifacts or the note saying a dry run skipped them.
 */
async function reportSectionFailure(
  options: Readonly<{
    ui: CliUi;
    sectionLabel: string;
    sectionStart: number;
    position: number;
    cardsSoFar: readonly Card[];
    rawResponse: string | null;
    deckTitle: string;
    outputPath: string;
    artifactBaseName: string;
    dryRun: boolean;
  }>,
): Promise<void> {
  const { ui, sectionLabel, sectionStart, position, cardsSoFar, rawResponse } = options;
  const { deckTitle, outputPath, artifactBaseName, dryRun } = options;
  const { logger } = ui;

  ui.progress.clear();
  logger.error(
    `${sectionLabel} failed | flashcards: 0 | time: ${formatDuration(Date.now() - sectionStart)}`,
  );

  if (dryRun) {
    logger.warn("Dry run enabled; partial markdown and failed section artifacts were not written.");
    return;
  }

  await writeSectionFailureArtifacts({
    logger,
    outputPath,
    artifactBaseName,
    deckTitle,
    cards: cardsSoFar,
    rawResponse,
    position,
    sectionLabel,
  });
}

interface SectionRunOptions {
  readonly section: ReadonlyContentSection;
  readonly position: number;
  readonly totalSections: number;
  readonly baseRequest: Omit<GenerateFlashcardsRequest, "content">;
  readonly ui: CliUi;
  readonly useProgress: boolean;
  readonly showPerSectionLogs: boolean;
  readonly cardsSoFar: readonly Card[];
  readonly deckTitle: string;
  readonly outputPath: string;
  readonly artifactBaseName: string;
  readonly dryRun: boolean;
}

/** One section: ask, time it, and on failure leave the partial work behind. */
async function runSection(options: SectionRunOptions): Promise<Card[]> {
  const { section, position, totalSections, baseRequest, ui, useProgress } = options;
  const { showPerSectionLogs, cardsSoFar, deckTitle, outputPath, artifactBaseName, dryRun } =
    options;
  const { logger, progress } = ui;

  const sectionTitle = section.title?.trim();
  const sectionText = section.text?.trim();
  const sectionStart = Date.now();
  const sectionPrefix = `Section ${position + 1}/${totalSections}`;
  const sectionLabel = sectionTitle ? `${sectionPrefix} - ${sectionTitle}` : sectionPrefix;

  if (showPerSectionLogs) {
    logger.info(`-> ${sectionLabel}`);
  }

  if (!sectionText) {
    progress.clear();
    throw new Error(`Section ${position + 1} has no text to process for flashcards.`);
  }

  const capture: ResponseCapture = { rawResponse: null };
  try {
    const cards = await generateSectionCards({
      request: { ...baseRequest, content: sectionText },
      progressLabel: useProgress ? sectionTitle || sectionPrefix : null,
      position,
      ui,
      capture,
      reportRetry: showPerSectionLogs
        ? (headline, detail) => {
            logger.warn(headline);
            logger.warn(detail);
          }
        : null,
    });

    if (showPerSectionLogs) {
      const duration = formatDuration(Date.now() - sectionStart);
      logger.info(`   status: success | flashcards: ${cards.length} | time: ${duration}`);
    }

    progress.increment(sectionLabel);
    return cards;
  } catch (error) {
    await reportSectionFailure({
      ui,
      sectionLabel,
      sectionStart,
      position,
      cardsSoFar,
      rawResponse: capture.rawResponse,
      deckTitle,
      outputPath,
      artifactBaseName,
      dryRun,
    });
    throw new Error(`Section ${position + 1} failed: ${describeError(error)}`, { cause: error });
  }
}

/**
 * Every section's cards, in order.
 *
 * The progress bar is started and stopped here, and every one of its methods is
 * a no-op unless it is both enabled and on a TTY - which is exactly the
 * condition `progressEnabled` already carries. `useProgress` is kept for the one
 * place the difference is real: whether a call is wrapped in a heartbeat, which
 * sets a timer.
 */
export async function generateAllCards(options: GenerateAllCardsOptions): Promise<Card[]> {
  const { sections, plan, promptContents, ui, deckTitle, outputPath, artifactBaseName, dryRun } =
    options;
  const { logger, progress } = ui;
  const { apiKeyLookup, codexOptions } = plan;

  const generationStart = Date.now();
  const aggregatedCards: Card[] = [];
  const showPerSectionLogs = logger.isDebugEnabled || !ui.progressEnabled;

  progress.start(sections.length, "Starting generation");

  /* One request for both ways of making it: the heartbeat wraps the call and the
     bare path does not, and the only thing that differed between them was which
     of the two spelled the arguments out. `apiKey` and `codex` are written only
     where there is one, since the provider reads an absent key and an undefined
     one the same way. */
  const baseRequest = {
    provider: plan.provider,
    model: plan.model,
    prompt: promptContents,
    ...(apiKeyLookup?.apiKey === undefined ? {} : { apiKey: apiKeyLookup.apiKey }),
    ...(codexOptions === undefined ? {} : { codex: codexOptions }),
  };

  for (const [position, section] of sections.entries()) {
    const cards = await runSection({
      section,
      position,
      totalSections: sections.length,
      baseRequest,
      ui,
      useProgress: ui.progressEnabled,
      showPerSectionLogs,
      cardsSoFar: aggregatedCards,
      deckTitle,
      outputPath,
      artifactBaseName,
      dryRun,
    });
    aggregatedCards.push(...cards);
  }

  progress.stop();

  if (aggregatedCards.length === 0) {
    throw new Error("Flashcard generation produced no cards. Check the prompt or input content.");
  }

  const totalDuration = formatDuration(Date.now() - generationStart);
  logger.success(`Generated ${aggregatedCards.length} flashcards in ${totalDuration}.`);

  return aggregatedCards;
}
