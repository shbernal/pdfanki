import { promises as fs } from "node:fs";
import { dirname, join, parse } from "node:path";

import { normalizePathArg, toKebabAlnum } from "./args.js";
import { describeError } from "./errors.js";
import {
  buildCliUi,
  reportingLogger,
  runWithSpinner,
  type CliUi,
  type UiBuildArgs,
} from "./ui/cliUi.js";

/** The blank index a user edits to tell a PDF conversion where its chapters are. */

export interface IndexTemplateEntry {
  readonly start: number;
  readonly end: number;
  readonly title?: string;
}

/** How many pages a placeholder section spans, so the template is editable. */
const TEMPLATE_PAGES_PER_SECTION = 2;

export function buildIndexTemplate(count: number): IndexTemplateEntry[] {
  const items: IndexTemplateEntry[] = [];
  for (let position = 1; position <= count; position++) {
    const start = (position - 1) * TEMPLATE_PAGES_PER_SECTION + 1;
    const end = start + TEMPLATE_PAGES_PER_SECTION - 1;
    items.push({ start, end, title: `Section ${position}` });
  }

  return items;
}

export function formatIndexTemplate(entries: readonly IndexTemplateEntry[]): string {
  if (entries.length === 0) {
    return "[]\n";
  }

  const lines = entries.map((entry) => {
    const parts = [`"start": ${entry.start}`, `"end": ${entry.end}`];
    if (entry.title?.trim()) {
      parts.push(`"title": ${JSON.stringify(entry.title)}`);
    }
    return `  { ${parts.join(", ")} }`;
  });

  return `[\n${lines.join(",\n")}\n]\n`;
}

export function resolveIndexTemplatePath(
  target: string | undefined,
  fromFilePath: string | undefined,
): string {
  const defaultBaseName = fromFilePath
    ? `${toKebabAlnum(parse(fromFilePath).name || "index")}.index`
    : "index";
  if (!target) {
    return join(process.cwd(), `${defaultBaseName}.json`);
  }

  const parsed = parse(target);
  if (!parsed.ext) {
    return join(target, "index.json");
  }

  if (parsed.ext.toLowerCase() !== ".json") {
    throw new Error("Index template output must end with .json");
  }

  return target;
}

export async function handleIndexTemplate(
  args: UiBuildArgs & {
    readonly count?: unknown;
    readonly out?: unknown;
    readonly fromFile?: unknown;
  },
): Promise<void> {
  let ui: CliUi | null = null;
  try {
    ui = buildCliUi(args);
    const count: unknown = args.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
      throw new Error("Provide a positive integer for <count> when creating an index template.");
    }

    const fromFilePath = normalizePathArg(args.fromFile);
    const outputPath = resolveIndexTemplatePath(normalizePathArg(args.out), fromFilePath);

    await runWithSpinner(ui.spinner, "Creating index template...", async () => {
      const payload = formatIndexTemplate(buildIndexTemplate(count));
      await fs.mkdir(dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, payload, "utf8");
    });

    ui.logger.success(`Created index template with ${count} section(s) at ${outputPath}`);
    ui.logger.info(
      'Use --index <path> with PDF conversions, or --index-ranges "<start-end,...>" for quick inline ranges.',
    );
  } catch (error) {
    ui?.spinner.stop();
    reportingLogger(ui).error(`Failed to create index template: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
