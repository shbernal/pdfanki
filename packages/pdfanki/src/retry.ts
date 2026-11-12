/**
 * Retry for provider calls whose SDK has no usable retry of its own.
 *
 * The Anthropic and OpenAI SDKs retry through `maxRetries`, so this is for
 * Gemini: `@google/genai` has `retryOptions`, but it neither honours a
 * server-given delay nor says that it is retrying.
 */

import { describeError } from "./describeError.js";

const TOO_MANY_REQUESTS = 429;
const INTERNAL_SERVER_ERROR = 500;
const BAD_GATEWAY = 502;
const SERVICE_UNAVAILABLE = 503;
const GATEWAY_TIMEOUT = 504;

/** Statuses that say "try again later", not "this request is wrong". */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([
  TOO_MANY_REQUESTS,
  INTERNAL_SERVER_ERROR,
  BAD_GATEWAY,
  SERVICE_UNAVAILABLE,
  GATEWAY_TIMEOUT,
]);

/** Node and undici codes for a connection that reset, dropped or timed out. */
const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export const DEFAULT_RETRY_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 2000;
const DEFAULT_MAX_DELAY_MS = 30_000;
/** A server asking for longer than this is not worth waiting on inline. */
const MAX_RETRY_AFTER_MS = 120_000;
const MS_PER_SECOND = 1000;
const MAX_CAUSE_DEPTH = 5;
const MAX_REASON_CHARS = 60;

export interface RetryOptions {
  /** Shown in the log line, e.g. "Gemini". */
  readonly label: string;
  /** Total tries, the first one included. */
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Seams for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly log?: (line: string) => void;
}

/** One property of a value a provider SDK threw and nothing types. */
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const found: unknown = Reflect.get(value, key);
  return found;
}

/** The error, then its `cause` chain. */
function* errorChain(error: unknown): Generator {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth++) {
    yield current;
    current = field(current, "cause");
  }
}

function statusOf(error: unknown): number | undefined {
  for (const item of errorChain(error)) {
    const status = field(item, "status");
    if (typeof status === "number") {
      return status;
    }
  }
  return undefined;
}

function isNetworkError(error: unknown): boolean {
  for (const item of errorChain(error)) {
    const code = field(item, "code");
    if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) {
      return true;
    }
    const name = field(item, "name");
    if (name === "AbortError" || name === "TimeoutError") {
      return true;
    }
  }
  return false;
}

/**
 * Whether trying the same request again could succeed. An HTTP status decides
 * when there is one, so a 400 or 401 is never retried.
 */
export function isTransientError(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) {
    return TRANSIENT_STATUSES.has(status);
  }
  return isNetworkError(error);
}

function parseRetryAfterHeader(value: string): number | undefined {
  const seconds = Number(value);
  if (value.trim() !== "" && Number.isFinite(seconds)) {
    return Math.max(0, seconds * MS_PER_SECOND);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function headerValue(error: unknown, name: string): string | undefined {
  const headers = field(error, "headers");
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const value = field(headers, name);
  return typeof value === "string" ? value : undefined;
}

/**
 * How long the server asked us to wait: a `Retry-After` header when the error
 * carries one, else the `retryDelay` of a Google `RetryInfo` in the body, which
 * is where Gemini puts it (its SDK error keeps the body as the message).
 */
export function retryAfterMs(error: unknown): number | undefined {
  const header = headerValue(error, "retry-after");
  if (header !== undefined) {
    return parseRetryAfterHeader(header);
  }
  const message = field(error, "message");
  if (typeof message === "string") {
    const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
    if (match?.[1] !== undefined) {
      return Number(match[1]) * MS_PER_SECOND;
    }
  }
  return undefined;
}

function shortReason(error: unknown): string {
  const status = statusOf(error);
  if (status !== undefined) {
    return String(status);
  }
  for (const item of errorChain(error)) {
    const code = field(item, "code");
    if (typeof code === "string") {
      return code;
    }
  }
  return describeError(error).slice(0, MAX_REASON_CHARS);
}

/** Run `call`, retrying transient failures with exponential backoff and jitter. */
export async function withRetry<T>(call: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_RETRY_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const random = options.random ?? Math.random;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  for (let attempt = 1; ; attempt++) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each try waits on the previous one
      return await call();
    } catch (error) {
      if (attempt >= attempts || !isTransientError(error)) {
        throw error;
      }
      const serverDelay = retryAfterMs(error);
      if (serverDelay !== undefined && serverDelay > MAX_RETRY_AFTER_MS) {
        throw error;
      }
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      // Half fixed, half random: spreads clients out without ever retrying at once.
      const delay = serverDelay ?? Math.round(backoff / 2 + (random() * backoff) / 2);
      log(
        `${options.label}: ${shortReason(error)}, retrying in ${(delay / MS_PER_SECOND).toFixed(1)}s (attempt ${attempt + 1}/${attempts})`,
      );
      // oxlint-disable-next-line no-await-in-loop -- backoff between tries
      await sleep(delay);
    }
  }
}
