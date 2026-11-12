import { callCodexProvider, type CodexReasoningEffort } from "./codexProvider.js";
import { describeError } from "./describeError.js";
import { isList } from "./isList.js";
import { DEFAULT_RETRY_ATTEMPTS, withRetry } from "./retry.js";
import type { ReadonlyBookJson } from "./types/flashcards.js";

export type SupportedProvider =
  | "gemini"
  | "anthropic"
  | "openai"
  | "deepseek"
  | "openrouter"
  | "codex";

export interface GenerateFlashcardsOptions {
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

const GEMINI_TIMEOUT_MS = 180_000;
const MS_PER_SECOND = 1000;
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** The Anthropic and OpenAI SDKs count retries, not tries; same budget as Gemini. */
const SDK_MAX_RETRIES = DEFAULT_RETRY_ATTEMPTS - 1;

/**
 * The Anthropic and OpenAI SDKs retry on their own (429, 5xx, connection errors,
 * honouring `Retry-After`) and announce each retry at `info`, in a line carrying
 * request ids and the URL. Shorten those to one line on stderr, drop the rest of
 * `info`, and keep `warn`/`error` where the SDK's default logger sends them.
 */
export function retryLogger(label: string, write = (line: string) => process.stderr.write(line)) {
  return {
    error: (...args: readonly unknown[]): void => {
      console.error(...args);
    },
    warn: (...args: readonly unknown[]): void => {
      console.warn(...args);
    },
    debug: (): void => undefined,
    info: (message: string): void => {
      const remaining = /retrying, (\d+) attempts? remaining/.exec(message);
      if (!remaining) {
        return;
      }
      const reason =
        /with status (\d+)/.exec(message)?.[1] ??
        /connection (timed out|failed)/.exec(message)?.[0] ??
        "error";
      write(`${label}: ${reason}, retrying (${remaining[1]} left)\n`);
    },
  };
}

export function bookJsonToPlainText(book: ReadonlyBookJson): string {
  const parts: string[] = [];

  for (const section of book.content) {
    const sectionHeader = section.title
      ? `${section.index}. ${section.title}`
      : `Section ${section.index}`;
    parts.push([sectionHeader, section.text ?? ""].filter(Boolean).join("\n"));
  }

  return parts.join("\n\n").trim();
}

export async function generateFlashcards(options: GenerateFlashcardsOptions): Promise<string> {
  const { provider } = options;
  if (provider !== "codex" && !options.apiKey) {
    throw new Error(`Missing API key for provider "${provider}".`);
  }

  switch (provider) {
    case "gemini": {
      return callGemini(options);
    }
    case "anthropic": {
      return callAnthropic(options);
    }
    case "openai": {
      return callOpenAI(options);
    }
    case "deepseek": {
      return callDeepSeek(options);
    }
    case "openrouter": {
      return callOpenRouter(options);
    }
    case "codex": {
      return callCodex(options);
    }
    default: {
      throw new Error(`Unsupported provider "${String(provider)}".`);
    }
  }
}

async function callGemini(options: GenerateFlashcardsOptions): Promise<string> {
  const { prompt, content, apiKey, model } = options;
  try {
    const { GoogleGenAI } = await import("@google/genai");
    const client = new GoogleGenAI({
      ...(apiKey === undefined ? {} : { apiKey }),
      httpOptions: { timeout: GEMINI_TIMEOUT_MS },
    });
    const response = await withRetry(
      () =>
        client.models.generateContent({
          model,
          contents: `${prompt}\n\n${content}`,
        }),
      { label: "Gemini" },
    );
    const { text } = response;
    if (!text || typeof text !== "string") {
      throw new Error("Gemini returned no text content.");
    }
    return text.trim();
  } catch (error) {
    if (isTimeoutError(error)) {
      throw Object.assign(
        new Error(
          `Gemini request timed out after ${Math.round(GEMINI_TIMEOUT_MS / MS_PER_SECOND)}s.`,
        ),
        { cause: error },
      );
    }

    throw Object.assign(new Error(`Gemini request failed: ${describeError(error)}`), {
      cause: error,
    });
  }
}

async function callAnthropic(options: GenerateFlashcardsOptions): Promise<string> {
  const { prompt, content, apiKey, model } = options;
  const { Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    apiKey,
    maxRetries: SDK_MAX_RETRIES,
    logLevel: "info",
    logger: retryLogger("Anthropic"),
  });
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `${prompt}\n\n${content}`,
      },
    ],
  });

  const firstTextBlock = response.content.find((block) => block.type === "text") as
    | { type: string; text?: string }
    | undefined;

  if (!firstTextBlock?.text) {
    throw new Error("Anthropic returned no text content.");
  }

  return firstTextBlock.text.trim();
}

async function callOpenAI(options: GenerateFlashcardsOptions): Promise<string> {
  return callOpenAICompatible({
    ...options,
    providerName: "OpenAI",
  });
}

async function callDeepSeek(options: GenerateFlashcardsOptions): Promise<string> {
  return callOpenAICompatible({
    ...options,
    providerName: "DeepSeek",
    baseURL: process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL,
  });
}

async function callOpenRouter(options: GenerateFlashcardsOptions): Promise<string> {
  return callOpenAICompatible({
    ...options,
    providerName: "OpenRouter",
    baseURL: process.env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL,
    defaultHeaders: {
      ...(process.env.OPENROUTER_HTTP_REFERER
        ? { "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER }
        : {}),
      ...(process.env.OPENROUTER_TITLE
        ? { "X-OpenRouter-Title": process.env.OPENROUTER_TITLE }
        : {}),
    },
  });
}

async function callCodex(options: GenerateFlashcardsOptions): Promise<string> {
  return callCodexProvider({
    prompt: options.prompt,
    content: options.content,
    model: options.model,
    ...(options.codex?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: options.codex.reasoningEffort }),
    ...(options.codex?.profile === undefined ? {} : { profile: options.codex.profile }),
  });
}

type OpenAICompatibleOptions = GenerateFlashcardsOptions & {
  readonly providerName: string;
  readonly baseURL?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
};

async function callOpenAICompatible(options: OpenAICompatibleOptions): Promise<string> {
  const { prompt, content, apiKey, model } = options;
  const { providerName, baseURL, defaultHeaders } = options;
  if (!apiKey) {
    throw new Error(`Missing API key for provider "${options.provider}".`);
  }
  const openaiModule = await import("openai");
  const OpenAI = openaiModule.default;
  const client = new OpenAI({
    apiKey,
    maxRetries: SDK_MAX_RETRIES,
    logLevel: "info",
    logger: retryLogger(providerName),
    ...(baseURL ? { baseURL } : {}),
    ...(defaultHeaders ? { defaultHeaders } : {}),
  });
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content },
    ],
    temperature: 0.3,
  });

  const text = extractOpenAICompatibleText(response);
  if (!text) {
    throw new Error(`${providerName} returned no text content.`);
  }

  return text.trim();
}

interface OpenAICompatibleResponse {
  readonly choices?: readonly {
    readonly message?: {
      // the OpenAI SDK types `content` as nullable; `extractOpenAICompatibleText`
      // already falls through to `null` for anything that is not a string or array
      readonly content?:
        | string
        | readonly {
            readonly type?: string;
            readonly text?: string;
          }[]
        | null;
    };
  }[];
}

function extractOpenAICompatibleText(payload: OpenAICompatibleResponse): string | null {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }

  if (!isList(content)) {
    return null;
  }

  const text = content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");

  return text.length > 0 ? text : null;
}

function readErrorField(source: Readonly<object>, key: "message" | "name" | "code"): unknown {
  if (key === "message") {
    return "message" in source ? source.message : undefined;
  }

  if (key === "name") {
    return "name" in source ? source.name : undefined;
  }

  return "code" in source ? source.code : undefined;
}

/** Read one string field off a value a provider SDK threw and nothing types. */
function errorField(error: unknown, key: "message" | "name" | "code"): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const value = readErrorField(error, key);
  if (typeof value === "string") {
    return value;
  }

  return typeof value === "number" ? String(value) : undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const message = errorField(error, "message")?.toLowerCase();
  if (errorField(error, "name") === "AbortError") {
    return true;
  }
  if (message?.includes("timeout")) {
    return true;
  }

  const cause: unknown = "cause" in error ? error.cause : undefined;
  const causeMessage = errorField(cause, "message")?.toLowerCase();
  const causeCode = errorField(cause, "code");
  if (errorField(cause, "name") === "AbortError") {
    return true;
  }
  if (causeMessage?.includes("timeout")) {
    return true;
  }
  if (causeCode?.toLowerCase().includes("timeout")) {
    return true;
  }

  return false;
}
