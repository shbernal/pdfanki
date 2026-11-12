import { promises as fs } from "node:fs";
import { dirname, join, parse } from "node:path";

import { parseMarkdown, renderMarkdown, writeApkg, type Deck } from "@ankimd/core";

import {
  flagProvided,
  normalizeIntegerOption,
  normalizePathArg,
  normalizeRequiredInputPath,
  optionalStringArg,
  toBool,
  toKebabAlnum,
  type PreviewFlagMode,
} from "./args.js";
import {
  ensureConfig,
  loadPrompt,
  loadSettings,
  type OutputArtifactKind,
  type Settings,
} from "./config.js";
import { describeError } from "./errors.js";
import {
  buildDeck,
  generateAllCards,
  logDryRunSummary,
  resolveGenerationPlan,
  type GenerationArgs,
} from "./generation.js";
import { highlight } from "./highlight.js";
import { createMediaResolver, DEFAULT_TIMEOUT_MS, type MediaOptions } from "./media.js";
import {
  convertFileFromPath,
  isBookJson,
  validateJsonStructure,
  type ConvertFileOptions,
  type ReadonlyBookJson,
} from "./pdfankiRuntime.js";
import { logPdfExtractionSummary } from "./pdfSummary.js";
import { defaultTemplate } from "./template.js";
import {
  buildCliUi,
  reportingLogger,
  runWithSpinner,
  type CliUi,
  type UiBuildArgs,
} from "./ui/cliUi.js";
import type { Logger } from "./ui/logger.js";

/**
 * One command shape behind every conversion pdfanki offers: read a source of
 * some kind, optionally ask a model about it, write an artifact of some kind.
 * All ten subcommands land in `runWorkflowCommand`, which differs between them
 * only by which source it reads and which artifact it writes.
 */

/* Not a flag. `ankimd build` exposes `--code-theme`; here every Anki output takes
   the same default, and a second spelling of it is its own decision. */
const CODE_THEME = "dark";

type CliSettings = Settings;
export type WorkflowSourceKind = "pdf" | "epub" | "json" | "md";
export type WorkflowTargetKind = "json" | "md" | "anki";
type StructuredSourceKind = Exclude<WorkflowSourceKind, "md">;

type WorkflowCommandArgs = UiBuildArgs &
  GenerationArgs & {
    readonly input?: unknown;
    readonly out?: unknown;
    readonly fullFidelity?: unknown;
    readonly index?: unknown;
    readonly indexRanges?: unknown;
    readonly startSection?: unknown;
    readonly endSection?: unknown;
    readonly excludeSections?: unknown;
    readonly minChar?: unknown;
    readonly preview?: unknown;
    readonly previewChars?: unknown;
    readonly prompt?: unknown;
    readonly deckTitle?: unknown;
    readonly debug?: unknown;
    readonly dryRun?: unknown;
    readonly remoteMedia?: unknown;
    readonly remoteTimeout?: unknown;
  };

interface StructuredSourceResult {
  readonly data: ReadonlyBookJson;
  readonly fileType: StructuredSourceKind;
  readonly sourcePath: string;
}

function resolveOutputPath(
  target: string | undefined,
  fallbackBaseName: string,
  extension: string,
  defaultDir?: string,
): string {
  if (target) {
    const parsed = parse(target);
    if (parsed.ext) {
      return target;
    }
    if (parsed.dir || parsed.name) {
      const dir = parsed.dir || ".";
      const stem = parsed.name || fallbackBaseName;
      return join(dir, `${stem}${extension}`);
    }
  }

  const outputDir = defaultDir && defaultDir !== "." ? defaultDir : process.cwd();
  return join(outputDir, `${fallbackBaseName}${extension}`);
}

/** Where the artifact goes, and whether the user said so or settings.json did. */
interface OutputPlan {
  readonly outputPath: string;
  readonly outputBaseName: string;
  readonly defaultOutputDir: string | undefined;
  readonly usedDefaultOutputPath: boolean;
  readonly artifactBaseName: string;
}

function resolveOutputPlan(
  args: WorkflowCommandArgs,
  settings: CliSettings,
  targetKind: WorkflowTargetKind,
  inputPath: string,
): OutputPlan {
  const outputBaseName = toKebabAlnum(parse(inputPath).name || "deck");
  const outputArtifactKind: OutputArtifactKind =
    targetKind === "json" ? "json" : targetKind === "md" ? "md" : "apkg";
  const defaultOutputDir = normalizePathArg(
    settings.output.paths[outputArtifactKind] ?? settings.output.path,
  );
  const explicitOutputPath = normalizePathArg(args.out);
  const outputPath = resolveOutputPath(
    explicitOutputPath,
    outputBaseName,
    `.${outputArtifactKind}`,
    defaultOutputDir,
  );

  return {
    outputPath,
    outputBaseName,
    defaultOutputDir,
    usedDefaultOutputPath: !explicitOutputPath,
    artifactBaseName: parse(outputPath).name || outputBaseName,
  };
}

/** The flags that narrow what gets read out of a PDF or EPUB. */
interface SourceOptions {
  readonly indexPath: string | undefined;
  readonly indexRanges: string | undefined;
  readonly excludeChapters: string | undefined;
  readonly minChars: number | undefined;
  readonly previewChars: number | undefined;
  readonly startChapter: number | undefined;
  readonly endChapter: number | undefined;
}

function readSourceOptions(args: WorkflowCommandArgs): SourceOptions {
  const indexPath = normalizePathArg(args.index);
  const indexRanges = normalizePathArg(args.indexRanges);
  const excludeChapters = normalizePathArg(args.excludeSections);
  if (flagProvided(args.indexRanges) && typeof args.indexRanges === "string" && !indexRanges) {
    throw new Error("--index-ranges must not be empty.");
  }
  if (
    flagProvided(args.excludeSections) &&
    typeof args.excludeSections === "string" &&
    !excludeChapters
  ) {
    throw new Error("--exclude-sections must not be empty.");
  }
  if (indexPath && indexRanges) {
    throw new Error('Use --index <path> or --index-ranges "<start-end,...>", not both.');
  }

  const startChapter = normalizeIntegerOption(args.startSection, "--start-section", 1);
  const endChapter = normalizeIntegerOption(args.endSection, "--end-section", 1);
  if (
    typeof startChapter === "number" &&
    typeof endChapter === "number" &&
    startChapter > endChapter
  ) {
    throw new Error("--start-section must be less than or equal to --end-section.");
  }

  return {
    indexPath,
    indexRanges,
    excludeChapters,
    minChars: normalizeIntegerOption(args.minChar, "--min-char", 0),
    previewChars: normalizeIntegerOption(args.previewChars, "--preview-chars", 1),
    startChapter,
    endChapter,
  };
}

function buildBasicExtractPayload(book: ReadonlyBookJson): {
  content: { index: number; title: string | undefined; text: string | undefined }[];
} {
  return {
    content: book.content.map((section) => ({
      index: section.index,
      title: section.title,
      text: section.text,
    })),
  };
}

async function loadCliSettings(ui: CliUi): Promise<CliSettings> {
  return runWithSpinner(ui.spinner, "Loading configuration...", async () => {
    await ensureConfig();
    return loadSettings();
  });
}

/**
 * Whether an EPUB preview is printed, given that three things can ask for one:
 * the flag as typed, a `--preview-chars` count on its own, and settings.json.
 */
function resolvePreview(
  previewFlagMode: PreviewFlagMode,
  previewChars: number | undefined,
  configured: boolean,
): boolean {
  if (previewFlagMode !== "unset") {
    return previewFlagMode === "enabled";
  }
  return typeof previewChars === "number" ? true : configured;
}

async function loadStructuredSource(
  options: Readonly<{
    sourceKind: StructuredSourceKind;
    inputPath: string;
    ui: CliUi;
    settings: CliSettings;
    source: SourceOptions;
    debug: boolean;
    fullFidelity: boolean;
  }>,
): Promise<StructuredSourceResult> {
  const { sourceKind, inputPath, ui, settings, source, debug, fullFidelity } = options;
  const { indexPath, indexRanges, startChapter, endChapter, excludeChapters, minChars } = source;

  if (sourceKind === "json") {
    return runWithSpinner(ui.spinner, "Loading extracted JSON...", async () => {
      const raw = await fs.readFile(inputPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const shape = { requireMetadata: false, requireTitles: false };
      if (!isBookJson(parsed, shape)) {
        throw new Error(`Invalid JSON input: ${validateJsonStructure(parsed, shape).error}`);
      }

      return {
        data: parsed,
        fileType: "json",
        sourcePath: inputPath,
      };
    });
  }

  const convertOptions: ConvertFileOptions = {
    inputPath,
    type: sourceKind,
    preview: settings.epub.preview,
    previewChars: settings.epub.previewChars,
    epubFilters: fullFidelity ? { titles: [] } : settings.epub.filters,
    debug,
    /* Written only where the flag was given. These are optional to
       `convertFileFromPath`, which is published, so the key stays off rather than
       the library's signature growing an `| undefined` for every caller. */
    ...(indexPath === undefined ? {} : { indexPath }),
    ...(indexRanges === undefined ? {} : { indexRanges }),
    ...(startChapter === undefined ? {} : { startChapter }),
    ...(endChapter === undefined ? {} : { endChapter }),
    ...(excludeChapters === undefined ? {} : { excludeChapters }),
    ...(minChars === undefined ? {} : { minChars }),
  };

  return convertFileFromPath(convertOptions);
}

/**
 * Writes the package, reporting whatever the conversion had to say.
 *
 * §3.3 of the format: a deck that lost something on the way out says so. A silent
 * success over skipped cards is a conformance bug rather than a tidy UI.
 */
async function buildAnkiPackage(
  options: Readonly<{
    deck: Deck;
    outputPath: string;
    deckTitle: string;
    logger: Logger;
    /* Absent for a deck pdfanki just generated, which names no image and has no
       directory to look in. Without a resolver a reference stays as written, which
       is what the library does and what this did before. */
    media?: Readonly<MediaOptions>;
  }>,
): Promise<void> {
  const { deck, outputPath, deckTitle, logger, media } = options;
  const diagnostics = await writeApkg(deck, outputPath, {
    deckName: deckTitle,
    highlight,
    template: await defaultTemplate(CODE_THEME),
    ...(media === undefined ? {} : { resolveMedia: createMediaResolver(media) }),
  });

  for (const item of diagnostics) {
    logger.warn(`${item.code}: ${item.message}`);
  }
}

/** `md anki`: the user's own deck rather than one pdfanki just generated. */
async function runMarkdownToAnki(
  options: Readonly<{
    ui: CliUi;
    inputPath: string;
    output: OutputPlan;
    deckTitleArg: string | undefined;
    dryRun: boolean;
    remoteMedia: boolean;
    remoteTimeoutMs: number;
  }>,
): Promise<void> {
  const { ui, inputPath, output, deckTitleArg, dryRun, remoteMedia, remoteTimeoutMs } = options;
  const { logger, spinner } = ui;
  const { outputPath, usedDefaultOutputPath } = output;

  const markdownSource = await runWithSpinner(spinner, "Reading markdown deck...", async () =>
    fs.readFile(inputPath, "utf8"),
  );

  /* The consumer half of the format, not the producer half: this is the user's
     own deck rather than something pdfanki just generated, so anything unreadable
     is reported and the rest of the file still converts (§3.1). */
  const { deck, diagnostics } = parseMarkdown(markdownSource);
  const deckTitle =
    deckTitleArg && deckTitleArg.length > 0
      ? deckTitleArg
      : deck.title?.trim() || parse(inputPath).name;

  if (dryRun) {
    logger.info("- dry run: Anki package creation skipped");
    logger.info(`- would read markdown from ${inputPath}`);
    logger.info(`- would build Anki package at ${outputPath}`);
    if (usedDefaultOutputPath) {
      logger.info("Output path defaulted to current working directory.");
    }
    logger.info(`Deck title: ${deckTitle}`);
    return;
  }

  for (const item of diagnostics) {
    logger.warn(`${item.code}: ${item.message}`);
  }

  await runWithSpinner(spinner, "Building Anki deck...", async () => {
    await buildAnkiPackage({
      deck,
      outputPath,
      deckTitle,
      logger,
      /* Images are resolved beside the deck that names them, which is where a
         relative reference in someone's vault points. A remote one is downloaded
         only when `--remote-media` says so: this command is published and already
         in use, so touching the network is asked for rather than assumed. */
      media: { directories: [dirname(inputPath)], remote: remoteMedia, timeoutMs: remoteTimeoutMs },
    });
  });

  logger.success(`Generated Anki deck from markdown ${inputPath} -> ${outputPath}`);
  if (usedDefaultOutputPath) {
    logger.info("Output path defaulted to current working directory.");
  }
  logger.info(`Deck title: ${deckTitle}`);
}

/** `pdf json` and `epub json`: extraction, with no model involved. */
async function writeExtractedJson(
  options: Readonly<{
    ui: CliUi;
    inputPath: string;
    output: OutputPlan;
    structured: StructuredSourceResult;
    source: SourceOptions;
    fullFidelity: boolean;
    dryRun: boolean;
  }>,
): Promise<void> {
  const { ui, inputPath, output, structured, source, fullFidelity, dryRun } = options;
  const { logger, spinner } = ui;
  const { outputPath, usedDefaultOutputPath } = output;

  if (structured.fileType === "pdf") {
    logPdfExtractionSummary({
      logger,
      sourcePath: inputPath,
      book: structured.data,
      indexProvided: Boolean(source.indexPath || source.indexRanges),
    });
  }

  const payload = JSON.stringify(
    fullFidelity ? structured.data : buildBasicExtractPayload(structured.data),
    null,
    2,
  );

  if (dryRun) {
    logger.info("- dry run: extracted JSON not written to disk");
    logger.info(`- would write JSON to ${outputPath}`);
    if (usedDefaultOutputPath) {
      logger.info("Output path defaulted to current working directory.");
    }
    return;
  }

  await runWithSpinner(spinner, "Writing extracted JSON...", async () => {
    await fs.mkdir(dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, payload, "utf8");
  });

  logger.success(`Saved extracted JSON to ${outputPath}`);
  if (usedDefaultOutputPath) {
    logger.info("Output path defaulted to current working directory.");
  }
}

/** The generated cards, as markdown or as a package. */
async function writeGeneratedDeck(
  options: Readonly<{
    ui: CliUi;
    targetKind: WorkflowTargetKind;
    deck: Deck;
    deckTitle: string;
    inputPath: string;
    sourceLabel: string;
    output: OutputPlan;
    prompt: Readonly<{ name: string; path: string }>;
    dryRun: boolean;
  }>,
): Promise<void> {
  const { ui, targetKind, deck, deckTitle, inputPath, sourceLabel, output, prompt, dryRun } =
    options;
  const { logger, spinner } = ui;
  const { outputPath, usedDefaultOutputPath } = output;

  if (dryRun) {
    if (targetKind === "md") {
      logger.info("- dry run: markdown deck not written to disk");
      logger.info(`- would write markdown to ${outputPath}`);
    } else {
      logger.info("- dry run: Anki package creation skipped");
      logger.info(`- would build Anki package at ${outputPath}`);
    }
    if (usedDefaultOutputPath) {
      logger.info("Output path defaulted to current working directory.");
    }
    logger.info(`Using prompt "${prompt.name}" from ${prompt.path}`);
    return;
  }

  await fs.mkdir(dirname(outputPath), { recursive: true });

  if (targetKind === "md") {
    const markdownPayload = renderMarkdown(deck);
    await runWithSpinner(spinner, "Writing markdown deck...", async () => {
      await fs.writeFile(outputPath, markdownPayload, "utf8");
    });

    logger.success(
      `Generated markdown flashcards from ${inputPath} (${sourceLabel}) -> ${outputPath}`,
    );
  } else {
    await runWithSpinner(spinner, "Building Anki package...", async () => {
      await buildAnkiPackage({ deck, outputPath, deckTitle, logger });
    });

    logger.success(`Generated Anki deck from ${inputPath} (${sourceLabel}) -> ${outputPath}`);
  }

  if (usedDefaultOutputPath) {
    logger.info("Output path defaulted to current working directory.");
  }
  logger.info(`Using prompt "${prompt.name}" from ${prompt.path}`);
}

/** Everything from an extracted book to a deck: pick a provider, ask, write. */
async function runGenerationWorkflow(
  options: Readonly<{
    ui: CliUi;
    targetKind: WorkflowTargetKind;
    args: WorkflowCommandArgs;
    settings: CliSettings;
    inputPath: string;
    output: OutputPlan;
    structured: StructuredSourceResult;
    dryRun: boolean;
  }>,
): Promise<void> {
  const { ui, targetKind, args, settings, inputPath, output, structured, dryRun } = options;
  const { logger, spinner } = ui;

  const plan = resolveGenerationPlan(args, settings.generation, logger);
  const prompt = await runWithSpinner(spinner, "Loading prompt...", async () =>
    loadPrompt(optionalStringArg(args.prompt) ?? settings.generation.defaultPrompt),
  );

  const deckTitleArg = normalizePathArg(args.deckTitle);
  const deckTitle =
    deckTitleArg && deckTitleArg.length > 0
      ? deckTitleArg
      : parse(inputPath).name || output.outputBaseName;

  const sections = structured.data.content;
  if (sections.length === 0) {
    throw new Error("No content sections found to generate flashcards.");
  }

  if (targetKind === "md" && dryRun) {
    logDryRunSummary({
      ui,
      plan,
      prompt,
      sectionCount: sections.length,
      outputPath: output.outputPath,
      defaultOutputDir: output.defaultOutputDir,
      usedDefaultOutputPath: output.usedDefaultOutputPath,
    });
    return;
  }

  if (plan.requiresApiKey && !plan.apiKeyLookup?.apiKey) {
    throw new Error(
      `Missing API key for provider "${plan.provider}". Set ${plan.apiKeyLookup!.envVar} in your environment.`,
    );
  }

  logger.info(
    `Generating flashcards in ${sections.length} section${sections.length === 1 ? "" : "s"}.`,
  );

  const cards = await generateAllCards({
    sections,
    plan,
    promptContents: prompt.contents,
    ui,
    deckTitle,
    outputPath: output.outputPath,
    artifactBaseName: output.artifactBaseName,
    dryRun,
  });

  await writeGeneratedDeck({
    ui,
    targetKind,
    deck: buildDeck(deckTitle, cards),
    deckTitle,
    inputPath,
    sourceLabel: structured.fileType.toUpperCase(),
    output,
    prompt,
    dryRun,
  });
}

async function executeWorkflow(
  options: Readonly<{
    sourceKind: WorkflowSourceKind;
    targetKind: WorkflowTargetKind;
    args: WorkflowCommandArgs;
    previewFlagMode: PreviewFlagMode;
    ui: CliUi;
  }>,
): Promise<void> {
  const { sourceKind, targetKind, args, previewFlagMode, ui } = options;
  const settings = await loadCliSettings(ui);
  const inputPath = normalizeRequiredInputPath(args.input);
  const output = resolveOutputPlan(args, settings, targetKind, inputPath);
  const dryRun = toBool(args.dryRun, false);
  const fullFidelity = toBool(args.fullFidelity, false);

  if (sourceKind === "md") {
    return runMarkdownToAnki({
      ui,
      inputPath,
      output,
      deckTitleArg: normalizePathArg(args.deckTitle),
      dryRun,
      remoteMedia: toBool(args.remoteMedia, false),
      remoteTimeoutMs:
        normalizeIntegerOption(args.remoteTimeout, "--remote-timeout", 1) ?? DEFAULT_TIMEOUT_MS,
    });
  }

  const source = readSourceOptions(args);
  const structured = await loadStructuredSource({
    sourceKind,
    inputPath,
    ui,
    settings: {
      ...settings,
      epub: {
        ...settings.epub,
        preview: resolvePreview(previewFlagMode, source.previewChars, settings.epub.preview),
        previewChars: source.previewChars ?? settings.epub.previewChars,
      },
    },
    source,
    debug: toBool(args.debug, false),
    fullFidelity: targetKind === "json" && fullFidelity,
  });

  if (targetKind === "json") {
    return writeExtractedJson({ ui, inputPath, output, structured, source, fullFidelity, dryRun });
  }

  return runGenerationWorkflow({
    ui,
    targetKind,
    args,
    settings,
    inputPath,
    output,
    structured,
    dryRun,
  });
}

export async function runWorkflowCommand(
  sourceKind: WorkflowSourceKind,
  targetKind: WorkflowTargetKind,
  args: WorkflowCommandArgs,
  /* Handed in rather than read here. `normalizePreviewCliArgs` rewrites argv
     before yargs sees it, so the original argv is the only record of whether
     `--preview` was typed at all - and the entry point is the only place that
     still holds it. */
  previewFlagMode: PreviewFlagMode,
): Promise<void> {
  let ui: CliUi | null = null;

  try {
    ui = buildCliUi(args);
    await executeWorkflow({ sourceKind, targetKind, args, previewFlagMode, ui });
  } catch (error) {
    ui?.spinner.stop();
    ui?.progress.clear();
    reportingLogger(ui).error(`Conversion failed: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
