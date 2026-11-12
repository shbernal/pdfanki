import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { retryLogger } from "../dist/providers.js";
import { isTransientError, retryAfterMs, withRetry } from "../dist/retry.js";
import { generateFlashcards } from "../dist/server.js";

const apiError = (status, message = "{}") => Object.assign(new Error(message), { status });

/** A client whose call fails with each error in turn, then answers. */
function fakeClient(failures, answer = "cards") {
  const queue = [...failures];
  const client = {
    calls: 0,
    generate: async () => {
      client.calls++;
      const next = queue.shift();
      if (next) {
        throw next;
      }
      return answer;
    },
  };
  return client;
}

function harness(extra = {}) {
  const delays = [];
  const lines = [];
  return {
    delays,
    lines,
    options: {
      label: "Fake",
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
      log: (line) => lines.push(line),
      ...extra,
    },
  };
}

test("withRetry retries transient failures, then returns the answer", async () => {
  const client = fakeClient([apiError(503), apiError(504), apiError(429)]);
  const { delays, lines, options } = harness();

  assert.equal(await withRetry(client.generate, options), "cards");
  assert.equal(client.calls, 4);
  // 2s, 4s, 8s backoff, each 3/4 of the way with random() = 0.5
  assert.deepEqual(delays, [1500, 3000, 6000]);
  assert.deepEqual(lines, [
    "Fake: 503, retrying in 1.5s (attempt 2/5)",
    "Fake: 504, retrying in 3.0s (attempt 3/5)",
    "Fake: 429, retrying in 6.0s (attempt 4/5)",
  ]);
});

test("withRetry gives up after the attempt limit and throws the last error", async () => {
  const last = apiError(503, "still busy");
  const client = fakeClient([apiError(503), apiError(503), last]);
  const { lines, options } = harness({ attempts: 3 });

  await assert.rejects(() => withRetry(client.generate, options), last);
  assert.equal(client.calls, 3);
  assert.equal(lines.length, 2);
});

test("withRetry does not retry a 400 or a 401", async () => {
  for (const status of [400, 401, 403, 404]) {
    const client = fakeClient([apiError(status)]);
    const { lines, options } = harness();

    await assert.rejects(() => withRetry(client.generate, options), { status });
    assert.equal(client.calls, 1, String(status));
    assert.deepEqual(lines, []);
  }
});

test("withRetry retries a connection reset found in the cause chain", async () => {
  const reset = new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  });
  const client = fakeClient([reset]);
  const { lines, options } = harness();

  assert.equal(await withRetry(client.generate, options), "cards");
  assert.equal(client.calls, 2);
  assert.match(lines[0], /^Fake: ECONNRESET, retrying/);
});

test("withRetry waits as long as the server asks", async () => {
  const headers = new Headers({ "retry-after": "7" });
  const client = fakeClient([Object.assign(apiError(429), { headers })]);
  const { delays, options } = harness();

  await withRetry(client.generate, options);
  assert.deepEqual(delays, [7000]);
});

test("retryAfterMs reads Gemini's RetryInfo from the error body", () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" }],
    },
  });
  assert.equal(retryAfterMs(apiError(429, body)), 12_000);
  assert.equal(retryAfterMs(apiError(503)), undefined);
});

test("isTransientError lets a status decide before any network code", () => {
  assert.equal(isTransientError(apiError(500)), true);
  assert.equal(isTransientError(apiError(401)), false);
  assert.equal(isTransientError(new Error("bad input")), false);
  const badRequestOverReset = Object.assign(apiError(400), { code: "ECONNRESET" });
  assert.equal(isTransientError(badRequestOverReset), false);
});

test("retryLogger turns an SDK retry line into one short line and drops other info", () => {
  const written = [];
  const logger = retryLogger("Anthropic", (line) => written.push(line));
  logger.info(
    "[log_abc, retryOf: log_xyz] POST https://api.anthropic.com/v1/messages failed with status 529 in 80ms - retrying, 3 attempts remaining",
  );
  logger.info("[log_abc] connection timed out - retrying, 1 attempts remaining");
  logger.info("[log_abc] POST https://api.anthropic.com/v1/messages succeeded with status 200");
  assert.deepEqual(written, [
    "Anthropic: 529, retrying (3 left)\n",
    "Anthropic: connection timed out, retrying (1 left)\n",
  ]);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serve each response in turn from `fetch`, counting requests. */
function fakeFetch(responses) {
  const queue = [...responses];
  const state = { requests: 0 };
  globalThis.fetch = async () => {
    state.requests++;
    return queue.shift()();
  };
  return state;
}

const json =
  (status, body, headers = {}) =>
  () =>
    Response.json(body, { status, headers });

// A server delay of 0 (Gemini) or 1ms (the SDKs ignore 0) keeps backoff out of the test.
const geminiBusy = json(503, {
  error: {
    code: 503,
    message: "high demand",
    details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0s" }],
  },
});
const sdkBusy = json(503, { error: { message: "busy" } }, { "retry-after-ms": "1" });

const request = (provider) => ({
  provider,
  model: "test-model",
  apiKey: "test-key",
  prompt: "p",
  content: "c",
});

test("generateFlashcards retries a busy Gemini and returns its answer", async (ctx) => {
  ctx.mock.method(process.stderr, "write", () => true);
  const state = fakeFetch([
    geminiBusy,
    geminiBusy,
    json(200, { candidates: [{ content: { role: "model", parts: [{ text: "Q: a\nA: b" }] } }] }),
  ]);

  assert.equal(await generateFlashcards(request("gemini")), "Q: a\nA: b");
  assert.equal(state.requests, 3);
});

test("generateFlashcards does not retry a Gemini 401", async () => {
  const state = fakeFetch([json(401, { error: { code: 401, message: "bad key" } })]);

  await assert.rejects(() => generateFlashcards(request("gemini")), /Gemini request failed/);
  assert.equal(state.requests, 1);
});

test("generateFlashcards lets the Anthropic SDK retry a busy response", async (ctx) => {
  ctx.mock.method(process.stderr, "write", () => true);
  const state = fakeFetch([
    sdkBusy,
    json(200, {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "Q: a\nA: b" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  ]);

  assert.equal(await generateFlashcards(request("anthropic")), "Q: a\nA: b");
  assert.equal(state.requests, 2);
});

test("generateFlashcards lets the OpenAI SDK retry a busy DeepSeek", async (ctx) => {
  ctx.mock.method(process.stderr, "write", () => true);
  const state = fakeFetch([
    sdkBusy,
    json(200, {
      id: "c1",
      object: "chat.completion",
      created: 0,
      model: "test-model",
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "Q: a\nA: b" } },
      ],
    }),
  ]);

  assert.equal(await generateFlashcards(request("deepseek")), "Q: a\nA: b");
  assert.equal(state.requests, 2);
});

test("generateFlashcards does not let the SDKs retry a 400", async () => {
  for (const provider of ["anthropic", "deepseek"]) {
    const state = fakeFetch([json(400, { error: { message: "bad request" } })]);

    await assert.rejects(() => generateFlashcards(request(provider)));
    assert.equal(state.requests, 1, provider);
  }
});
